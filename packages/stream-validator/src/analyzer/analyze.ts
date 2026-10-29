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
 *   - **A BUFFER island materializes its whole subtree.** A string island
 *     is bounded by `maxLength` or its `enum` / `const` candidates; an
 *     object or array island only by `maxBufferedBytes`, since whitespace
 *     inside it is unlimited.
 *   - **A cycle through a TEE repeats its branch peaks** at every level,
 *     so a buffering subtree reached again under a deeper TEE is
 *     **unbounded**.
 *
 * Sizes are upper bounds on the materialized **UTF-8 source span** of an
 * accepted input. JSON allows any amount of whitespace inside a container
 * and any length of number spelling (`1.000...0e0`), so a materialized
 * container has no finite span of its own; only `maxBufferedBytes` bounds
 * it. A number materialized on its own is held as a token, which
 * `maxNumberBytes` bounds, and contributes nothing here. A branch of
 * `anyOf`, `oneOf`, `not` or a conditional can fail while the engine still
 * buffers for it, so its own keywords do not bound its size; only a string
 * `enum` / `const` candidate, which the engine enforces itself, still does.
 * Token accumulators, completed-name sets, captures, edit retention and
 * queues are outside this model. A finite bound does not establish bounded
 * validation memory.
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
import { longestStringCandidate } from "../scalar-equality.js";
import { tokenByteLimit } from "../tokenizer/limits.js";

// --- Byte model (UTF-8 wire bytes; explicit, documented assumptions) ---

/**
 * Most source bytes one code point (the unit of `maxLength`) can take in a
 * JSON string: a supplementary character written as an escaped surrogate
 * pair, `\uD83D\uDE00`.
 */
const BYTES_PER_CODE_POINT = 12;
/**
 * Most source bytes one UTF-16 code unit (the unit of a string `enum` /
 * `const` candidate's length) can take: an escape, `\u0061`.
 */
const BYTES_PER_CODE_UNIT = 6;
/** The two `"` delimiters around a JSON string. */
const QUOTE_BYTES = 2;
/** `false`, the longer of the two booleans. */
const BOOL_BYTES = 5;
/** `null`. */
const NULL_BYTES = 4;
/**
 * The cap a materialized container needs: whitespace inside it is
 * unlimited, so `maxBufferedBytes` is the only bound on its span.
 */
const CONTAINER_BOUND = "maxBufferedBytes";

/** An upper bound on a materialized wire-byte size, or `"unbounded"`. */
export type ByteSize = number | "unbounded";

/**
 * Classification of an entire schema's streaming behavior.
 *
 *   - `streamable`: validates forward without materializing subtrees.
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
  /** Upper bound on materialized wire bytes, or `"unbounded"`. */
  maxBytes: ByteSize;
  /**
   * When `maxBytes` is `"unbounded"`, the first missing bound: a schema
   * keyword (`maxItems`, `maxLength`, ...), or `maxBufferedBytes` where
   * only the cap can bound the span (a container, whose whitespace is
   * unlimited, or a branch an accepted input may fail).
   */
  unboundedBy?: string;
}

/**
 * Materialization classification, peak bounds and their positions.
 * See {@link analyzeStreamability}. Excludes tokenizer/name storage, captures,
 * edit retention and queues; a finite value is not a memory guarantee. A
 * stream with edit hooks adds the input it retains for them to
 * `StreamVerdict.peakBufferedBytes`, which can then exceed these bounds.
 *
 * @public
 */
