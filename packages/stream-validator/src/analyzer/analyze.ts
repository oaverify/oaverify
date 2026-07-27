/**
 * Streamability analyzer: a static, design-time view of where a schema
 * forces the streaming engine to buffer, and how much.
 *
 * The engine's classifier ({@link classify}) already assigns every
 * subschema a strategy (STREAM / TEE / BUFFER); the engine itself buffers
 * at most one materialized island at a time (the spine's single
 * `this.island` slot). This module reads that classification and walks the
 * schema to roll the per-position verdicts into a peak-buffer budget:
 *
 *   - **Sequential positions buffer one at a time** (array items, object
 *     properties open / materialize / release before the next), so peak
 *     across siblings is a **max**, not a sum.
 *   - **A TEE fans events to one sub-spine per branch concurrently**, so
 *     within a TEE the peak is the **sum** over branches.
 *   - **A BUFFER island materializes its whole subtree**, bounded by that
 *     subtree's structural bounds (`maxLength` / `maxItems` / `const` /
 *     `enum`, and a closed object's properties); **unbounded** if any
 *     required bound is missing. An open object (`additionalProperties` not
 *     `false`) is unbounded regardless of `maxProperties`, which the byte
 *     model does not yet read.
 *
 * Sizes are an upper bound in **UTF-8 wire bytes** (the same unit
 * `maxBufferedBytes` caps), computed from the byte model below. They are
 * an estimate, not a guaranteed ceiling: a value with heavy JSON escaping
 * (`\uXXXX`) can exceed the per-character assumption. The number is the
 * design-time capacity-planning figure, not a runtime meter.
 *
 * An unstreamable schema (a REJECT keyword such as `unevaluatedProperties`,
 * an unknown keyword, or an unresolvable `$ref`) throws
 * {@link ClassifierError}, the same failure `createStreamValidator` raises
 * at construction.
 *
 * @packageDocumentation
 */

import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import {
  type Dialect,
  FORMAT_ASSERTION_VOCAB,
  jsonSchemaDialect,
  openapi31Dialect,
} from "@oaverify/internal-schema";
import { classify, type Classification } from "../classifier/index.js";
import { normalizeOas30 } from "../openapi/index.js";
import type { StreamValidatorOptions } from "../options.js";
import { resolveRef as resolveRefLocal } from "../ref-resolve.js";

// --- Byte model (UTF-8 wire bytes; explicit, documented assumptions) ---

/**
 * Upper-bound bytes per `maxLength` unit for a string. UTF-8 encodes a
 * BMP code unit in at most 3 bytes; the extra headroom covers light JSON
 * escaping. Heavy escaping (`\uXXXX` on control characters) can exceed it,
 * so a string size is an estimate, not a hard ceiling.
 */
const BYTES_PER_CHAR = 4;
/** The two `"` delimiters around a JSON string. */
const QUOTE_BYTES = 2;
/** Widest JSON number modeled (sign, digits, exponent). */
const NUMBER_BYTES = 24;
/** `"false"`, the longer of the two booleans. */
const BOOL_BYTES = 5;
/** `"null"`. */
const NULL_BYTES = 4;
/** One structural byte token: a comma, colon, or bracket. */
const PUNCT_BYTES = 1;

/** A wire-byte size: a finite upper bound, or `"unbounded"`. */
export type ByteSize = number | "unbounded";

/**
 * Classification of an entire schema's streaming behavior.
 *
 *   - `streamable`: validates forward with no buffering (multi-GB safe).
 *   - `tee`: forward composition fans events to concurrent sub-spines; no
 *     materialization, but peak is the sum over branches.
 *   - `buffer`: at least one position materializes a subtree (an island).
 *
 * @public
 */
export type StreamClass = "streamable" | "tee" | "buffer";

/**
 * One position that buffers or tees, the punch list a deployer tightens.
 *
 * @public
 */
export interface BufferPosition {
  /** JSON path to the position; `""` is the root. */
  path: string;
  /** Whether the position materializes (`buffer`) or fans out (`tee`). */
  classification: "buffer" | "tee";
  /** The keyword forcing it (`contains`, `uniqueItems`, `oneOf`, `format`, ...). */
  keyword: string;
  /** Max wire bytes this position can hold, or `"unbounded"`. */
  maxBytes: ByteSize;
  /** When `maxBytes` is `"unbounded"`, the missing bound (`maxItems`, `maxLength`, ...). */
  unboundedBy?: string;
}