export interface StreamabilityReport {
  /** Overall verdict for the whole schema. */
  classification: StreamClass;
  /** Schema-intrinsic materialization bound in wire bytes, or `"unbounded"`. */
  peakBytes: ByteSize;
  /**
   * Materialization bound after applying `maxBufferedBytes` per region:
   * each region contributes the smaller of its intrinsic bound and the cap.
   * `maxKeyBytes` and `maxNumberBytes` do not change this bound.
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

/**
 * Most wire bytes an input equal to a `const` / `enum` candidate can take.
 * Equality is by value, so any spelling of the value matches: a string can
 * escape every code unit, and a container has no longest spelling. A
 * number is a token (see {@link sizeOfType}).
 */
function literalSize(value: unknown): Sized {
  if (typeof value === "string") return { size: value.length * BYTES_PER_CODE_UNIT + QUOTE_BYTES };
  if (typeof value === "boolean") return { size: value ? 4 : BOOL_BYTES };
  if (value === null) return { size: NULL_BYTES };
  if (typeof value === "number") return { size: 0 };
  return UNBOUNDED(CONTAINER_BOUND);
}

// --- Contribution tree: the shape of the peak computation, kept separate
// from rollup so the intrinsic and capped peaks share one walk. ---

type Contribution =
  | { kind: "zero" }
  | {
      kind: "island";
      path: string;
      keyword: string;
      intrinsic: ByteSize;
      unboundedBy?: string;
      // A cycle through a TEE, whose sum over levels no per-region cap bounds.
      uncapped?: true;
    }
  | { kind: "max"; parts: Contribution[] }
  // Sum child contributions without reporting a position of its own.
  | { kind: "parallel"; parts: Contribution[] }
  | { kind: "sum"; path: string; keyword: string; parts: Contribution[] };

/** Collapse a contribution to a size; `capIsland` maps each island's intrinsic size. */
function rollup(c: Contribution, capIsland: (s: ByteSize) => ByteSize): ByteSize {
  switch (c.kind) {
    case "zero":
      return 0;
    case "island":
      return c.uncapped === true ? "unbounded" : capIsland(c.intrinsic);
    case "max":
      return c.parts.reduce<ByteSize>((acc, p) => maxSize(acc, rollup(p, capIsland)), 0);
    case "parallel":
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
    case "parallel":
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
      return { size: node.maxLength * BYTES_PER_CODE_POINT + QUOTE_BYTES };
    }
    // The spine checks a number materialized on its own from its token,
    // which `maxNumberBytes` bounds; inside a container, the container's
    // span is unbounded already.
    case "integer":
    case "number":
      return { size: 0 };
    case "boolean":
      return { size: BOOL_BYTES };
    case "null":
      return { size: NULL_BYTES };
    case "array": {
      if (typeof node.maxItems !== "number") return UNBOUNDED("maxItems");
      return containerSize(materialize(arrayItemSchema(node), root, seen));
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
  for (const sub of Object.values(properties ?? {})) {
    const valueSize = materialize(sub as SchemaOrBoolean, root, seen);
    if (valueSize.size === "unbounded") return containerSize(valueSize);
  }
  return UNBOUNDED(CONTAINER_BOUND);
}

// A structurally bounded container still has unlimited whitespace, so its
// span is unbounded. Report a missing schema bound inside it first, as the
// more specific fix.
function containerSize(member: Sized): Sized {
  return member.size === "unbounded" ? member : UNBOUNDED(CONTAINER_BOUND);
}

/** Max wire bytes of a value matching `node`, or unbounded with the missing keyword. */
function materialize(node: SchemaOrBoolean, root: SchemaObject, seen: Set<SchemaObject>): Sized {
  if (node === true) return UNBOUNDED("type"); // any value
  if (node === false || !isObjectSchema(node)) return { size: 0 }; // matches nothing
  if (seen.has(node)) return UNBOUNDED("$ref"); // recursive: unbounded depth
  const next = new Set(seen).add(node);

  if (node.const !== undefined) return literalSize(node.const);
  if (Array.isArray(node.enum)) {
    return node.enum.reduce<Sized>((m, v) => maxSized(m, literalSize(v)), { size: 0 });
  }

  const types = typeList(node);
  // A type union admits the largest of its members.
  let result: Sized = UNBOUNDED("type");
  if (types !== undefined) {
    result = { size: 0 };
    for (const t of types) result = maxSized(result, sizeOfType(node, t, root, next));
  }

  // Both references apply to the same value, so each target tightens the
  // bound. `$dynamicRef` resolves statically, as the spine resolves it.
  for (const ref of [node.$ref, node.$dynamicRef]) {
    if (typeof ref !== "string") continue;
    const target = resolveRefLocal(root, ref);
    if (target !== undefined) result = minSized(result, materialize(target, root, next));
  }

  // Composition tightens (allOf) or widens (anyOf/oneOf) the bound.
  for (const branch of compositionArray(node, "allOf")) {
    result = minSized(result, materialize(branch, root, next));
  }
  const widen = [...compositionArray(node, "anyOf"), ...compositionArray(node, "oneOf")];
  if (widen.length > 0) {
    let w: Sized = { size: 0 };
    for (const branch of widen) w = maxSized(w, materialize(branch, root, next));
    result = minSized(result, w);
  }
  return result;
}

// Both apply to the same value, so the smaller wins. Between two unbounded
// sizes, one that only the cap can bound means the other's missing schema
// keyword is supplied elsewhere, so the cap is what remains to report.
function minSized(a: Sized, b: Sized): Sized {
  if (a.size === "unbounded" && b.size === "unbounded") {
    return b.unboundedBy === CONTAINER_BOUND ? b : a;
  }
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
  if (Object.hasOwn(node, "const")) return complex(node.const);
  return Array.isArray(node.enum) && node.enum.some(complex);
}

// The runtime buffer/tee/stream decision, mirroring the spine's
// `computeKind` (spine.ts): the classifier's strategy, plus the triggers
// the spine materializes on its own account where the classifier reports
// a forward strategy (asserting `format` is one). `computeKind` is the
// list; relying on the classifier's `strategyOf` alone would miss those
// and under-report buffering.
//
// Exported for `test/analyzer-spine-drift.test.ts`, which pins the
// agreement with the spine. Not re-exported from the package entry
// points: the analyzer stays engine-free, and this is not public API.
export function nodeKind(
  node: SchemaObject,
  cls: Classification,
  formatAsserts: boolean,
): "stream" | "tee" | "buffer" {
  // Presence, not definedness: the in-memory engine dispatches keywords
  // over `Object.keys`, so `{ contains: undefined }` is a present
  // keyword to it and to the spine. Testing `!== undefined` here read it
  // as absent and under-reported the buffer budget. `Object.hasOwn`
  // rather than `in` so an inherited property is not read as a keyword.
  if (cls.strategyOf(node) === "buffer") return "buffer";
  if (Object.hasOwn(node, "contains")) return "buffer";
  if (Object.hasOwn(node, "dependentSchemas") || Object.hasOwn(node, "discriminator")) {
    return "buffer";
  }
  if (formatAsserts && Object.hasOwn(node, "format")) return "buffer";
  if (node.uniqueItems === true) return "buffer";
  if (hasComplexValueEquality(node)) return "buffer";
  if (cls.strategyOf(node) === "tee") return "tee";
  return "stream";
}

// Best-effort name of the keyword that forced a BUFFER verdict, for the report.
function bufferKeyword(node: SchemaObject, formatAsserts: boolean): string {
  // Own-property presence throughout, matching nodeKind: reporting a
  // different keyword than the one that forced the verdict is worse than
  // reporting the generic fallback.
  if (node.uniqueItems === true) return "uniqueItems";
  if (Object.hasOwn(node, "dependentSchemas")) return "dependentSchemas";
  if (Object.hasOwn(node, "discriminator")) return "discriminator";
  if (hasComplexValueEquality(node)) return Object.hasOwn(node, "const") ? "const" : "enum";
  if (Object.hasOwn(node, "contains")) return "contains";
  const deps = (node as Record<string, unknown>).dependencies;
  if (isObjectSchema(deps) && Object.values(deps).some((e) => !Array.isArray(e))) {
    return "dependencies";
  }
  for (const k of COMPOSITION_KEYS) if (Object.hasOwn(node, k)) return k;
  if (Object.hasOwn(node, "pattern")) return "pattern";
  if (formatAsserts && Object.hasOwn(node, "format")) return "format";
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
  // A member schema that can apply to the same key as others: a
  // `properties` entry or a `patternProperties` entry.
  named?: boolean;
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
// time (peak across them is a max), except that one key can match a
// `properties` entry and any number of `patternProperties` entries at once.
function streamMembers(node: SchemaObject): Child[] {
  const out: Child[] = [];
  if (isObjectSchema(node.properties)) {
    for (const [k, s] of Object.entries(node.properties))
      out.push({ node: s, rel: k, named: true });
  }
  const patternProps = (node as Record<string, unknown>).patternProperties;
  if (isObjectSchema(patternProps)) {
    for (const [k, s] of Object.entries(patternProps)) {
      out.push({ node: s as SchemaOrBoolean, rel: `(${k})`, named: true });
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

// An island whose own bounds an accepted input need not satisfy.
const UNBOUNDED_ISLAND = { intrinsic: "unbounded", unboundedBy: CONTAINER_BOUND } as const;

// A forced-buffer scalar island for a string the spine holds: for `pattern`
// the whole string (to test the regex), bounded by the effective
// `maxLength` when `binding`; for scalar `enum` / `const` without a `pattern`, at most the
// longest string candidate, past which the spine stops holding it. Null
// when neither applies, including an `enum` with no string candidate.
function forcedScalarIsland(
  node: SchemaObject,
  path: string,
  max: number | undefined,
  binding: boolean,
): Contribution | null {
  if (node.pattern === undefined) {
    if (!("enum" in node) && !("const" in node)) return null;
    const longest = longestStringCandidate([node]);
    if (longest < 0) return null;
    const keyword = "enum" in node ? "enum" : "const";
    return {
      kind: "island",
      path,
      keyword,
      intrinsic: longest * BYTES_PER_CODE_UNIT + QUOTE_BYTES,
    };
  }
  if (!binding) {
    return { kind: "island", path, keyword: "pattern", ...UNBOUNDED_ISLAND };
  }
  return max === undefined
    ? { kind: "island", path, keyword: "pattern", intrinsic: "unbounded", unboundedBy: "maxLength" }
    : {
        kind: "island",
        path,
        keyword: "pattern",
        intrinsic: max * BYTES_PER_CODE_POINT + QUOTE_BYTES,
      };
}

/**
 * The schemas applying to the same value: `node` and, recursively, the
 * targets of its `$ref` and `$dynamicRef`. This mirrors the spine's
 * `expand` (spine.ts) in order and in multiplicity: the cycle guard holds
 * reference targets only, so a reference cycle back to `node` collects
 * it a second time, and the spine then runs each copy's obligations
 * (a tee among them) concurrently. Collapsing the copies would
 * under-report that buffering. `$dynamicRef` resolves statically, as the
 * spine resolves it; resource-scoped rebinding is a separate stream
 * limitation.
 */
function refSchemas(node: SchemaObject, root: SchemaObject): SchemaObject[] {
  const out: SchemaObject[] = [];
  const expand = (s: SchemaObject, seen?: Set<SchemaObject>): void => {
    out.push(s);
    let guard = seen;
    for (const ref of [s.$ref, s.$dynamicRef]) {
      if (typeof ref !== "string") continue;
      const target = resolveRefLocal(root, ref);
      if (!isObjectSchema(target) || guard?.has(target)) continue;
      guard ??= new Set<SchemaObject>();
      guard.add(target);
      expand(target, guard);
    }
  };
  expand(node);
  return out;
}

// Whether any schema reachable from `node` buffers: a BUFFER node or a
// string the spine holds for `pattern`, `enum` or `const`.
function buffersAnywhere(
  node: SchemaObject,
  root: SchemaObject,
  cls: Classification,
  formatAsserts: boolean,
): boolean {
  const visited = new Set<SchemaObject>();
  const visit = (n: SchemaOrBoolean): boolean => {
    if (!isObjectSchema(n)) return false;
    for (const s of refSchemas(n, root)) {
      if (visited.has(s)) continue;
      visited.add(s);
      if (nodeKind(s, cls, formatAsserts) === "buffer") return true;
      if (forcedScalarIsland(s, "", undefined, true) !== null) return true;
      for (const c of [...streamMembers(s), ...teeBranches(s)]) if (visit(c.node)) return true;
    }
    return false;
  };
  return visit(node);
}

// `binding` is whether an accepted input must satisfy `node`. A branch of
// `anyOf`, `oneOf`, `not` or a conditional can fail while the spine still
// buffers for it, so its own `maxLength`, `type` or `maxItems` bounds
// nothing; only a limit the spine enforces itself (the longest string
// `enum` / `const` candidate) still holds there.
//
// `seen` maps each schema on the current walk path to the number of TEEs
// above it when first entered; `tees` is that number here. Meeting a
// schema again under no further TEE holds nothing the first visit did not
// count. Under a further TEE, each level's sub-spine keeps its own peak and
// the TEE sums them, so a buffering schema there grows with depth.
function walk(
  node: SchemaOrBoolean,
  path: string,
  root: SchemaObject,
  cls: Classification,
  seen: Map<SchemaObject, number>,
  formatAsserts: boolean,
  binding: boolean,
  tees: number,
): Contribution {
  if (!isObjectSchema(node)) return { kind: "zero" };
  const applicable = refSchemas(node, root);
  const buffering = applicable.find((s) => nodeKind(s, cls, formatAsserts) === "buffer");
  let maxLength: number | undefined;
  for (const s of applicable) {
    const bound = effectiveMaxLength(s);
    if (bound !== undefined)
      maxLength = maxLength === undefined ? bound : Math.min(maxLength, bound);
  }

  if (buffering !== undefined) {
    if (seen.has(node)) {
      return { kind: "island", path, keyword: "$ref", intrinsic: "unbounded", unboundedBy: "$ref" };
    }
    if (!binding) {
      return {
        kind: "island",
        path,
        keyword: bufferKeyword(buffering, formatAsserts),
        ...UNBOUNDED_ISLAND,
      };
    }
    // A type and a string bound can live on different hops of the chain.
    // Other structural intersections retain conservative allOf sizing.
    const type = applicable.find((s) => s.type !== undefined)?.type;
    const sized = materialize(
      {
        allOf: applicable,
        ...(type === undefined ? {} : { type }),
        ...(maxLength === undefined ? {} : { maxLength }),
      },
      root,
      new Set(),
    );
    return {
      kind: "island",
      path,
      keyword: bufferKeyword(buffering, formatAsserts),
      intrinsic: sized.size,
      ...(sized.unboundedBy === undefined ? {} : { unboundedBy: sized.unboundedBy }),
    };
  }

  const repeat = (s: SchemaObject): Contribution => {
    const first = seen.get(s) as number;
    if (tees <= first || !buffersAnywhere(s, root, cls, formatAsserts)) return { kind: "zero" };
    return {
      kind: "island",
      path,
      keyword: "$ref",
      intrinsic: "unbounded",
      unboundedBy: "$ref",
      uncapped: true,
    };
  };
  if (seen.has(node)) return repeat(node);
  const next = new Map(seen);
  for (const s of applicable) if (!next.has(s)) next.set(s, tees);
  const tee = applicable.find((s) => nodeKind(s, cls, formatAsserts) === "tee");
  // Every child of a TEE node runs in a sub-spine beside the others.
  const below = tee === undefined ? tees : tees + 1;
  const parts: Contribution[] = [];
  for (const s of applicable) {
    if (seen.has(s)) {
      parts.push(repeat(s));
      continue;
    }
    const own: Contribution[] = [];
    const scalar = forcedScalarIsland(s, path, maxLength, binding);
    if (scalar !== null) own.push(scalar);
    const properties: Contribution[] = [];
    const patterns: Contribution[] = [];
    for (const m of streamMembers(s)) {
      const at = joinPath(path, m.rel);
      const c = walk(m.node, at, root, cls, next, formatAsserts, binding, below);
      if (m.named !== true) own.push(c);
      else if (m.rel.startsWith("(")) patterns.push(c);
      else properties.push(c);
    }
    // A key matches at most one property name but any number of patterns,
    // and the spine runs every matching member schema's obligations.
    if (properties.length > 0 || patterns.length > 0) {
      own.push({ kind: "parallel", parts: [{ kind: "max", parts: properties }, ...patterns] });
    }
    parts.push({ kind: "max", parts: own });
    for (const b of teeBranches(s)) {
      const required = binding && b.rel.startsWith("allOf.");
      const at = joinPath(path, b.rel);
      parts.push(walk(b.node, at, root, cls, next, formatAsserts, required, below));
    }
  }
  // Ref obligations can overlap at a member that tees. Summing their
  // separate contributions is conservative even when a single forward
  // spine would share storage or visit their members sequentially.
  return tee === undefined
    ? { kind: applicable.length > 1 ? "parallel" : "max", parts }
    : { kind: "sum", path, keyword: teeKeyword(tee), parts };
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
 * affect classification; `enforceBounds` escalates the classifier's
 * unbounded warnings, below). An unstreamable schema throws
 * {@link ClassifierError}, the same error `createStreamValidator` raises.
 * Token policies (`maxKeyBytes` / `maxNumberBytes`) are validated using the
 * runtime's option rules and leave materialization bounds unchanged.
 *
 * Static `$ref` and `$dynamicRef` targets and their siblings all contribute;
 * `$dynamicRef` resolves statically, as the stream engine resolves it. Bounds split
 * across a reference chain can remain conservatively unbounded when their
 * structural intersection is not modeled. Separate ref obligations are
 * summed conservatively because overlapping members can tee concurrently.
 * This also affects direct schema analysis: separate ref obligations on
 * sequential object members can receive a higher budget even when forward
 * validation shares storage. It applies to schemas beyond operation bodies.
 *
 * Wire-byte figures are upper bounds over every accepted spelling, so any
 * materialized container is `"unbounded"` (see the module overview). An
 * `"unbounded"` position is the headline output: a buffering position with
 * no bound of its own, which falls back to `maxBufferedBytes` at runtime.
 * Reporting these is the default; pass
 * `enforceBounds: true` to instead throw {@link ClassifierError} on the
 * classifier's unbounded-string and unbounded-uniqueItems warnings, the
 * design-time equivalent of refusing to construct an unsafe validator
 * (the same bound `createStreamValidator` enforces). Positions the
 * analyzer itself reports as `"unbounded"` do not throw.
 *
 * @public
 */
export function analyzeStreamability(
  schema: SchemaOrBoolean,
  options: StreamValidatorOptions = {},
): StreamabilityReport {
  tokenByteLimit("maxKeyBytes", options.maxKeyBytes);
  tokenByteLimit("maxNumberBytes", options.maxNumberBytes);
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
  const tree = walk(normalized, "", normalized, cls, new Map(), formatAsserts, true, 0);

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