/**
 * The peak-buffer budget for a schema. See {@link analyzeStreamability}.
 *
 * @public
 */
export interface StreamabilityReport {
  /** Overall verdict for the whole schema. */
  classification: StreamClass;
  /** Schema-intrinsic peak buffer, in wire bytes. `"unbounded"` if any buffering position has no structural bound. */
  peakBytes: ByteSize;
  /**
   * Peak buffer a successful validation reaches under the configured caps
   * (`maxBufferedBytes`): an island larger than the cap fails at runtime,
   * so the most a passing stream buffers is `min(intrinsic, cap)`. Equal to
   * {@link peakBytes} when no cap is set (and then `"unbounded"` if the
   * intrinsic peak is).
   */
  effectivePeakBytes: ByteSize;
  /** Every buffering / teeing position, in walk order. Empty iff `streamable`. */
  positions: readonly BufferPosition[];
}

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

function joinPath(base: string, rel: string): string {
  if (rel === "") return base;
  if (base === "") return rel;
  // An array-index segment (`[]`, `[0]`) reads better with no separating dot.
  return rel.startsWith("[") ? `${base}${rel}` : `${base}.${rel}`;
}

function addSize(a: ByteSize, b: ByteSize): ByteSize {
  return a === "unbounded" || b === "unbounded" ? "unbounded" : a + b;
}
function maxSize(a: ByteSize, b: ByteSize): ByteSize {
  return a === "unbounded" || b === "unbounded" ? "unbounded" : Math.max(a, b);
}

/** Wire bytes of a concrete JSON value (for `const` / `enum` candidates). */
function literalBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

// --- Contribution tree: the shape of the peak computation, kept separate
// from rollup so the intrinsic and capped peaks share one walk. ---

type Contribution =
  | { kind: "zero" }
  | { kind: "island"; path: string; keyword: string; intrinsic: ByteSize; unboundedBy?: string }
  | { kind: "max"; parts: Contribution[] }
  | { kind: "sum"; path: string; keyword: string; parts: Contribution[] };

/** Collapse a contribution to a size; `capIsland` maps each island's intrinsic size. */
function rollup(c: Contribution, capIsland: (s: ByteSize) => ByteSize): ByteSize {
  switch (c.kind) {
    case "zero":
      return 0;
    case "island":
      return capIsland(c.intrinsic);
    case "max":
      return c.parts.reduce<ByteSize>((acc, p) => maxSize(acc, rollup(p, capIsland)), 0);
    case "sum":
      return c.parts.reduce<ByteSize>((acc, p) => addSize(acc, rollup(p, capIsland)), 0);
  }
}

/** Extract the reported positions (islands and tees) from a contribution tree. */
function collectPositions(c: Contribution, out: BufferPosition[]): void {
  switch (c.kind) {
    case "zero":
      return;
    case "island":
      out.push({
        path: c.path,
        classification: "buffer",
        keyword: c.keyword,
        maxBytes: c.intrinsic,
        ...(c.unboundedBy === undefined ? {} : { unboundedBy: c.unboundedBy }),
      });
      return;
    case "max":
      for (const p of c.parts) collectPositions(p, out);
      return;
    case "sum": {
      // Roll the tee's own intrinsic size from its branches.
      const intrinsic = rollup(c, (s) => s);
      out.push({ path: c.path, classification: "tee", keyword: c.keyword, maxBytes: intrinsic });
      for (const p of c.parts) collectPositions(p, out);
      return;
    }
  }
}

// --- Materialized-island sizing: the max wire size of a value matching a
// subtree, bounded by its structural keywords. ---

interface Sized {
  size: ByteSize;
  unboundedBy?: string;
}

const UNBOUNDED = (by: string): Sized => ({ size: "unbounded", unboundedBy: by });

function typeList(node: SchemaObject): string[] | undefined {
  const t = node.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t as string[];
  return undefined;
}

function sizeOfType(
  node: SchemaObject,
  type: string,
  root: SchemaObject,
  seen: Set<SchemaObject>,
): Sized {
  switch (type) {
    case "string": {
      if (typeof node.maxLength !== "number") return UNBOUNDED("maxLength");
      return { size: node.maxLength * BYTES_PER_CHAR + QUOTE_BYTES };
    }
    case "integer":
    case "number":
      return { size: NUMBER_BYTES };
    case "boolean":
      return { size: BOOL_BYTES };
    case "null":
      return { size: NULL_BYTES };
    case "array": {
      if (typeof node.maxItems !== "number") return UNBOUNDED("maxItems");
      const item = arrayItemSchema(node);
      const itemSize = materialize(item, root, seen);
      if (itemSize.size === "unbounded") return itemSize;
      // brackets + maxItems items + (maxItems-1) commas.
      const size = 2 * PUNCT_BYTES + node.maxItems * (itemSize.size + PUNCT_BYTES);
      return { size };
    }
    case "object":
      return sizeOfObject(node, root, seen);
    default:
      return UNBOUNDED("type");
  }
}

// Largest value an array element can take: max over prefixItems and the
// general items/additionalItems schema.
function arrayItemSchema(node: SchemaObject): SchemaOrBoolean {
  const branches: SchemaOrBoolean[] = [];
  const prefix = (node as Record<string, unknown>).prefixItems;
  if (Array.isArray(prefix)) branches.push(...(prefix as SchemaOrBoolean[]));
  if (node.items !== undefined) branches.push(node.items as SchemaOrBoolean);
  const additional = (node as Record<string, unknown>).additionalItems;
  if (additional !== undefined) branches.push(additional as SchemaOrBoolean);
  if (branches.length === 0) return true; // no item constraint: any value
  if (branches.length === 1) return branches[0] as SchemaOrBoolean;
  return { anyOf: branches } as SchemaObject; // size = max over branches
}

function sizeOfObject(node: SchemaObject, root: SchemaObject, seen: Set<SchemaObject>): Sized {
  const properties = isObjectSchema(node.properties) ? node.properties : undefined;
  const additionalClosed =
    node.additionalProperties === false &&
    (node as Record<string, unknown>).patternProperties === undefined;
  // An open object (additionalProperties not false) can hold arbitrary
  // extra members; without a propertyNames/maxProperties bound on count and
  // key size, its size is unbounded.
  if (!additionalClosed) return UNBOUNDED("additionalProperties");
  let total: ByteSize = 2 * PUNCT_BYTES; // braces
  if (properties === undefined) return { size: total };
  for (const [key, sub] of Object.entries(properties)) {
    const valueSize = materialize(sub as SchemaOrBoolean, root, seen);
    if (valueSize.size === "unbounded") return valueSize;
    const keyBytes = Buffer.byteLength(key, "utf8") + QUOTE_BYTES + PUNCT_BYTES; // "key":
    total = addSize(total, keyBytes + valueSize.size + PUNCT_BYTES); // member + comma
  }
  return { size: total };
}

/** Max wire bytes of a value matching `node`, or unbounded with the missing keyword. */
function materialize(node: SchemaOrBoolean, root: SchemaObject, seen: Set<SchemaObject>): Sized {
  if (node === true) return UNBOUNDED("type"); // any value
  if (node === false || !isObjectSchema(node)) return { size: 0 }; // matches nothing
  if (seen.has(node)) return UNBOUNDED("$ref"); // recursive: unbounded depth
  const next = new Set(seen).add(node);

  if (typeof node.$ref === "string") {
    const target = resolveRefLocal(root, node.$ref);
    if (target === undefined) return UNBOUNDED("$ref");
    return materialize(target, root, next);
  }

  if (node.const !== undefined) return { size: literalBytes(node.const) };
  if (Array.isArray(node.enum)) {
    return { size: node.enum.reduce<number>((m, v) => Math.max(m, literalBytes(v)), 0) };
  }

  const types = typeList(node);
  // A type union admits the largest of its members.
  let result: Sized = UNBOUNDED("type");
  if (types !== undefined) {
    result = { size: 0 };
    for (const t of types) result = maxSized(result, sizeOfType(node, t, root, next));
  }

  // Composition tightens (allOf) or widens (anyOf/oneOf) the bound.
  for (const branch of compositionArray(node, "allOf")) {
    const s = materialize(branch, root, next);
    if (s.size !== "unbounded") result = minSized(result, s);
  }
  const widen = [...compositionArray(node, "anyOf"), ...compositionArray(node, "oneOf")];
  if (widen.length > 0) {
    let w: Sized = { size: 0 };
    for (const branch of widen) w = maxSized(w, materialize(branch, root, next));
    result = minSized(result, w);
  }
  return result;
}

function minSized(a: Sized, b: Sized): Sized {
  if (a.size === "unbounded") return b;
  if (b.size === "unbounded") return a;
  return a.size <= b.size ? a : b;
}
function maxSized(a: Sized, b: Sized): Sized {
  if (a.size === "unbounded") return a;
  if (b.size === "unbounded") return b;
  return a.size >= b.size ? a : b;
}

function compositionArray(node: SchemaObject, key: "allOf" | "anyOf" | "oneOf"): SchemaOrBoolean[] {
  const arr = (node as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr as SchemaOrBoolean[]) : [];
}

// --- Strategy walk: build the contribution tree from the classification. ---

const COMPOSITION_KEYS = ["allOf", "anyOf", "oneOf", "not", "if"] as const;

function hasComplexValueEquality(node: SchemaObject): boolean {
  const complex = (v: unknown): boolean => typeof v === "object" && v !== null;
  if (node.const !== undefined) return complex(node.const);
  return Array.isArray(node.enum) && node.enum.some(complex);
}

// The runtime buffer/tee/stream decision, mirroring the spine's
// `computeKind` (spine.ts): the classifier's strategy, plus the triggers
// the classifier marks `scalar`/forward but the spine still materializes
// (`contains`, asserting `format`, `uniqueItems`, complex `enum`/`const`).
// Relying on the classifier's `strategyOf` alone would miss these and
// under-report buffering.
function nodeKind(
  node: SchemaObject,
  cls: Classification,
  formatAsserts: boolean,
): "stream" | "tee" | "buffer" {
  if (cls.strategyOf(node) === "buffer") return "buffer";
  if (node.contains !== undefined) return "buffer";
  if (
    (node as Record<string, unknown>).dependentSchemas !== undefined ||
    (node as Record<string, unknown>).discriminator !== undefined
  ) {
    return "buffer";
  }
  if (formatAsserts && node.format !== undefined) return "buffer";
  if (node.uniqueItems === true) return "buffer";
  if (hasComplexValueEquality(node)) return "buffer";
  if (cls.strategyOf(node) === "tee") return "tee";
  return "stream";
}

// Best-effort name of the keyword that forced a BUFFER verdict, for the report.
function bufferKeyword(node: SchemaObject, formatAsserts: boolean): string {
  if (node.uniqueItems === true) return "uniqueItems";
  if ((node as Record<string, unknown>).dependentSchemas !== undefined) return "dependentSchemas";
  if ((node as Record<string, unknown>).discriminator !== undefined) return "discriminator";
  if (hasComplexValueEquality(node)) return node.const !== undefined ? "const" : "enum";
  if (node.contains !== undefined) return "contains";
  const deps = (node as Record<string, unknown>).dependencies;
  if (isObjectSchema(deps) && Object.values(deps).some((e) => !Array.isArray(e))) {
    return "dependencies";
  }
  for (const k of COMPOSITION_KEYS)
    if ((node as Record<string, unknown>)[k] !== undefined) return k;
  if (node.pattern !== undefined) return "pattern";
  if (node.format !== undefined && formatAsserts) return "format";
  return "buffer";
}

function teeKeyword(node: SchemaObject): string {
  for (const k of COMPOSITION_KEYS)
    if ((node as Record<string, unknown>)[k] !== undefined) return k;
  return "composition";
}

interface Child {
  node: SchemaOrBoolean;
  rel: string;
}

// Composition branches of a TEE node, which run as concurrent sub-spines.
// A branch index uses a dotted segment (`oneOf.0`), not a bracketed one, so
// schema navigation (composition branches) reads distinctly from instance
// navigation (array items `[]` / tuple indices `[0]`) and the two never
// collide visually (`oneOf.0[]`, not `oneOf[0][]`).
function teeBranches(node: SchemaObject): Child[] {
  const out: Child[] = [];
  for (const k of ["allOf", "anyOf", "oneOf"] as const) {
    const arr = (node as Record<string, unknown>)[k];
    if (Array.isArray(arr)) {
      (arr as SchemaOrBoolean[]).forEach((s, i) => out.push({ node: s, rel: `${k}.${i}` }));
    }
  }
  if (node.not !== undefined) out.push({ node: node.not as SchemaOrBoolean, rel: "not" });
  for (const k of ["if", "then", "else"] as const) {
    const s = (node as Record<string, unknown>)[k];
    if (s !== undefined) out.push({ node: s as SchemaOrBoolean, rel: k });
  }
  return out;
}

// Per-member / per-item children of a STREAM node, which buffer one at a
// time (peak across them is a max).
function streamMembers(node: SchemaObject): Child[] {
  const out: Child[] = [];
  if (isObjectSchema(node.properties)) {
    for (const [k, s] of Object.entries(node.properties)) out.push({ node: s, rel: k });
  }
  const patternProps = (node as Record<string, unknown>).patternProperties;
  if (isObjectSchema(patternProps)) {
    for (const [k, s] of Object.entries(patternProps)) {
      out.push({ node: s as SchemaOrBoolean, rel: `(${k})` });
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    out.push({ node: node.additionalProperties as SchemaOrBoolean, rel: "*" });
  }
  if (node.items !== undefined) out.push({ node: node.items as SchemaOrBoolean, rel: "[]" });
  const prefix = (node as Record<string, unknown>).prefixItems;
  if (Array.isArray(prefix)) {
    (prefix as SchemaOrBoolean[]).forEach((s, i) => out.push({ node: s, rel: `[${i}]` }));
  }
  if (node.contains !== undefined)
    out.push({ node: node.contains as SchemaOrBoolean, rel: "contains" });
  return out;
}

// The tightest `maxLength` that bounds a string: the node's own, intersected
// with any `allOf` branch's (a sibling `allOf: [{ maxLength }]` bounds the
// same string the node's `pattern` buffers). Undefined when none applies.
function effectiveMaxLength(node: SchemaObject): number | undefined {
  let m = typeof node.maxLength === "number" ? node.maxLength : undefined;
  for (const branch of compositionArray(node, "allOf")) {
    if (isObjectSchema(branch) && typeof branch.maxLength === "number") {
      m = m === undefined ? branch.maxLength : Math.min(m, branch.maxLength);
    }
  }
  return m;
}

// A forced-buffer scalar island for a `pattern` string (the spine buffers the
// whole string to test the regex), bounded by the effective `maxLength`, or
// null when the node carries no `pattern`.
function forcedScalarIsland(node: SchemaObject, path: string): Contribution | null {
  if (node.pattern === undefined) return null;
  const max = effectiveMaxLength(node);
  return max === undefined
    ? { kind: "island", path, keyword: "pattern", intrinsic: "unbounded", unboundedBy: "maxLength" }
    : { kind: "island", path, keyword: "pattern", intrinsic: max * BYTES_PER_CHAR + QUOTE_BYTES };
}

function walk(
  node: SchemaOrBoolean,
  path: string,
  root: SchemaObject,
  cls: Classification,
  seen: Set<SchemaObject>,
  formatAsserts: boolean,
): Contribution {
  if (!isObjectSchema(node)) return { kind: "zero" };
  const strat = nodeKind(node, cls, formatAsserts);

  if (strat === "buffer") {
    if (seen.has(node)) {
      return { kind: "island", path, keyword: "$ref", intrinsic: "unbounded", unboundedBy: "$ref" };
    }
    const sized = materialize(node, root, new Set());
    return {
      kind: "island",
      path,
      keyword: bufferKeyword(node, formatAsserts),
      intrinsic: sized.size,
      ...(sized.unboundedBy === undefined ? {} : { unboundedBy: sized.unboundedBy }),
    };
  }

  if (seen.has(node)) return { kind: "zero" }; // recursive STREAM/TEE: counted at first visit
  const next = new Set(seen).add(node);

  // Follow a bare `$ref` so the referenced subtree's member islands are sized.
  if (typeof node.$ref === "string") {
    const target = resolveRefLocal(root, node.$ref);
    if (!isObjectSchema(target)) return { kind: "zero" };
    return walk(target, path, root, cls, next, formatAsserts);
  }

  // The node's own (non-composition) forward obligation: a forced-buffer
  // scalar (`pattern`, which accumulates the whole string for the regex even
  // on the STREAM path) plus its per-member islands, which buffer one at a
  // time (max). Mirrors the spine's `stripComposition` sub-spine. Asserting
  // `format` / `uniqueItems` / complex `enum`|`const` are BUFFER above;
  // bounded scalar `enum`/`const` buffer a negligible amount and are dropped.
  const ownParts: Contribution[] = [];
  const scalar = forcedScalarIsland(node, path);
  if (scalar !== null) ownParts.push(scalar);
  for (const m of streamMembers(node)) {
    ownParts.push(walk(m.node, joinPath(path, m.rel), root, cls, next, formatAsserts));
  }
  const ownPart: Contribution =
    ownParts.length > 0 ? { kind: "max", parts: ownParts } : { kind: "zero" };

  if (strat === "tee") {
    // The spine fans every event to concurrent sub-spines: the node's own
    // obligation plus one per composition branch. Concurrent islands sum.
    const branchParts = teeBranches(node).map((b) =>
      walk(b.node, joinPath(path, b.rel), root, cls, next, formatAsserts),
    );
    return { kind: "sum", path, keyword: teeKeyword(node), parts: [ownPart, ...branchParts] };
  }

  return ownPart;
}

// --- Public entry point. ---

/**
 * Analyze a resolved schema's streaming behavior: classify it, locate every
 * position that buffers or tees, and roll up a peak-buffer budget in wire
 * bytes (schema-intrinsic and under the configured caps).
 *
 * The options mirror {@link StreamValidatorOptions} so a budget is computed
 * for the same configuration a validator would run under (`openApiVersion`
 * / `dialect` select the keyword set and `format` assertion;
 * `maxBufferedBytes` drives `effectivePeakBytes`; `keywords` / `parity`
 * affect classification; `enforceBounds` makes an unbounded schema throw,
 * below). An unstreamable schema throws {@link ClassifierError}, the same
 * error `createStreamValidator` raises.
 *
 * Wire-byte sizes are an upper-bound estimate (see the module overview),
 * not a guaranteed ceiling. An `"unbounded"` position is the headline
 * output: a buffering position with no structural bound, which falls back
 * to `maxBufferedBytes` at runtime. Reporting these is the default; pass
 * `enforceBounds: true` to instead throw {@link ClassifierError} on the
 * first unbounded dimension, the design-time equivalent of refusing to
 * construct an unsafe validator (the same bound `createStreamValidator`
 * enforces).
 *
 * @public
 */
export function analyzeStreamability(
  schema: SchemaOrBoolean,
  options: StreamValidatorOptions = {},
): StreamabilityReport {
  const normalized = options.openApiVersion === "3.0" ? normalizeOas30(schema) : schema;
  // Resolve the dialect exactly as the engine does, so the classifier reads
  // the same keyword set and `formatAsserts` matches the spine's runtime
  // `format`-buffering decision.
  const dialect: Dialect =
    options.dialect ??
    (options.openApiVersion !== undefined ? openapi31Dialect : jsonSchemaDialect);
  const cls = classify(normalized, {
    dialect,
    ...(options.keywords === undefined ? {} : { customKeywords: Object.keys(options.keywords) }),
    ...(options.parity === undefined ? {} : { parity: options.parity }),
    // Honor enforceBounds so `analyzeStreamability(schema, { enforceBounds: true })`
    // throws on an unbounded schema, the same as `createStreamValidator` would
    // (the design-time equivalent of refusing to construct an unsafe validator).
    ...(options.enforceBounds === undefined ? {} : { enforceBounds: options.enforceBounds }),
  });

  if (!isObjectSchema(normalized)) {
    return { classification: "streamable", peakBytes: 0, effectivePeakBytes: 0, positions: [] };
  }

  const formatAsserts = dialect.vocabularies.some((v) => v.uri === FORMAT_ASSERTION_VOCAB);
  const tree = walk(normalized, "", normalized, cls, new Set(), formatAsserts);

  const positions: BufferPosition[] = [];
  collectPositions(tree, positions);

  const peakBytes = rollup(tree, (s) => s);
  const cap = options.maxBufferedBytes;
  const capIsland = (s: ByteSize): ByteSize =>
    cap === undefined ? s : s === "unbounded" ? cap : Math.min(s, cap);
  const effectivePeakBytes = rollup(tree, capIsland);

  const classification: StreamClass =
    positions.length === 0
      ? "streamable"
      : positions.some((p) => p.classification === "buffer")
        ? "buffer"
        : "tee";

  return { classification, peakBytes, effectivePeakBytes, positions };
}
