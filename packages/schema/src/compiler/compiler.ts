import {
  normalizeFormat,
  type FormatDefinition,
  type PathSegment,
  type SchemaObject,
  type SchemaOrBoolean,
  type ValidationError,
} from "@oaverify/internal-core";
import { CodeGen, NAMES, quoteString } from "../codegen/index.js";
import { buildKeywordMap } from "../introspection.js";
import type {
  CompileMode,
  Dialect,
  DynamicRefTarget,
  FormatKind,
  KeywordDefinition,
} from "../keywords/types.js";
import { createKeywordContext, emitPushStatement } from "../keywords/context.js";
import { createCustomKeywordDefinition, type CustomKeywordValidator } from "../keywords/custom.js";
import {
  assertRefResolver,
  createRefResolver,
  resolve,
  SchemaRegistry,
  type RefResolver,
  type ResolvedGraph,
} from "../resolve/index.js";
import {
  positionFields,
  stepPosition,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
  walkSubschemas,
} from "../subschema-positions.js";
import { createDeps, type RegexCompiler, type ValidatorDeps } from "./runtime.js";
import { computeDiscriminatorRoutes } from "../keywords/discriminator-routes.js";
import { collectEnumTypeIssue } from "./enum-type.js";
import { collectPatternLengthIssue } from "./pattern-length.js";
import { collectRequiredIssues } from "./required-lint.js";
import { assertFormatsRegistered } from "./unknown-formats.js";
import { assertWellFormedSchema, OAS30_REF_SIBLINGS_ALLOWED } from "./well-formed.js";

// Token scan fed into CompileStats.emittedTreeRuntime. Word-boundaried
// so stray mentions inside string literals (e.g. an error message that
// happens to contain "wrapErrors") don't count; every real emission
// spells the helper as a bare identifier.
const TREE_RUNTIME_HELPERS = /\b(?:createLeafError|createBranchError|wrapErrors)\b/;

/**
 * Generated-source identifiers for the dynamic scope: the stack of base
 * URIs of the schema resources currently being evaluated, outermost
 * first, and the lookup that walks it. Both live in the generated
 * closure rather than on `deps`, so the state belongs to one compiled
 * validator. Only emitted when {@link CompileState.dynamicScope} is set.
 */
const DYN_SCOPE = "dynScope";
const DYN_LOOKUP = "dynLookup";

/**
 * Default mode for {@link CompileOptions.schemaLint}. Warns on partially-
 * implemented keywords (no built-in sets this today), on wrong-typed
 * annotation values, and on the `silent-rewrite/*` and `unsatisfiable/*`
 * findings; silent on unknown keys. Callers opt into stricter behavior
 * with `"strict"` or opt out with `"off"`.
 */
const DEFAULT_SCHEMA_LINT_MODE = "warn" as const;

/**
 * Annotation-only keys that don't affect validation. Stripped before
 * structural-equality compares so a "two branches differ only in
 * description" case still surfaces as redundant.
 */
const ANNOTATION_KEYS = new Set([
  "title",
  "description",
  "summary",
  "examples",
  "example",
  "default",
  "deprecated",
  "$comment",
  "$id",
  "$schema",
  "$anchor",
  "$dynamicAnchor",
]);

/** Compose-style keys whose duplicate branches signal silent collapse. */
const COMPOSITION_BRANCH_KEYS = ["oneOf", "anyOf"] as const;

function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    const al = a as unknown[];
    const bl = b as unknown[];
    if (al.length !== bl.length) return false;
    for (let i = 0; i < al.length; i += 1) {
      if (!structuralEqual(al[i], bl[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => !ANNOTATION_KEYS.has(k));
  const bk = Object.keys(bo).filter((k) => !ANNOTATION_KEYS.has(k));
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!structuralEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * "an object" / "an array", "a string" / "a boolean". Generated output
 * is read by people, and the template produced "a object" before the
 * array arm made the seam obvious.
 */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * Does an annotation's value have the declared JSON type?
 *
 * Not a bare `typeof`: that reports `"object"` for `null` and for an
 * array, and an annotation declared as an object means a JSON object.
 */
function isAnnotationValueType(
  value: unknown,
  expected: "string" | "boolean" | "object" | "array",
): boolean {
  if (expected === "array") return Array.isArray(value);
  if (expected !== "object") return typeof value === expected;
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runSchemaLint(
  schema: SchemaOrBoolean,
  byKeyword: Map<string, KeywordDefinition>,
  mode: "warn" | "strict",
  context: string | undefined,
  rules: {
    refSuppressesSiblings: boolean;
    /**
     * A custom `regexCompiler` replaces the runtime's u-mode-with-
     * fallback compile, so the fallback the pattern-not-unicode-mode
     * rule reports can never fire; the rule is suppressed.
     */
    customRegexCompiler: boolean;
    resolveRef?: (ref: string) => unknown;
    pointer?: string;
    anchor?: "node" | "definition";
  },
): SchemaLintIssue[] {
  // The full set of names the active dialect recognizes, including
  // `implements` entries on existing definitions (e.g. `if` implements
  // `then` + `else`; those don't have their own KeywordDefinition but
  // are legitimate keys).
  const known = new Set<string>(byKeyword.keys());
  for (const def of byKeyword.values()) {
    if (def.implements) for (const k of def.implements) known.add(k);
  }

  const issues: SchemaLintIssue[] = [];
  // Ancestor-aware, so it walks the graph itself rather than per-node:
  // the question is what property names are reachable at an instance
  // position, which a per-node visitor cannot see.
  issues.push(...collectRequiredIssues(schema, rules.resolveRef, rules.pointer, rules.anchor));
  // Follow refs, or the rules below see one operation's inline schema
  // plus at most the component named directly as its body: on Asana,
  // 1 of 278 component schemas (#513).
  walkSubschemas(
    schema,
    (node, path, at) => {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const obj = node as Record<string, unknown>;
      // Stamped once per node after the rules have run, the way
      // `context` is stamped once per compile below: every rule here
      // reports at the node being visited, and threading the position
      // through a dozen construction sites invites one of them to
      // forget. The one rule that reports below the node
      // (redundant-composition-branches) sets its own and is skipped.
      const before = issues.length;
      const stamp = (): void => {
        for (let i = before; i < issues.length; i += 1) {
          const issue = issues[i];
          if (issue === undefined) continue;
          if (issue.pointer !== undefined || issue.schemaPath !== undefined) continue;
          issues[i] = { ...issue, ...positionFields(at) };
        }
      };

      for (const key of Object.keys(obj)) {
        const def = byKeyword.get(key);
        if (def?.partial !== undefined) {
          issues.push({
            code: "partial-feature",
            keyword: key,
            path,
            message: `"${key}" is partially supported: ${def.partial}`,
          });
          continue;
        }
        // Reported here rather than in the well-formedness pass because
        // an annotation emits no code: a mistyped one is a document
        // conformance defect, not a schema that would make the validator
        // lie. Blocking construction over it would harden the runtime
        // path for a defect the runtime cannot observe. Runs in "warn"
        // as well as "strict" because the value is never intentional.
        if (
          def?.annotationValueType !== undefined &&
          !isAnnotationValueType(obj[key], def.annotationValueType)
        ) {
          // Not bare `typeof`: it reports "object" for both null and an
          // array, which are exactly the two values an object-typed
          // annotation is most likely to be wrongly given.
          const value = obj[key];
          const got = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
          issues.push({
            code: "annotation-value-type",
            keyword: key,
            path,
            message:
              path.length === 0
                ? `"${key}" at <root> should be ${article(def.annotationValueType)}; got ${got}`
                : `"${key}" at "${path}" should be ${article(def.annotationValueType)}; got ${got}`,
          });
          continue;
        }
        if (mode !== "strict") continue;
        if (known.has(key)) continue;
        // `x-*` extensions are tolerated by OpenAPI convention; accept
        // them in `schemaLint: "strict"` too.
        if (key.startsWith("x-")) continue;
        issues.push({
          code: "unknown-keyword",
          keyword: key,
          path,
          message:
            path.length === 0
              ? `unknown keyword "${key}" at <root>`
              : `unknown keyword "${key}" at "${path}"`,
        });
      }

      // A discriminator that cannot route is reported here rather than
      // from the keyword's compile: the compiler hands `oneOf` / `anyOf`
      // back and carries on (#561), so without this the author would
      // never learn their routing table is unused.
      const branchesForDisc = obj["oneOf"] ?? obj["anyOf"];
      if (obj["discriminator"] !== undefined && Array.isArray(branchesForDisc)) {
        const { deadMappingKeys, usable } = computeDiscriminatorRoutes(
          obj["discriminator"],
          branchesForDisc,
        );
        if (!usable) {
          const reason =
            deadMappingKeys.length > 0
              ? `mapping value(s) ${deadMappingKeys.map((k) => JSON.stringify(k)).join(", ")} name no branch`
              : "no branch carries a $ref to match a mapping value against";
          issues.push({
            code: "silent-rewrite/discriminator-unroutable",
            keyword: "discriminator",
            path,
            message:
              `"discriminator" at ${path.length === 0 ? "<root>" : `"${path}"`} cannot select a branch: ${reason}. ` +
              `The discriminator is ignored and the composition validates every branch instead.`,
          });
        }
      }

      // Always-on alongside silent-rewrite/*: the analysis is a parse of
      // the pattern source, bounded by its length, so it costs nothing a
      // server would notice on its first request.
      const patternIssue = collectPatternLengthIssue(obj, path);
      if (patternIssue !== undefined) issues.push(patternIssue);

      // The runtime compiles each pattern with the "u" flag and falls
      // back to a no-flag compile when that throws (compilePatternRegex
      // in runtime.ts). The fallback is deliberate; what it is not is
      // visible, and it means the validator reads some escapes
      // differently from the u-mode pattern the author wrote. With a
      // custom regexCompiler that path never runs, so nothing is
      // reported.
      if (!rules.customRegexCompiler) {
        for (const issue of collectPatternUnicodeModeIssues(obj, path)) issues.push(issue);
      }

      // Same footing: reading the enum members against the sibling
      // `type` costs one pass over a list the author wrote by hand.
      // `nullable` is honoured only where the dialect defines it, which
      // `known` answers directly rather than by inferring the version.
      const enumIssue = collectEnumTypeIssue(obj, path, known.has("nullable"));
      if (enumIssue !== undefined) issues.push(enumIssue);

      // silent-rewrite/* checks are always-on (any non-"off" mode).
      if (rules.refSuppressesSiblings && typeof obj.$ref === "string") {
        for (const key of Object.keys(obj)) {
          if (OAS30_REF_SIBLINGS_ALLOWED.has(key)) continue;
          // An `x-*` extension loses nothing here. The finding exists to
          // say a constraint the author wrote is not being applied, and
          // an extension is not a constraint: nothing gives it
          // validation semantics, so the compiler ignoring it changes
          // no verdict. It also survives resolution, so `oaverify
          // resolve` still hands it to whatever reads it.
          //
          // 64 of 2846 of these findings on the published-spec corpus
          // were `x-linode-cli-display` and friends, telling authors
          // something was dropped when nothing was. Same low-signal
          // shape #503 pruned.
          //
          // `known` first, and not merely for symmetry with the
          // unknown-keyword rule above. A caller may register a keyword
          // under an `x-`-prefixed name through `keywords`, and that one
          // does carry semantics, which OAS 3.0 then drops beside a
          // `$ref`. Skipping on the prefix alone would suppress the
          // finding exactly where the author most needs it.
          if (!known.has(key) && key.startsWith("x-")) continue;
          issues.push({
            code: "silent-rewrite/ref-siblings-oas30",
            keyword: key,
            path,
            message:
              path.length === 0
                ? `OAS 3.0: "${key}" sibling of $ref at <root> is silently dropped (only description/summary survive)`
                : `OAS 3.0: "${key}" sibling of $ref at "${path}" is silently dropped (only description/summary survive)`,
          });
        }
      }

      for (const key of COMPOSITION_BRANCH_KEYS) {
        const branches = obj[key];
        if (!Array.isArray(branches) || branches.length < 2) continue;
        // O(n^2) pairwise compare; n is small in real specs (oneOf with
        // 2-5 branches is the common shape). For each branch, flag if any
        // earlier branch is structurally equal to it (skip the first
        // occurrence to avoid N findings for N identical branches).
        for (let i = 1; i < branches.length; i += 1) {
          for (let j = 0; j < i; j += 1) {
            if (structuralEqual(branches[i], branches[j])) {
              const branchPath = path.length === 0 ? `${key}[${i}]` : `${path}.${key}[${i}]`;
              issues.push({
                code: "silent-rewrite/redundant-composition-branches",
                keyword: key,
                path: branchPath,
                // The only rule here whose finding sits below the
                // visited node, so it steps the position itself rather
                // than taking the node's.
                ...positionFields(stepPosition(stepPosition(at, key), i)),
                message: `${key}[${i}] is structurally identical to ${key}[${j}] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec`,
              });
              break;
            }
          }
        }
      }

      stamp();
    },
    {
      resolveRef: (ref) => rules.resolveRef?.(ref) as SchemaOrBoolean | undefined,
      pointer: rules.pointer,
      anchor: rules.anchor,
    },
  );
  // Stamped once here rather than at each `issues.push`: the location is
  // the same for every issue this compile produces, and threading it
  // through each construction site invites one of them to forget.
  return context === undefined ? issues : issues.map((issue) => ({ ...issue, location: context }));
}

/**
 * True when `source` compiles only without the `"u"` flag, which is the
 * condition under which the runtime's fallback fires. A source invalid
 * under both modes is not this rule's business: the compile throws its
 * u-mode error, a failure rather than a rewrite.
 */
function uModeFallsBack(source: string): boolean {
  try {
    new RegExp(source, "u");
    return false;
  } catch {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  }
}

/** The pattern-not-unicode-mode rule, over `pattern` and each `patternProperties` key. */
function collectPatternUnicodeModeIssues(
  obj: Record<string, unknown>,
  path: string,
): SchemaLintIssue[] {
  const out: SchemaLintIssue[] = [];
  const where = path.length === 0 ? "<root>" : `"${path}"`;
  const pattern = obj["pattern"];
  if (typeof pattern === "string" && uModeFallsBack(pattern)) {
    out.push({
      code: "silent-rewrite/pattern-not-unicode-mode",
      keyword: "pattern",
      path,
      message:
        `"pattern" at ${where} compiles only without the "u" flag; the validator falls back to ` +
        `non-unicode mode, which reads some escapes differently from the u-mode pattern as written ` +
        `(and "format: regex" rejects this same source as a data value)`,
    });
  }
  const patternProperties = obj["patternProperties"];
  if (
    typeof patternProperties === "object" &&
    patternProperties !== null &&
    !Array.isArray(patternProperties)
  ) {
    for (const key of Object.keys(patternProperties)) {
      if (!uModeFallsBack(key)) continue;
      out.push({
        code: "silent-rewrite/pattern-not-unicode-mode",
        keyword: "patternProperties",
        path,
        message:
          `"patternProperties" key ${JSON.stringify(key)} at ${where} compiles only without the ` +
          `"u" flag; the validator falls back to non-unicode mode, which reads some escapes ` +
          `differently from the u-mode pattern as written`,
      });
    }
  }
  return out;
}

/**
 * Result of a default-mode `validate()` call: a flat list of leaf
 * errors under `errors`. This is the default (`output: "flat"`),
 * shaped to match ajv's zero-config result. Every failing leaf keyword
 * (`type`, `required`, `minimum`, …) is its own record, plus a childless
 * marker leaf for each failed composition keyword (`anyOf` / `oneOf`);
 * no `"schema"` branch wrappers. Each record is a {@link ValidationError}
 * with an empty `children`, so the `@oaverify/core` renderers consume it
 * unchanged. For the nested error tree, compile with `output: "tree"`
 * and see {@link TreeValidationResult}.
 *
 * A discriminated union on `valid`: a successful result carries no error
 * fields; a failing result always carries both `errors` (the flat leaf
 * list, non-empty) and `truncated`. Narrow on `result.valid` to reach
 * the error fields. The narrowing also makes a mistaken `result.error`
 * access (the tree-mode field) a compile error rather than a silent
 * `undefined`.
 *
 * @public
 */
export type ValidationResult =
  | { valid: true }
  | {
      valid: false;
      /** The flat list of leaf errors. Always non-empty when `!valid`. */
      errors: ValidationError[];
      /**
       * `true` when the configured `maxErrors` cap was reached, meaning
       * the list may be incomplete: validation returns as soon as the
       * budget drains, without checking the remaining keywords. With
       * the default `maxErrors: 1`, every failing result therefore
       * reports `truncated: true`. `false` means the cap was never hit
       * and the list is complete. One carve-out: a schema using
       * `unevaluatedProperties` / `unevaluatedItems` disables the
       * budget, so its failing results carry every error with
       * `truncated: false`.
       */
      truncated: boolean;
    };

/**
 * Result of a tree-mode (`output: "tree"`) `validate()` call: a single
 * nested {@link ValidationError} tree under `error`, with `"schema"`
 * branch nodes mirroring the schema's composition structure. The opt-in
 * counterpart to the flat {@link ValidationResult} default. The HTTP
 * validator in `@oaverify/core` compiles in this mode so it can nest
 * per-location subtrees (`body`, `query`, …) under one root.
 *
 * A discriminated union on `valid`: a successful result carries no error
 * fields; a failing result always carries both `error` (the tree root)
 * and `truncated`.
 *
 * @public
 */
export type TreeValidationResult =
  | { valid: true }
  | {
      valid: false;
      /** The root of the nested error tree. Always present when `!valid`. */
      error: ValidationError;
      /**
       * `true` when at least one error was dropped because the configured
       * `maxErrors` cap was hit; `false` when the tree is complete.
       */
      truncated: boolean;
    };

/**
 * Compile-time statistics about the generated validator. Exposed so
 * tests can assert on compiler behavior (e.g. "did subschema inlining
 * fire?") without grepping the generated source.
 *
 * @public
 */
export interface CompileStats {
  /**
   * Number of function names the compiler allocated (`state.nextFn`),
   * not a count of emitted `validate_N` bodies. It includes the
   * `enter_N` dynamic-scope wrappers and names reserved for subschemas
   * that pure-`$ref` elision later collapsed, so it can exceed the
   * number of `validate_N` functions in the generated source. A schema
   * that gets fully inlined allocates one (`validate_0`).
   */
  functionCount: number;
  /**
   * `true` iff the compiler actually emitted `evalProps` / `evalItems`
   * Set machinery anywhere in the generated source. When `false`, the
   * unevaluated-keys-gating optimization is taking effect: the schema
   * doesn't use `unevaluatedProperties` / `unevaluatedItems`, so the
   * compiler suppressed the per-function Set allocation and merge loop.
   * Surfaced so tests can assert on the optimization directly instead
   * of grepping the generated JS.
   */
  unevaluatedTrackingEmitted: boolean;
  /**
   * `true` iff the generated source references any tree-mode runtime
   * helper (`createLeafError`, `createBranchError`, `wrapErrors`). In
   * predicate mode this MUST be `false`: the whole point of the mode
   * is to avoid allocating an error tree. Surfaced so the predicate-
   * mode contract can be asserted without grepping the generated JS.
   */
  emittedTreeRuntime: boolean;
  /**
   * Findings produced by {@link CompileOptions.schemaLint}. Empty when
   * `schemaLint: "off"` is set or the active mode found nothing to
   * flag. Never contains compile-blocking issues; schema lint only
   * reports, and the caller decides whether to treat any entry as
   * fatal.
   */
  schemaLintIssues: readonly SchemaLintIssue[];
}

/**
 * A single finding from schema linting (see
 * {@link CompileOptions.schemaLint}).
 *
 * ## Which field says "where"
 *
 * Four names, four referents:
 *
 * - {@link SchemaLintIssue.pointer}: the **resolved document**, as an
 *   RFC 6901 pointer. Needs {@link CompileOptions.pointer}.
 * - {@link SchemaLintIssue.schemaPath}: a position inside the
 *   **compiled schema**, as segments. Ends at a `$ref` hop.
 * - {@link SchemaLintIssue.path}: the position the finding is
 *   **actionable** at, rendered as a dotted string for a reader. Always
 *   present, and which frame it renders depends on the rule; see the
 *   field.
 * - {@link SchemaLintIssue.location}: text for a **human**, naming what
 *   was being compiled. Never parse it.
 *
 * The first two are the machine addresses, and each is absent rather
 * than re-framed where it cannot answer, so a consumer never has to
 * guess which frame an address is in. `path` answers a different
 * question, which is why it keeps rendering where those two stop.
 *
 * {@link SchemaLintIssue.anchor} is not an address; it says what
 * following `pointer` means for a reader who edits there.
 *
 * @public
 */
export interface SchemaLintIssue {
  /**
   * - `"partial-feature"`: the schema uses a keyword flagged as
   *   partially-implemented. Compile still succeeds; the emitted
   *   validator's semantics for this keyword may not match the spec.
   *   No built-in keyword is flagged today, so this reaches only a
   *   custom keyword that sets `KeywordDefinition.partial`.
   *   `$dynamicRef` was the last built-in to carry it, and dropped it
   *   when runtime dynamic-scope resolution landed.
   * - `"unknown-keyword"`: the schema declares a key that's not in the
   *   active dialect, not an `x-*` extension, and not a standard
   *   `$`-prefixed metadata key. Likely a typo.
   * - `"silent-rewrite/ref-siblings-oas30"`: under OAS 3.0
   *   (`refSuppressesSiblings: true`), a schema with `$ref` plus
   *   sibling keywords other than `description` / `summary`. The
   *   siblings are silently dropped; the validator runs the `$ref`
   *   target only.
   * - `"silent-rewrite/required-not-in-properties"`: a `required`
   *   array names a property no schema reaching that instance position
   *   declares, so the constraint can never be met. Almost always a
   *   typo.
   *
   *   The name is resolved against the *instance* position, not the
   *   enclosing schema: in-place applicators (`allOf`, `then`,
   *   `dependentSchemas`, …) share their parent's instance, and a
   *   child instance collects every schema that reaches it, on either
   *   side of a composition. `$ref` is followed, since an
   *   operation-scoped compile reaches its components no other way.
   *   Flagging is suppressed wherever the reachable names cannot be
   *   enumerated: `additionalProperties` / `patternProperties` /
   *   `unevaluatedProperties`, an unresolvable `$ref`, or a `not`
   *   ancestor (where `required` is a negative constraint).
   * - `"silent-rewrite/redundant-composition-branches"`: a `oneOf` /
   *   `anyOf` array where two or more branches are structurally
   *   identical after compile-time rewrites (notably the validator's
   *   `format: binary` opaque-body bypass). The compiled validator's
   *   semantics differ from the source spec: identical branches
   *   collapse, changing the match-count behavior.
   * - `"annotation-value-type"`: an annotation keyword carries a value
   *   of the wrong type (`description: null` from a YAML key left
   *   empty, `deprecated: "true"`). Annotations emit no code, so the
   *   compiled validator is unaffected and this never blocks
   *   construction; the text the author meant to write is simply
   *   absent from the document.
   * - `"silent-rewrite/discriminator-unroutable"`: a `discriminator`
   *   whose values cannot be matched to the sibling `oneOf` / `anyOf`
   *   branches, either because no branch carries a `$ref` or because a
   *   `mapping` value names none of them. The discriminator is ignored
   *   and the composition validates every branch, which is the verdict
   *   the spec asks for; the routing table the author wrote is not
   *   being used.
   * - `"silent-rewrite/pattern-not-unicode-mode"`: a `pattern` or
   *   `patternProperties` key that `new RegExp(p, "u")` rejects and
   *   `new RegExp(p)` accepts, Annex B identity escapes being the
   *   common case. The runtime deliberately falls back to the no-flag
   *   compile so one legacy pattern does not make the document
   *   unusable, but the compiled validator then reads some escapes
   *   differently from the u-mode pattern as written, and `format:
   *   regex` rejects the same source text as a data value. Suppressed
   *   when a custom `regexCompiler` is supplied, since the fallback
   *   never runs there; a source invalid under both modes is not
   *   reported either, since the compile throws rather than rewriting.
   * - `"unsatisfiable/pattern-length"`: a `pattern` whose match length
   *   cannot overlap the sibling `minLength` / `maxLength` bounds, so
   *   no string validates at that position. Usually a quantifier typo
   *   (`(9)`, a group matching the literal `9`, for `{9}`).
   *
   *   The match length is computed analytically, and the analysis
   *   returns "unknown" for anything it does not model
   *   (backreferences, property escapes, a malformed pattern) rather
   *   than guessing. Reported only where `type` is exactly `"string"`,
   *   since otherwise a non-string instance can still validate and the
   *   position is not dead.
   * - `"unsatisfiable/enum-member-type"`: an `enum` member the sibling
   *   `type` can never admit, so no instance can ever select it.
   *   `type: string` with `enum: [1, 2, 3]` is the shape in the wild.
   *
   *   The claim is about the member rather than the position: a partial
   *   mismatch leaves the position satisfiable by its surviving
   *   members, and the message says separately when every member is
   *   dead. Silent where `type` is absent or names something outside
   *   JSON Schema's seven names, and silent for a `null` member beside
   *   `nullable: true` under OAS 3.0, where that is valid. Under 3.1
   *   `nullable` is inert, so the same input is reported there.
   */
  code:
    | "partial-feature"
    | "unknown-keyword"
    | "annotation-value-type"
    | "silent-rewrite/ref-siblings-oas30"
    | "silent-rewrite/required-not-in-properties"
    | "silent-rewrite/redundant-composition-branches"
    | "silent-rewrite/discriminator-unroutable"
    | "silent-rewrite/pattern-not-unicode-mode"
    | "unsatisfiable/pattern-length"
    | "unsatisfiable/enum-member-type";
  /** The offending keyword / key name as written in the schema. */
  keyword: string;
  /**
   * Dotted rendering of the position this finding is actionable at:
   * where a reader has to go to act on it.
   *
   * A locator to read, and not an address to parse. It is what `check`
   * prints and what every `message` interpolates, so its rendering is
   * user-visible output and changes only deliberately. For a machine
   * address use {@link SchemaLintIssue.pointer} (the document) or
   * {@link SchemaLintIssue.schemaPath} (inside the compiled schema),
   * each of which is absent rather than re-framed where it cannot
   * answer. This field is always present, including where both of those
   * are absent.
   *
   * Two frames are in use, and which one a rule renders in follows from
   * what the reader would have to edit:
   *
   * - **The definition**, for every rule except the one below. The
   *   render re-roots at each `$ref` crossed, so a defect in shared text
   *   is reported once at the place it gets fixed, however many use
   *   sites reach it. A local `#/…` ref renders as the dotted document
   *   path it names (`components.schemas.Email`); an anchor or an
   *   external URI renders as written, there being no document path to
   *   give.
   * - **The use site**, for
   *   `silent-rewrite/required-not-in-properties`. That rule asks which
   *   property names are reachable at an instance position, and a
   *   component answers differently at different use sites, so the
   *   definition can name a position where the finding does not hold.
   *   The render therefore keeps the route from the compiled schema root
   *   across every `$ref`. {@link SchemaLintIssue.anchor} reports
   *   `"scoped-definition"` in exactly this case, so a consumer holding
   *   a pointer can tell the two frames apart.
   *
   * A rule added later that reports at a use site states it here, the
   * way that one does.
   */
  path: string;
  /**
   * RFC 6901 pointer to what this finding is about, percent-decoded
   * with `~0` / `~1` retained.
   *
   * That is the subschema holding the offending key for most codes, and
   * the offending child for the two whose finding sits below it:
   * `silent-rewrite/redundant-composition-branches` addresses the
   * duplicate branch, and `silent-rewrite/required-not-in-properties`
   * addresses the `required` array. A consumer mapping this to a source
   * range gets the narrowest node that is wrong, which is not always
   * the node `keyword` names.
   *
   * Present only when the caller set {@link CompileOptions.pointer} and
   * the walk can still name a position: it re-roots at the target on
   * crossing a local `$ref`, and is absent below an anchor or external
   * `$ref`. Absence means no pointer into this document resolves here,
   * never that the caller should parse `path` instead.
   */
  pointer?: string;
  /**
   * Segments from the compiled schema root down to the subschema
   * holding the key, never pre-joined.
   *
   * Absent once a `$ref` has been crossed, since no segment list spans
   * a ref hop. `pointer` covers exactly that case for a caller who
   * supplied one, and a bare-schema caller has this and nothing else.
   */
  schemaPath?: readonly PathSegment[];
  /**
   * What {@link SchemaLintIssue.pointer} addresses, for a reader
   * deciding whether following it means editing shared text. Present
   * whenever `pointer` is.
   *
   * - `"node"`: the offending node itself, reached without crossing a
   *   `$ref`. Editing there affects nothing else.
   * - `"definition"`: shared text reached through a `$ref`. Editing
   *   there affects every use site.
   * - `"scoped-definition"`: shared text, but this finding is scoped to
   *   the route that reached it and the text may be correct for the
   *   definition's other users. Emitted only by rules whose verdict
   *   depends on the route, which today is
   *   `silent-rewrite/required-not-in-properties` alone.
   */
  anchor?: "node" | "definition" | "scoped-definition";
  /** Human-readable explanation. */
  message: string;
  /**
   * Human-readable text naming what was being compiled, from
   * {@link CompileOptions.label}, so the position fields can be placed
   * in the wider document. Absent when the caller set no label.
   *
   * Prose, and never parseable. For a machine address use
   * {@link SchemaLintIssue.pointer} (the document) or
   * {@link SchemaLintIssue.schemaPath} (inside the compiled schema).
   *
   * Names where the schema was *first* compiled. A component reached
   * from several operations compiles once and is reported once, against
   * whichever operation got there first, since the later ones hit the
   * compile cache. Treat it as a hint about where to look, not as the
   * complete set of operations affected.
   */
  location?: string;
}

/**
 * The function returned by {@link compileSchema}. Call it with any JSON value
 * to validate against the original schema. An optional `startPath`
 * is prepended to every error's `path`, useful when the compiled
 * validator is embedded inside a larger traversal (e.g. the HTTP
 * validator prepends `["body"]`, `["query", name]`, etc.). The array
 * is cloned before use and never mutated.
 *
 * @public
 */
export type CompiledSchema = {
  validate: (data: unknown, startPath?: readonly PathSegment[]) => ValidationResult;
  /**
   * The generated source. Empty unless the compile asked for it with
   * {@link CompileOptions.retainSource}, since keeping it costs memory
   * for as long as the validator lives and only a caller that reads it
   * gains anything.
   */
  source: string;
  /** Compile-time stats about the generated validator. */
  stats: CompileStats;
};

/**
 * The shape returned by {@link compileSchema} when `output: "tree"` is
 * set. Same `validate(data, startPath?)` signature as
 * {@link CompiledSchema}, but returns a {@link TreeValidationResult} (a
 * single nested error tree) instead of the flat default. See
 * {@link CompileOptions.output}. Carries the same `source` / `stats` as
 * {@link CompiledSchema}; only the `validate` return type differs.
 *
 * @public
 */
export type CompiledTreeSchema = Omit<CompiledSchema, "validate"> & {
  validate: (data: unknown, startPath?: readonly PathSegment[]) => TreeValidationResult;
};

/**
 * The shape returned by {@link compileSchema} when `output: "predicate"`
 * is set. The validator collects no errors, allocates no tree, and
 * returns a boolean: a true yes/no predicate. Use when consumers only
 * need to know whether the value conforms (e.g. routing, gating), not
 * why it doesn't. Carries the same `source` / `stats` as
 * {@link CompiledSchema}; only the `validate` return type differs.
 *
 * @public
 */
export type CompiledPredicate = Omit<CompiledSchema, "validate"> & {
  validate: (data: unknown) => boolean;
};

/**
 * Options accepted by {@link compileSchema}.
 *
 * @remarks
 * Ordering convention (shared with `@oaverify/core`'s
 * `ValidatorOptions`):
 *
 *   1. Compile essentials: `dialect`.
 *   2. Shared extension points: `formats`, `keywords`.
 *   3. Error-collection policy: `output`, `maxErrors`.
 *   4. Surface-specific extras last: here, `external`, `refResolver`.
 *
 * Options common to both surfaces share names and positions so a
 * reader of one declaration can predict the other. When adding a new
 * option, put it in the section that matches its role and use the
 * same name on the validator side if the concept applies there too.
 *
 * @public
 */
export interface CompileOptions {
  // --- 1. Compile essentials ---

  /**
   * The dialect to compile against. Pick one of the built-ins
   * (`jsonSchemaDialect`, `openapi31Dialect`, `oas30Dialect`) or
   * construct a custom {@link Dialect}.
   */
  dialect: Dialect;

  // --- 2. Shared extension points ---

  /**
   * Pre-registered format validators, keyed by format name.
   *
   * One registry for every format, whatever JSON type it constrains:
   * `date-time` takes a string and `int32` takes a number, and both are
   * configured here. See {@link FormatDefinition} for the four
   * spellings, including `false`, which registers a name and asserts
   * nothing.
   *
   * ```ts
   * compileSchema(schema, {
   *   dialect: oas30Dialect,
   *   formats: { ...builtInFormats, int64: false },
   * });
   * ```
   */
  formats?: Record<string, FormatDefinition>;
  /**
   * User-registered keywords, keyed by keyword name. Each validator is
   * invoked whenever its name appears as a property in a schema object.
   * Custom names must not collide with a keyword already supplied by
   * the configured dialect.
   *
   * @example
   * ```ts
   * compileSchema(schema, {
   *   dialect: jsonSchemaDialect,
   *   keywords: {
   *     divisibleBy: (data, schemaValue) =>
   *       typeof data !== "number" || data % (schemaValue as number) === 0,
   *   },
   * });
   * ```
   */
  keywords?: Record<string, CustomKeywordValidator>;

  // --- 3. Error-collection policy ---

  /**
   * What `validate()` returns. Selects the result shape:
   *
   * - `"flat"` (default): a {@link ValidationResult}: `{ valid }` plus,
   *   on failure, a de-nested `errors` leaf list and `truncated`. Shaped
   *   to match ajv's zero-config output. With the default
   *   `maxErrors: 1`, this is the fast-fail path that hits ajv-class
   *   numbers on the rejection benchmark.
   * - `"tree"`: a {@link TreeValidationResult}: `{ valid }` plus, on
   *   failure, a single nested {@link ValidationError} tree under `error`
   *   and `truncated`. The rich diagnostic shape; what `@oaverify/core`
   *   compiles in so it can nest per-location subtrees.
   * - `"predicate"`: a {@link CompiledPredicate} whose `validate(data)`
   *   returns a bare `boolean`. No {@link ValidationError} tree is ever
   *   constructed, so consumers who only need a yes/no answer pay nothing
   *   for error-reporting machinery (leaf allocation, path snapshot,
   *   params object, message string).
   *
   * Defaults to `"flat"`.
   *
   * `output: "predicate"` is mutually exclusive with a finite
   * {@link CompileOptions.maxErrors}: a predicate short-circuits at the
   * first failure, so there is nothing to count. The compiler throws when
   * both are supplied.
   */
  output?: "flat" | "tree" | "predicate";
  /**
   * Cap on the number of leaf errors collected per `validate()` call.
   * Defaults to `1` (fast-fail: stop at the first error), matching ajv's
   * `allErrors: false` zero-config behaviour. Pass
   * `Number.POSITIVE_INFINITY` to collect everything.
   *
   * When set to a finite value:
   * - Once the cap is reached, `truncated: true` is set on the returned
   *   result and no further errors are reported.
   * - In flat mode (the default output), reaching the cap returns from
   *   the validator immediately, skipping the remaining keyword checks
   *   entirely; `maxErrors: 1` behaves like ajv's `allErrors: false`
   *   fast-fail. Tree mode keeps walking (to preserve the tree shape)
   *   but stops collecting.
   * - Schemas using `unevaluatedProperties` / `unevaluatedItems` are a
   *   carve-out: evaluated-key tracking needs every keyword to run, so
   *   the cap is not enforced and failing results carry every error
   *   with `truncated: false`.
   *
   * `maxErrors: 1` is the default (classic fast-fail). To collect every
   * error, pass `Number.POSITIVE_INFINITY`.
   *
   * Must be a positive integer (>= 1) when supplied. A cap of 0 is
   * effectively predicate mode (no errors collected, validation
   * collapses to yes/no); for that, prefer `output: "predicate"`
   * (see {@link CompileOptions.output}) which compiles a fully
   * specialized function with no error infrastructure at all.
   * `compileSchema` throws on `maxErrors <= 0`.
   */
  maxErrors?: number;
  /**
   * Cap on recursion depth through `$ref` cycles per `validate()` call.
   * Defaults to uncapped.
   *
   * Recursive schemas (a `$ref` that points back at an ancestor, common
   * for tree / comment structures) validate by recursing on the native
   * JS call stack. A small but deeply nested payload can exhaust the
   * stack and throw `RangeError`. Set this to bound the recursion: when
   * the configured depth is exceeded, validation emits a `depth` error
   * leaf (mapped to HTTP 400) at the boundary instead of descending
   * further, so a deep payload fails as invalid rather than crashing.
   *
   * The counter increments only at recursive (cycle-closing) `$ref`
   * boundaries, so it measures how deep the recursive structure nests
   * and is independent of how the schema was decomposed. Non-recursive
   * schemas are never instrumented and pay nothing. Legitimate payloads
   * rarely recurse beyond ten or fifteen levels; a cap of 32 to 64 is
   * generous for real traffic.
   *
   * When unset, codegen is identical to the un-instrumented path (zero
   * overhead). Must be a positive integer (>= 1), or `Infinity` for
   * explicitly uncapped; `compileSchema` throws otherwise.
   */
  maxDepth?: number;
  /**
   * Compile-time schema linting. All modes collect their findings to
   * {@link CompileStats.schemaLintIssues} rather than throwing.
   *
   * This grades schemas that *are* schemas. A document that is not a
   * schema at all -- a non-schema value in a schema-valued slot, say --
   * is rejected before linting runs, by a throw that no mode
   * suppresses. Well-formedness is a precondition here, not the
   * strictest rung of this ladder, so `"off"` silences lint findings
   * and nothing else.
   *
   * - `"off"`: silence on everything.
   * - `"warn"` (default): warn on keywords flagged as
   *   partially-implemented (no built-in sets this today; a custom
   *   keyword does so through `KeywordDefinition.partial`), on
   *   wrong-typed annotation values, and on the `silent-rewrite/*` and
   *   `unsatisfiable/*` findings.
   * - `"strict"`: warn on partial features AND unknown keys (keys not
   *   in the active dialect, not `x-*` extensions, not standard
   *   `$`-prefixed metadata). Catches typos like `minimumx: 5`.
   */
  schemaLint?: "off" | "warn" | "strict";

  /**
   * What to do about a `format` with no validator registered under its
   * name.
   *
   * - `"ignore"` (default): the format asserts nothing, per JSON Schema.
   * - `"error"`: refuse to compile, naming the formats.
   *
   * Inert where the dialect does not assert `format`, and independent of
   * {@link CompileOptions.schemaLint}, which reports advice rather than
   * refusing to build.
   *
   * Keep a format as an annotation by registering the identity for it:
   *
   * ```ts
   * compileSchema(schema, {
   *   unknownFormats: "error",
   *   formats: { "x-internal-id": () => true },
   * })
   * ```
   */
  unknownFormats?: "ignore" | "error";

  /**
   * Whether the compiled validator keeps the generated source that
   * built it, on {@link CompiledSchema.source}.
   *
   * `false` (default) drops it: `source` is the empty string, and the
   * text becomes collectable as soon as the validator is built. `true`
   * keeps it, which is what reading `source` for debugging, snapshot
   * testing, or emitting a standalone module needs.
   *
   * A memory decision and nothing else; the validator behaves
   * identically either way. The text is worth what it costs only to a
   * caller that reads it. One compile unit emits code for the whole
   * transitive closure of what it `$ref`s, so a caller compiling a
   * document operation by operation keeps that text once per
   * operation: retained, Stripe's OpenAPI document is 842 MB across
   * 2271 units (#624).
   */
  retainSource?: boolean;

  // --- 4. Schema-compile-specific extras ---

  /**
   * Names what is being compiled, for callers that compile many schemas
   * out of one document.
   *
   * Paths in errors and lint issues are relative to the schema handed
   * to this call, which is unambiguous for a single schema and not much
   * help across a spec with dozens of operations: `"if" at
   * "properties.amounts.allOf[1]" must be an object or boolean` says
   * what is wrong without saying where to look. Set this to something
   * that locates the schema in the wider document (`POST /things
   * request body (application/json)`) and it prefixes thrown
   * well-formedness errors and lands on
   * {@link SchemaLintIssue.location}.
   *
   * Prose. {@link CompileOptions.pointer} is its structural sibling and
   * is what a machine consumer reads.
   *
   * The HTTP validator sets it per operation, so `createValidator`
   * callers get this without asking.
   */
  label?: string;
  /**
   * RFC 6901 pointer to where this schema sits in the document it came
   * from, percent-decoded with `~0` / `~1` retained. The structural
   * sibling of {@link CompileOptions.label}: that one names the schema
   * for a reader, this one addresses it for a machine, and lands on
   * {@link SchemaLintIssue.pointer}.
   *
   * Absent by default, and the absence is the contract rather than a
   * gap: a caller compiling a bare schema has no document, so no
   * pointer exists to give, and every lint issue from that compile
   * reports `pointer` absent rather than a synthesized address that
   * resolves nowhere.
   *
   * Pass the pointer of the schema **actually being compiled**. Where a
   * caller unwraps a root `$ref` before handing the schema over (the
   * HTTP validator does this for body schemas), that is the target's
   * pointer, not the use site's; the use site holds only the `$ref`,
   * so a pointer built from it does not resolve to what was compiled.
   *
   * **Precondition.** {@link CompileOptions.refResolver} must resolve
   * `#/…` against the same document this pointer is rooted in. The walk
   * re-roots at a local `$ref` by taking the fragment as a pointer, so
   * a resolver rooted somewhere else (the default one is rooted at the
   * schema) yields addresses in a frame the caller never named. The
   * HTTP validator satisfies this: its resolver and its pointers are
   * both rooted at the whole document.
   *
   * A caller compiling a **self-contained** schema satisfies it by
   * passing `""`: the default resolver is rooted at the schema, so the
   * schema is the document and the empty pointer names its root.
   * Worth doing where findings can sit behind a `$ref`, since
   * {@link SchemaLintIssue.schemaPath} stops at the first hop and
   * {@link SchemaLintIssue.pointer} keeps resolving past it
   * (`/$defs/Inner/properties/y`). A caller whose schema is a fragment
   * of some larger document, or whose `refResolver` is rooted
   * elsewhere, passes no pointer instead and reads `schemaPath`.
   */
  pointer?: string;
  /**
   * What {@link CompileOptions.pointer} already addresses. Pass
   * `"definition"` when the schema handed over was reached through a
   * `$ref`, so findings inside it are reported as shared text.
   *
   * The compiler cannot infer this: a hop made before the compile
   * started is invisible to it, and the HTTP validator makes exactly
   * that hop when it unwraps a body schema's root ref or resolves a
   * `$ref`'d Parameter. Defaults to `"node"`.
   */
  anchor?: "node" | "definition";

  /** Additional external named schemas that `$ref` can resolve to. */
  external?: Map<string, SchemaOrBoolean>;
  /**
   * Custom ref resolver; overrides the default (which resolves fragments
   * within the root).
   *
   * @remarks
   * `$dynamicRef` resolution sees only the documents the anchor scan
   * walked, which is the root schema plus {@link CompileOptions.external}.
   * A resolver that reaches schemas outside both is resolving documents
   * the scan never saw, so a `$dynamicAnchor` declared only in one of
   * them does not join the dynamic scope, and a `$dynamicRef` that would
   * have bound to it binds to its static target instead. Register those
   * schemas through `external` when their dynamic anchors need to
   * participate.
   */
  refResolver?: RefResolver;
  /**
   * Custom compiler for schema `pattern` keywords and the `format:
   * "regex"` assertion. Defaults to `new RegExp(pattern, "u")` with a
   * non-`u` fallback. Override to plug in a library like `re2`, wrap
   * with a complexity check, or reject patterns that fail a
   * safe-regex analysis.
   *
   * JavaScript's built-in `RegExp` has no execution timeout, so a
   * catastrophic pattern like `(a+)+$` is a denial-of-service vector
   * against any string the validator checks. Reach for this option
   * when the spec is attacker-controlled (multi-tenant SaaS,
   * spec-editing tools, mock-as-a-service).
   *
   * The runtime only reads `.test(s: string): boolean` off the
   * returned object; built-in `RegExp` already satisfies the shape.
   * Memoization is split by audience: schema `pattern` strings cache
   * for the validator's lifetime (bounded by spec size), `format:
   * "regex"` runs the compiler per call (runtime values are not).
   * See {@link RegexCompiler}.
   */
  regexCompiler?: RegexCompiler;
}

/** @internal */
export interface CompileState {
  readonly gen: CodeGen;
  readonly byKeyword: Map<string, KeywordDefinition>;
  readonly ordered: KeywordDefinition[];
  /**
   * Compiled function name per (mode, schema). Keyed by mode first so a
   * subschema can have both an error-mode and a predicate-mode function
   * (the two-phase composition optimization compiles branches in both).
   * Use {@link cacheFor} to get the inner map for a mode.
   */
  readonly compiledFor: Map<string, Map<SchemaOrBoolean, string>>;
  readonly functionBodies: string[];
  /**
   * `const <name> = <expr>;` lines emitted at module scope above every
   * validator function. Populated via
   * {@link KeywordCompileContext.hoistConstant}. Keeps schema-derived
   * Sets / arrays / regex candidates off the per-call hot path.
   */
  readonly hoistedConsts: string[];
  nextHoistId: number;
  readonly deps: ValidatorDeps;
  readonly refResolver: RefResolver;
  readonly graph: ResolvedGraph;
  readonly compileValidator: (schema: SchemaOrBoolean, mode: CompileMode) => string;
  /**
   * `true` when the runtime error-budget short-circuit is active: a
   * finite `maxErrors` was configured AND the schema does not track
   * evaluated keys. Codegen uses this to emit the extra budget checks;
   * otherwise we emit plain `errors.push` with no runtime overhead.
   *
   * The `unevaluated*` exclusion is a correctness guard, not an
   * optimization: under a finite cap, an evaluated-key-harvesting
   * sub-validator can exhaust the budget mid-evaluation, truncating its
   * evaluated-key set or starving a real error, which flips an
   * `unevaluatedProperties` / `unevaluatedItems` verdict. So schemas that
   * use those keywords collect every error (the cap is not enforced).
   */
  readonly gated: boolean;
  /**
   * `true` when a finite `maxDepth` was configured. Codegen uses this to
   * emit the recursion-depth guard at recursive `$ref` boundaries; when
   * unset, refs compile to a plain call with no runtime overhead.
   */
  readonly depthGated: boolean;
  /**
   * `true` when this compile unit both declares a `$dynamicAnchor` and
   * references one with a `$dynamicRef`, so `$dynamicRef` has to resolve
   * against the dynamic scope at runtime rather than statically.
   *
   * When unset, nothing dynamic-scope-related is emitted anywhere: no
   * scope array, no resource-entry wrappers, and `$dynamicRef` compiles
   * through the same path as `$ref`. The generated source is then
   * byte-identical to what the compiler produced before dynamic scoping
   * existed, which `dynamic-ref-zero-cost.test.ts` pins.
   */
  readonly dynamicScope: boolean;
  /**
   * Base URI of the root schema, seeded into the dynamic scope at the
   * top of each `validate()` call. Only read when
   * {@link CompileState.dynamicScope} is set.
   */
  readonly rootBaseUri: string;
  /**
   * Base URIs of the resources this compile unit can enter. Bounds the
   * candidate set a `$dynamicRef` compiles; see
   * {@link collectReachableResources}. Empty when
   * {@link CompileState.dynamicScope} is off.
   */
  readonly reachableResources: ReadonlySet<string>;
  /**
   * Schemas whose function body is currently being generated (the
   * compile stack). A `$ref` whose target is in this set is a back-edge:
   * it closes a recursion cycle, so it carries the depth guard. Forward
   * refs (target already compiled, or not yet started) are not in the
   * set and compile to a plain call. Added in {@link compileValidator}
   * before walking a schema's keywords and removed once they're done.
   */
  readonly compiling: Set<SchemaOrBoolean>;
  /**
   * `true` when predicate mode was requested. Compiled subfunctions
   * return `boolean` (no error tree); leaf-emitting keywords emit
   * `return false;` instead of pushing into an accumulator. Requested
   * as {@link CompileOptions.output} `"predicate"`.
   */
  readonly predicate: boolean;
  /**
   * `true` when flat-collection mode was requested. Compiled subfunctions
   * return a flat `ValidationError[]` of leaves (or `null`) instead of a
   * single (possibly branch-wrapped) node; lift sites append rather than
   * push, and the inline-wrap and composition-wrap steps are replaced by
   * flat appends plus marker leaves. Requested as
   * {@link CompileOptions.output} `"flat"`, the default.
   */
  readonly flat: boolean;
  /**
   * OpenAPI 3.0 semantics. When `true`, schemas containing `$ref`
   * dispatch only `$ref` and ignore every other keyword.
   */
  readonly refSuppressesSiblings: boolean;
  /**
   * `true` when `unevaluatedProperties` or `unevaluatedItems` appears
   * anywhere in the root schema or any registered external schema. When
   * `false`, the compiler suppresses allocation of per-function
   * `evalProps` / `evalItems` Sets and the merge loop that threads them
   * back to the caller: machinery that's inert unless
   * `unevaluated*` actually consumes it. OpenAPI specs essentially
   * never use these keywords, so the false path is the common case.
   */
  readonly unevaluatedTracking: boolean;
  /**
   * What each registered `format` name constrains. Threaded to every
   * keyword context; see {@link KeywordCompileContext.formatTypeOf}.
   */
  readonly formatTypes: ReadonlyMap<string, FormatKind>;
  nextFn: number;
  /**
   * Set to `true` the first time any generated function actually
   * allocates an `evalProps` / `evalItems` Set. Surfaced in
   * {@link CompileStats.unevaluatedTrackingEmitted} so callers can
   * observe the gating optimization's effect.
   */
  unevaluatedEmitted: boolean;
}

/**
 * Return `true` iff `schema` (or any schema reachable from it through
 * subschema-valued positions) contains the `unevaluatedProperties` or
 * `unevaluatedItems` keyword. The detector is the gate for the
 * evaluated-keys-Set machinery: when it's `false`, the compiler emits
 * a form that skips the per-function Set allocation entirely.
 *
 * The walk descends the local subschema positions (the same set
 * {@link walkSubschemas} uses) and is cycle-safe: a `$ref` value is a
 * string, so the walk never recurses through one. A schema whose only
 * `unevaluated*` keyword sits behind a `$ref` is therefore not detected
 * by this predicate; resolve such refs first if that matters.
 *
 * @public
 */
export function schemaUsesUnevaluated(schema: SchemaOrBoolean): boolean {
  const seen = new WeakSet<object>();
  const walk = (s: unknown): boolean => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
    if (seen.has(s)) return false;
    seen.add(s);
    if ("unevaluatedProperties" in s || "unevaluatedItems" in s) return true;
    for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
      if (key in s && walk((s as Record<string, unknown>)[key])) return true;
    }
    for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
      const arr = (s as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        for (const item of arr) if (walk(item)) return true;
      }
    }
    for (const key of SUBSCHEMA_MAP_POSITIONS) {
      const obj = (s as Record<string, unknown>)[key];
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        for (const v of Object.values(obj)) if (walk(v)) return true;
      }
    }
    return false;
  };
  return walk(schema);
}

/**
 * Does this compile unit need a runtime dynamic scope?
 *
 * Only when it declares a `$dynamicAnchor` *and* references one with a
 * `$dynamicRef`. Either keyword alone is inert: an anchor nothing points
 * at binds nothing, and a `$dynamicRef` with no anchor to rebind to is a
 * `$ref` (see the `$dynamicRef` keyword). Both flags are collected in
 * one pass so a caller can union them across the root and every
 * external schema before deciding.
 *
 * Cycle-safe and conservative in the same way as
 * {@link schemaUsesUnevaluated}: the walk never follows a `$ref`, so
 * this is a syntactic question about the documents in hand. A false
 * positive costs one wrapper function; a miss would silently restore
 * the static-resolution bug, so the walk covers every subschema
 * position rather than the ones anchors usually appear in.
 *
 * @internal
 */
export function scanDynamicScopeUsage(schema: SchemaOrBoolean): {
  anchor: boolean;
  ref: boolean;
} {
  const seen = new WeakSet<object>();
  let anchor = false;
  let ref = false;
  const walk = (s: unknown): void => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    if ("$dynamicAnchor" in s) anchor = true;
    if ("$dynamicRef" in s) ref = true;
    if (anchor && ref) return;
    for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
      if (key in s) walk((s as Record<string, unknown>)[key]);
    }
    for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
      const arr = (s as Record<string, unknown>)[key];
      if (Array.isArray(arr)) for (const item of arr) walk(item);
    }
    for (const key of SUBSCHEMA_MAP_POSITIONS) {
      const obj = (s as Record<string, unknown>)[key];
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        for (const v of Object.values(obj)) walk(v);
      }
    }
  };
  walk(schema);
  return { anchor, ref };
}

/** `output` selects the result shape; absent it, the default is `"flat"`. */
function resolveOutputMode(options: CompileOptions): "flat" | "tree" | "predicate" {
  return options.output ?? "flat";
}

/**
 * Compile a JSON Schema 2020-12 document into an executable validator.
 *
 * @param schema - The schema (object or boolean) to compile.
 * @param options - See {@link CompileOptions}; `dialect` is the only
 *   one most callers set.
 * @returns A {@link CompiledSchema}: the validator, its stats, and the
 *   generated source, which is empty unless
 *   {@link CompileOptions.retainSource} asked for it.
 *
 * @example
 * ```ts
 * const v = compileSchema({ type: "number" }, { dialect: jsonSchemaDialect });
 * v.validate(1.5); // { valid: true }
 * v.validate("x"); // { valid: false, errors: [{ code: "type", ... }], truncated: true }
 *
 * // Opt into the nested error tree:
 * const t = compileSchema({ type: "number" }, { dialect: jsonSchemaDialect, output: "tree" });
 * t.validate("x"); // { valid: false, error: { code: "type", ... }, truncated: false }
 * ```
 *
 * @public
 */
export function compileSchema(
  schema: SchemaOrBoolean,
  options: CompileOptions & { output: "predicate" },
): CompiledPredicate;
export function compileSchema(
  schema: SchemaOrBoolean,
  options: CompileOptions & { output: "tree" },
): CompiledTreeSchema;
export function compileSchema(
  schema: SchemaOrBoolean,
  options: CompileOptions & { output?: "flat" | undefined },
): CompiledSchema;
export function compileSchema(
  schema: SchemaOrBoolean,
  options: CompileOptions,
): CompiledSchema | CompiledTreeSchema | CompiledPredicate;
export function compileSchema(
  schema: SchemaOrBoolean,
  options: CompileOptions,
): CompiledSchema | CompiledTreeSchema | CompiledPredicate {
  // Before anything else, so a bad option is reported as a bad option
  // rather than as a TypeError from inside codegen, once per schema.
  if (options.refResolver !== undefined) assertRefResolver(options.refResolver);

  const byKeyword = buildKeywordMap(options.dialect.vocabularies);
  const ordered: KeywordDefinition[] = [...byKeyword.values()];
  if (options.keywords) {
    for (const name of Object.keys(options.keywords)) {
      if (byKeyword.has(name)) {
        throw new Error(
          `custom keyword "${name}" conflicts with a built-in keyword from the configured vocabularies`,
        );
      }
      const def = createCustomKeywordDefinition(name);
      byKeyword.set(name, def);
      ordered.push(def);
    }
  }

  // Reject a malformed schema before compiling it: a bad slot either
  // compiles to a silently-weakened validator or dies with an unlocated
  // TypeError inside codegen. Runs after the keyword map is built,
  // because keyword value contracts are dialect-specific. Covers
  // `external` too, since those compile on `$ref` and a guarantee
  // holding for only part of the graph would be worse than none.
  assertWellFormedSchema(schema, byKeyword, {
    ...(options.label !== undefined && { label: options.label }),
    refSuppressesSiblings: options.dialect.rules.refSuppressesSiblings,
  });
  if (options.external) {
    for (const [name, sub] of options.external) {
      assertWellFormedSchema(sub, byKeyword, {
        label:
          options.label === undefined
            ? `external schema "${name}"`
            : `${options.label}: external schema "${name}"`,
        refSuppressesSiblings: options.dialect.rules.refSuppressesSiblings,
      });
    }
  }

  const mode = resolveOutputMode(options);
  const predicate = mode === "predicate";
  const flat = mode === "flat";

  // Default: fast-fail (stop at the first error), matching ajv's
  // `allErrors: false`. Predicate mode never counts errors, so its
  // effective cap is irrelevant; keep it uncapped so the explicit-cap
  // conflict check below only fires on a caller-supplied value.
  const maxErrors = options.maxErrors ?? (predicate ? Number.POSITIVE_INFINITY : 1);
  if (
    options.maxErrors !== undefined &&
    Number.isFinite(options.maxErrors) &&
    (!Number.isInteger(options.maxErrors) || options.maxErrors < 1)
  ) {
    // Reject values that would silently neutralise validation. A cap
    // of 0 collects nothing and would return `valid: true` for invalid
    // data; non-integers are likely a typo. `output: "predicate"` is the
    // explicit way to skip error collection entirely. `Infinity` is the
    // uncapped escape hatch and is accepted explicitly.
    throw new Error(
      `compileSchema: \`maxErrors\` must be a positive integer (got ${String(options.maxErrors)}). ` +
        'Use `output: "predicate"` if you want a yes/no validator with no error tree.',
    );
  }
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  if (
    options.maxDepth !== undefined &&
    Number.isFinite(maxDepth) &&
    (!Number.isInteger(maxDepth) || maxDepth < 1)
  ) {
    // Same contract as `maxErrors`: a cap of 0 or a non-integer would
    // misconfigure the guard silently. `Infinity` (omitting) is the
    // uncapped default and is accepted explicitly.
    throw new Error(
      `compileSchema: \`maxDepth\` must be a positive integer (got ${String(options.maxDepth)}). ` +
        "Omit the option for uncapped recursion depth.",
    );
  }
  if (predicate && options.maxErrors !== undefined && Number.isFinite(options.maxErrors)) {
    // Predicate mode short-circuits at the first failure by design;
    // a finite maxErrors cap would be shadowed and callers would be
    // misled into thinking errors were being counted. Fail loudly.
    throw new Error(
      'compileSchema: `output: "predicate"` is mutually exclusive with a finite `maxErrors`. ' +
        "Predicate mode short-circuits on the first failure, so there is nothing to count.",
    );
  }
  const deps = createDeps({ maxErrors, maxDepth, regexCompiler: options.regexCompiler });
  // Two derived things, one walk: the normalized validators that
  // generated code calls, and the declared types that codegen reads.
  // The types are what a keyword may specialize on, because they are
  // the same on both sides of `emitStandalone`'s compile / run split;
  // see `KeywordCompileContext.formatTypeOf`.
  const formatTypes = new Map<string, FormatKind>();
  if (options.formats) {
    for (const name of Object.keys(options.formats)) {
      const definition = options.formats[name];
      if (definition === undefined) continue;
      // Rethrown with the key, because the bad entry is in the caller's
      // map and `normalizeFormat` only ever sees the value.
      let normalized: ReturnType<typeof normalizeFormat>;
      try {
        normalized = normalizeFormat(definition);
      } catch (err) {
        throw new Error(`formats[${JSON.stringify(name)}]: ${(err as Error).message}`, {
          cause: err,
        });
      }
      deps.formats.set(name, normalized);
      formatTypes.set(name, normalized === null ? "none" : normalized.type);
    }
  }
  if (options.keywords) {
    for (const name of Object.keys(options.keywords)) {
      const fn = options.keywords[name];
      if (fn !== undefined) deps.customKeywords.set(name, fn);
    }
  }
  const registry = new SchemaRegistry();
  if (options.external !== undefined) {
    for (const [uri, ext] of options.external) registry.add(uri, ext);
  }
  const graph = resolve(schema, { registry });
  const refResolver = options.refResolver ?? createRefResolver(graph);

  // Second pass, now that refs can be followed. The first pass above
  // runs without a resolver because `resolve` itself walks the schema
  // and a malformed slot would crash it before this pass could say
  // where the problem is. Components arrive through the resolver rather
  // than in the schema object, so without this they compile unchecked
  // (#512). Re-walking the root costs one linear pass over a graph that
  // is about to be compiled.
  assertWellFormedSchema(schema, byKeyword, {
    ...(options.label !== undefined && { label: options.label }),
    refResolver,
    refSuppressesSiblings: options.dialect.rules.refSuppressesSiblings,
  });

  if (options.unknownFormats === "error") {
    assertFormatsRegistered(schema, byKeyword, deps.formats, options.label, (ref) =>
      refResolver.resolve(ref),
    );
  }

  // One-pass walk: does anything in this compile unit use
  // `unevaluatedProperties` / `unevaluatedItems`? Include external
  // schemas in the walk because a `$ref` can cross into them. A false
  // positive costs perf but not correctness; a miss would silently
  // disable tracking for a spec that needs it, so the walker's
  // subschema positions are kept conservative.
  let unevaluatedTracking = schemaUsesUnevaluated(schema);
  if (!unevaluatedTracking && options.external) {
    for (const ext of options.external.values()) {
      if (schemaUsesUnevaluated(ext)) {
        unevaluatedTracking = true;
        break;
      }
    }
  }

  // Same one-pass shape as the `unevaluated*` gate above, and the same
  // reason: when this is off, nothing below emits anything, and the
  // generated source is identical to what a compiler without dynamic
  // scoping would produce.
  const dynUsage = scanDynamicScopeUsage(schema);
  if (options.external) {
    for (const ext of options.external.values()) {
      if (dynUsage.anchor && dynUsage.ref) break;
      const extUsage = scanDynamicScopeUsage(ext);
      dynUsage.anchor ||= extUsage.anchor;
      dynUsage.ref ||= extUsage.ref;
    }
  }
  const dynamicScope = dynUsage.anchor && dynUsage.ref;

  const state: CompileState = {
    gen: new CodeGen(),
    byKeyword,
    ordered,
    compiledFor: new Map(),
    functionBodies: [],
    hoistedConsts: [],
    nextHoistId: 0,
    deps,
    refResolver,
    graph,
    nextFn: 0,
    // The runtime error-budget short-circuit is unsafe when the schema
    // tracks evaluated keys: a finite cap can exhaust mid-evaluation,
    // truncating a sub-validator's evaluated-key set or starving a real
    // error, which flips `unevaluatedProperties` / `unevaluatedItems`
    // verdicts. So short-circuit only when nothing uses `unevaluated*`;
    // those schemas collect every error (the cap is not enforced). They
    // never appear in OpenAPI, so the HTTP fast path is unaffected.
    gated: Number.isFinite(maxErrors) && !unevaluatedTracking,
    depthGated: Number.isFinite(maxDepth),
    compiling: new Set(),
    predicate,
    flat,
    refSuppressesSiblings: options.dialect.rules.refSuppressesSiblings,
    unevaluatedTracking,
    formatTypes,
    unevaluatedEmitted: false,
    dynamicScope,
    reachableResources: dynamicScope
      ? collectReachableResources(schema, graph, refResolver)
      : new Set<string>(),
    rootBaseUri:
      (typeof schema === "object" && schema !== null
        ? graph.schemaBaseUri.get(schema)
        : undefined) ?? graph.baseUri,
    compileValidator(sub, mode) {
      return compileValidator(sub, state, mode);
    },
  };

  // The scope lives in the generated closure rather than on `deps`, so
  // it is per-compiled-validator state and cannot be shared by two
  // validators built from one `deps`. Declared before any table so the
  // lookup helper can close over it.
  if (dynamicScope) {
    state.hoistedConsts.push(`const ${DYN_SCOPE} = [];`);
    state.hoistedConsts.push(
      `const ${DYN_LOOKUP} = (table, fallback) => {\n` +
        `  for (let i = 0; i < ${DYN_SCOPE}.length; i += 1) {\n` +
        `    const found = table.get(${DYN_SCOPE}[i]);\n` +
        `    if (found !== undefined) return found;\n` +
        `  }\n` +
        `  return fallback;\n` +
        `};`,
    );
  }

  // Top-level output shape. Subschemas default to this; the composition
  // keywords request `"predicate"` per-branch on top of it.
  const topMode: CompileMode = predicate ? "predicate" : flat ? "flat" : "tree";
  const rootName = compileValidator(schema, state, topMode);

  const wholeSource = assembleSource(state, rootName);
  const lintMode = options.schemaLint ?? DEFAULT_SCHEMA_LINT_MODE;
  const schemaLintIssues: readonly SchemaLintIssue[] =
    lintMode === "off"
      ? []
      : runSchemaLint(schema, byKeyword, lintMode, options.label, {
          refSuppressesSiblings: state.refSuppressesSiblings,
          customRegexCompiler: options.regexCompiler !== undefined,
          pointer: options.pointer,
          anchor: options.anchor,
          // Lets the `required` rule see through `$ref` into component
          // schemas, which an operation-scoped compile cannot reach by
          // walking its own schema object.
          //
          // Resolution failure is not an error here. This resolver is
          // called without the base URI codegen threads through scope,
          // so a relative ref under an `$id` is unresolvable to the lint
          // and resolvable to the compiler that already emitted a call
          // to it. Lint is advisory (see CompileStats.schemaLintIssues),
          // so a pointer it cannot follow costs coverage of that subtree.
          // Rethrowing would fail a compile over a schema that is fine
          // (#536). Codegen resolves the same refs itself and reports a
          // genuinely broken one from there.
          resolveRef: (ref) => {
            try {
              return refResolver.resolve(ref);
            } catch {
              return undefined;
            }
          },
        });
  // Dropping the reference here is the whole of the default:
  // `wholeSource` is still live for the `new Function` calls below, and
  // becomes collectable when this call returns.
  const retainedSource = options.retainSource === true ? wholeSource : "";
  const stats: CompileStats = {
    functionCount: state.nextFn,
    unevaluatedTrackingEmitted: state.unevaluatedEmitted,
    emittedTreeRuntime: TREE_RUNTIME_HELPERS.test(wholeSource),
    schemaLintIssues,
  };
  if (predicate) {
    const factory = new Function(NAMES.DEPS, wholeSource) as (
      deps: ValidatorDeps,
    ) => CompiledPredicateFactory;
    const { validate } = factory(deps);
    return { validate, source: retainedSource, stats };
  }
  if (flat) {
    const factory = new Function(NAMES.DEPS, wholeSource) as (
      deps: ValidatorDeps,
    ) => CompiledFlatSchemaFactory;
    const { validate } = factory(deps);
    return { validate, source: retainedSource, stats };
  }
  const factory = new Function(NAMES.DEPS, wholeSource) as (
    deps: ValidatorDeps,
  ) => CompiledTreeSchemaFactory;
  const { validate } = factory(deps);
  return { validate, source: retainedSource, stats };
}

/** Flat-mode (default) runtime factory: `validate()` returns a {@link ValidationResult}. */
interface CompiledFlatSchemaFactory {
  validate: (data: unknown, startPath?: readonly PathSegment[]) => ValidationResult;
}

/** Tree-mode (`output: "tree"`) runtime factory: returns a {@link TreeValidationResult}. */
interface CompiledTreeSchemaFactory {
  validate: (data: unknown, startPath?: readonly PathSegment[]) => TreeValidationResult;
}

interface CompiledPredicateFactory {
  validate: (data: unknown) => boolean;
}

/**
 * Per-mode slice of {@link CompileState.compiledFor}, created on demand.
 *
 * A schema entered across a resource boundary gets a second entry point
 * (see {@link compileValidator}), so the key carries that too. Both
 * entry points share one body; only the wrapper differs.
 */
function cacheFor(
  state: CompileState,
  mode: CompileMode,
  entersResource = false,
): Map<SchemaOrBoolean, string> {
  const key = entersResource ? `${mode}#enter` : mode;
  let m = state.compiledFor.get(key);
  if (m === undefined) {
    m = new Map();
    state.compiledFor.set(key, m);
  }
  return m;
}

/** Base URI of the resource a schema belongs to. */
function baseUriOf(schema: SchemaOrBoolean, state: CompileState): string {
  if (typeof schema !== "object" || schema === null) return state.graph.baseUri;
  return state.graph.schemaBaseUri.get(schema) ?? state.graph.baseUri;
}

/**
 * The parameter list every compiled function in this unit takes, so a
 * wrapper can forward its arguments verbatim.
 */
function signatureParams(state: CompileState, mode: CompileMode): string {
  const evalParams = state.unevaluatedTracking
    ? `, ${NAMES.OUT_EVAL_PROPS}, ${NAMES.OUT_EVAL_ITEMS}`
    : "";
  return mode === "predicate"
    ? `${NAMES.DATA}${evalParams}`
    : `${NAMES.DATA}, ${NAMES.PATH}${evalParams}`;
}

/**
 * Compile `schema` and return the name of its validator function.
 *
 * `entersResource` asks for the entry point that enters a schema
 * resource: a wrapper that pushes this schema's base URI onto the
 * dynamic scope, calls the ordinary function, and pops. Callers set it
 * when the call crosses a base URI, which is the only way the dynamic
 * scope changes.
 *
 * The wrapper exists so that unwinding is structural. It has one call
 * and one return and no branches, so the pop cannot be skipped by a
 * predicate-mode `return false`, a `maxErrors` short-circuit, or the
 * `maxDepth` guard declining to descend. Every one of those lives
 * inside the wrapped function and returns through the pop.
 */
function compileValidator(
  schema: SchemaOrBoolean,
  state: CompileState,
  mode: CompileMode,
  entersResource = false,
): string {
  if (entersResource && state.dynamicScope) {
    const cache = cacheFor(state, mode, true);
    const cached = cache.get(schema);
    if (cached !== undefined) return cached;
    const name = `enter_${state.nextFn}`;
    state.nextFn += 1;
    cache.set(schema, name);
    const inner = compileValidator(schema, state, mode, false);
    const params = signatureParams(state, mode);
    const resultVar = "entered";
    state.functionBodies.push(
      `function ${name}(${params}) {\n` +
        `  ${DYN_SCOPE}.push(${quoteString(baseUriOf(schema, state))});\n` +
        `  const ${resultVar} = ${inner}(${params});\n` +
        `  ${DYN_SCOPE}.pop();\n` +
        `  return ${resultVar};\n` +
        `}`,
    );
    return name;
  }

  const cache = cacheFor(state, mode);
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;

  // Reserve a name up front so cyclic `$ref`s that point back to this
  // schema hit the cache below and emit a normal recursive call.
  const name = `validate_${state.nextFn}`;
  state.nextFn += 1;
  cache.set(schema, name);

  // Pure-`$ref` elision: a schema whose only non-annotation keyword is
  // `$ref` compiles to a pass-through wrapper today (allocates a
  // scratch errors array, calls the target, propagates the result).
  // Nothing structural comes out of the wrapper; inlining it away
  // saves one function call per descent on every composition branch /
  // items call / properties subschema that uses `$ref`. When the ref
  // resolves back to this schema (self-recursion), alias returns the
  // placeholder name we just reserved, so we fall through and emit a
  // real wrapper function.
  if (isPureRefSchema(schema, state)) {
    const target = resolvePureRefSchema(schema as SchemaObject, state);
    // A recursive (back-edge) pure-ref under depth-gating must keep its
    // wrapper: eliding it would route the recursive call through the
    // caller (properties / items / composition), bypassing the `$ref`
    // keyword where the depth guard is emitted. Forward refs still elide.
    // A pure-`$ref` schema that crosses a resource boundary must keep
    // its wrapper too. `$id` is an annotation keyword, so a resource
    // root whose only other keyword is `$ref` looks elidable, and
    // eliding it would drop the base URI it contributes to the dynamic
    // scope. The intermediate-scopes suite case has exactly that shape.
    const crossesResource =
      state.dynamicScope &&
      target !== null &&
      baseUriOf(target, state) !== baseUriOf(schema, state);
    if (target !== null && !crossesResource && !(state.depthGated && state.compiling.has(target))) {
      const targetName = compileValidator(target, state, mode);
      if (targetName !== name) {
        cache.set(schema, targetName);
        return targetName;
      }
    }
  }

  // Mark this schema as on the compile stack while its body (and every
  // subschema reachable from it) is generated, so a `$ref` back to it
  // resolves as a recursion back-edge and gets the depth guard.
  state.compiling.add(schema);
  const body = buildFunctionBody(schema, state, mode);
  state.compiling.delete(schema);
  // Predicate mode drops the `path` parameter: error expressions
  // (which are the only consumer of `path`) are never emitted.
  // Callers of these functions (composition keywords, ref, etc.)
  // therefore omit the path argument in predicate mode as well.
  //
  // The `outEvalProps` / `outEvalItems` out-parameters only exist to
  // merge a branch's evaluated keys back to the caller, which only
  // happens when the compile unit uses `unevaluated*`. When tracking is
  // globally off (the common OpenAPI case), nothing reads them and no
  // call site passes them, so drop them from every signature.
  const params = signatureParams(state, mode);
  state.functionBodies.push(`function ${name}(${params}) {\n${body}\n}`);
  return name;
}

/**
 * True when `schema` is an object schema whose only non-annotation
 * keyword is `$ref` (plus possibly `$id`, `$schema`, `$comment`,
 * `title`, `description`, `$defs`, anchors). Such schemas compile to
 * a pass-through wrapper that's equivalent to calling the target
 * validator directly.
 *
 * Boolean schemas are excluded (not object-valued); schemas with any
 * other validation keyword (even a second applicator) are excluded:
 * those need a full compile because the sibling keywords contribute
 * to the result.
 */
function isPureRefSchema(schema: SchemaOrBoolean, state: CompileState): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  if (typeof (schema as Record<string, unknown>).$ref !== "string") return false;
  for (const key of Object.keys(schema)) {
    if (key === "$ref") continue;
    const kw = state.byKeyword.get(key);
    if (kw?.annotation === true) continue;
    return false;
  }
  return true;
}

/**
 * Resolve a pure-`$ref` schema's target schema (not its function name),
 * so {@link compileValidator} can both decide whether the ref is a
 * recursion back-edge (target on the compile stack) and, when eliding,
 * compile it. Mirrors the resolution in {@link compileSchemaKeywords}'s
 * `resolveRefToFunction` but reachable before the keywords are walked.
 */
function resolvePureRefSchema(schema: SchemaObject, state: CompileState): SchemaOrBoolean | null {
  const ref = (schema as Record<string, unknown>).$ref;
  if (typeof ref !== "string") return null;
  const currentBaseUri = state.graph.schemaBaseUri.get(schema) ?? state.graph.baseUri;
  return state.refResolver.resolve(ref, currentBaseUri);
}

/**
 * Base URIs of the schema resources this compile unit can actually
 * enter: the root's own, plus every resource reachable from it through
 * a subschema position or a resolvable `$ref` / `$dynamicRef`.
 *
 * `$dynamicRef` needs this because it compiles every binding its anchor
 * name could take, and the anchor tables cover every registered
 * document. Without the filter, registering an external schema that
 * happens to declare the same anchor name would pull it into the
 * compile whether or not anything references it, and a compile that
 * succeeds today would start failing on an unresolvable `$ref` inside a
 * document it never uses.
 *
 * Refs that do not resolve are skipped rather than raised. A reference
 * that matters is compiled through the ordinary path, which reports it.
 */
function collectReachableResources(
  root: SchemaOrBoolean,
  graph: ResolvedGraph,
  refResolver: RefResolver,
): Set<string> {
  const baseOf = (schema: SchemaOrBoolean): string =>
    (typeof schema === "object" && schema !== null ? graph.schemaBaseUri.get(schema) : undefined) ??
    graph.baseUri;

  const reachable = new Set<string>();
  const visited = new WeakSet<object>();
  const pending: SchemaOrBoolean[] = [root];

  // Every reference is resolved against the base URI of the schema that
  // makes it, the way `compileSchemaKeywords` does. Resolving against
  // the root base instead would mis-target a relative `$ref` under a
  // nested `$id`, and a resource dropped from this set changes which
  // anchor a `$dynamicRef` binds to.
  const handle = (node: SchemaOrBoolean): void => {
    if (typeof node !== "object" || node === null) return;
    if (visited.has(node)) return;
    visited.add(node);
    const base = baseOf(node);
    reachable.add(base);
    for (const key of ["$ref", "$dynamicRef"] as const) {
      const ref = (node as Record<string, unknown>)[key];
      if (typeof ref !== "string") continue;
      try {
        pending.push(refResolver.resolve(ref, base));
      } catch {
        // Not decidable here; see the doc comment.
      }
    }
  };

  while (pending.length > 0) {
    const document = pending.pop() as SchemaOrBoolean;
    if (typeof document !== "object" || document === null) continue;
    if (visited.has(document)) continue;
    handle(document);
    walkSubschemas(document, (sub) => {
      handle(sub);
    });
  }
  return reachable;
}

/**
 * Decide whether a `$dynamicRef` binds dynamically, and if so compile
 * every candidate it could bind to.
 *
 * Two conditions, both from the 2020-12 core spec. The reference has to
 * end in a plain-name fragment (`#name`, not `#/a/b`), and the schema it
 * statically resolves to has to declare `$dynamicAnchor: name` itself.
 * That second condition is the bookending requirement, and it is what
 * makes the leaving-a-dynamic-scope case work in both directions: a
 * `$dynamicRef` that lands somewhere without the matching anchor stays
 * put rather than searching the scope.
 *
 * Returns `null` when either condition fails, which is the signal to
 * compile the site exactly as `$ref` (see the `$dynamicRef` keyword).
 */
function buildDynamicRefTarget(
  ref: string,
  state: CompileState,
  mode: CompileMode,
  currentBaseUri: string,
  entersResource: (target: SchemaOrBoolean) => boolean,
): DynamicRefTarget | null {
  if (!state.dynamicScope) return null;
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) return null;
  const name = ref.slice(hashIdx + 1);
  if (name === "" || name.startsWith("/")) return null;

  let target: SchemaOrBoolean;
  try {
    target = state.refResolver.resolve(ref, currentBaseUri);
  } catch {
    return null;
  }
  if (typeof target !== "object" || target === null) return null;
  if ((target as SchemaObject).$dynamicAnchor !== name) return null;

  const candidates: (readonly [string, string])[] = [];
  for (const [baseUri, anchors] of state.graph.dynamicAnchorScopes) {
    if (!state.reachableResources.has(baseUri)) continue;
    const anchored = anchors.get(name);
    if (anchored === undefined) continue;
    candidates.push([
      baseUri,
      compileValidator(anchored, state, mode, entersResource(anchored)),
    ] as const);
  }
  if (candidates.length === 0) return null;

  return {
    candidates,
    fallback: compileValidator(target, state, mode, entersResource(target)),
  };
}

/**
 * Does `schema` contain any keyword that either evaluates properties
 * itself or might do so through a subschema? We use this to decide
 * whether a generated function needs to allocate evaluated-key sets.
 *
 * Short-circuits to `false` when {@link CompileState.unevaluatedTracking}
 * is off: a compile unit that never uses `unevaluatedProperties` has
 * nothing to consume the Sets, so allocating + merging them is pure
 * overhead.
 *
 * @internal
 */
function needsPropTracking(schema: SchemaObject, state: CompileState): boolean {
  if (!state.unevaluatedTracking) return false;
  return (
    "unevaluatedProperties" in schema ||
    "properties" in schema ||
    "patternProperties" in schema ||
    "additionalProperties" in schema ||
    "allOf" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "if" in schema ||
    "then" in schema ||
    "else" in schema ||
    "$ref" in schema ||
    "$dynamicRef" in schema ||
    "dependentSchemas" in schema
  );
}

/**
 * Mirror of {@link needsPropTracking} for array indices.
 *
 * @internal
 */
function needsItemTracking(schema: SchemaObject, state: CompileState): boolean {
  if (!state.unevaluatedTracking) return false;
  return (
    "unevaluatedItems" in schema ||
    "prefixItems" in schema ||
    "items" in schema ||
    "contains" in schema ||
    "allOf" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "if" in schema ||
    "then" in schema ||
    "else" in schema ||
    "$ref" in schema ||
    "$dynamicRef" in schema
  );
}

function buildFunctionBody(
  schema: SchemaOrBoolean,
  state: CompileState,
  mode: CompileMode,
): string {
  const predicate = mode === "predicate";
  const flat = mode === "flat";
  const gen = new CodeGen();
  gen.indent();
  if (!predicate) {
    // Start null; lazily allocate on first push. Valid inputs never
    // touch this; the function returns null directly without
    // allocating anything.
    gen.let(NAMES.ERRORS, "null");
  }

  if (schema === true) {
    // no-op; always valid
  } else if (schema === false) {
    if (predicate) {
      gen.line("return false;");
    } else {
      const falseErr = `${NAMES.DEPS}.createLeafError("false", ${NAMES.PATH}, "schema is false, nothing is valid")`;
      gen.line(emitPushStatement(NAMES.ERRORS, falseErr, state.gated, flat));
    }
  } else {
    const trackProps = needsPropTracking(schema, state);
    const trackItems = needsItemTracking(schema, state);
    let evaluatedPropertiesVar: string | null = null;
    let evaluatedItemsVar: string | null = null;
    if (trackProps) {
      evaluatedPropertiesVar = gen.scope.name("evalProps");
      gen.const(evaluatedPropertiesVar, "new Set()");
      state.unevaluatedEmitted = true;
    }
    if (trackItems) {
      evaluatedItemsVar = gen.scope.name("evalItems");
      gen.const(evaluatedItemsVar, "new Set()");
      state.unevaluatedEmitted = true;
    }
    compileSchemaKeywords(schema, gen, state, evaluatedPropertiesVar, evaluatedItemsVar, mode);
    // Merge evaluated-key sets into the caller's out-parameters when the
    // caller is tracking. Runs regardless of errors; a keyword that
    // evaluated a key evaluated it, even if other keywords flagged the
    // data invalid. In predicate mode any failure has already returned
    // `false` by this point, so the merge only runs for passing data;
    // that matches the 2020-12 semantics (annotations from failing
    // branches are discarded anyway).
    if (evaluatedPropertiesVar !== null) {
      gen.line(
        `if (${NAMES.OUT_EVAL_PROPS} !== undefined) { for (const k of ${evaluatedPropertiesVar}) ${NAMES.OUT_EVAL_PROPS}.add(k); }`,
      );
    }
    if (evaluatedItemsVar !== null) {
      gen.line(
        `if (${NAMES.OUT_EVAL_ITEMS} !== undefined) { for (const k of ${evaluatedItemsVar}) ${NAMES.OUT_EVAL_ITEMS}.add(k); }`,
      );
    }
  }

  if (predicate) {
    gen.line("return true;");
  } else if (flat) {
    // Flat mode: `errors` already holds this schema's leaves (or null);
    // return it directly, no wrapping. Callers append the list.
    gen.line(`return ${NAMES.ERRORS};`);
  } else {
    // Happy path: errors stayed null → return null directly and skip
    // the wrapErrors function call entirely.
    gen.line(`if (${NAMES.ERRORS} === null) return null;`);
    gen.line(`return ${NAMES.DEPS}.wrapErrors("schema", ${NAMES.PATH}, ${NAMES.ERRORS});`);
  }
  gen.dedent();
  return gen.toString();
}

function compileSchemaKeywords(
  schema: SchemaObject,
  gen: CodeGen,
  state: CompileState,
  evaluatedPropertiesVar: string | null,
  evaluatedItemsVar: string | null,
  mode: CompileMode,
): void {
  // Subschemas default to this function's mode; composition keywords
  // pass `"predicate"` for branches whose result is only a boolean.
  const currentBaseUri = state.graph.schemaBaseUri.get(schema) ?? state.graph.baseUri;
  // The dynamic scope changes on exactly two edges, and both are here:
  // an applicator descending into a subschema that declares its own
  // `$id`, and a `$ref` / `$dynamicRef` landing in another resource.
  // Both are statically decidable, so no keyword has to know the scope
  // exists.
  const entersResource = (target: SchemaOrBoolean): boolean =>
    state.dynamicScope && baseUriOf(target, state) !== currentBaseUri;
  const subCompiler = (subSchema: SchemaOrBoolean, subMode: CompileMode = mode): string =>
    compileValidator(subSchema, state, subMode, entersResource(subSchema));
  const resolveRefToFunction = (ref: string): string => {
    const target = state.refResolver.resolve(ref, currentBaseUri);
    return compileValidator(target, state, mode, entersResource(target));
  };
  const resolveDynamicRef = (ref: string): DynamicRefTarget | null =>
    buildDynamicRefTarget(ref, state, mode, currentBaseUri, entersResource);
  // A ref is recursive (a back-edge) when its target is still on the
  // compile stack: resolving it here only walks the ref graph, it does
  // not trigger compilation, so the result is independent of whether
  // `resolveRefToFunction` has run for this ref yet.
  const isRecursiveRef = (ref: string): boolean =>
    state.compiling.has(state.refResolver.resolve(ref, currentBaseUri));

  const runOrder = orderKeywordsForSchema(schema, state);
  // OAS 3.0: when `$ref` is present, every sibling keyword is ignored.
  const refOnly = state.refSuppressesSiblings && "$ref" in schema;
  // Shared per-function-body locals (e.g. the object-shape guard). One
  // map per function so keywords on this schema reuse a single emitted
  // `const`; see KeywordCompileContext.scopeLocal.
  const scopeLocals = new Map<string, string>();
  const seen = new Set<string>();
  for (const kw of runOrder) {
    if (seen.has(kw.keyword)) continue;
    if (!(kw.keyword in schema)) continue;
    if (refOnly && kw.keyword !== "$ref") continue;
    const schemaValue = (schema as Record<string, unknown>)[kw.keyword];
    const ctx = createKeywordContext({
      gen,
      schema: schemaValue,
      parentSchema: schema,
      data: NAMES.DATA,
      path: NAMES.PATH,
      errors: NAMES.ERRORS,
      compileSubschema: subCompiler,
      resolveRef: resolveRefToFunction,
      resolveDynamicRef,
      dynamicScopeName: DYN_SCOPE,
      dynamicLookupName: DYN_LOOKUP,
      isRecursiveRef,
      evaluatedPropertiesVar,
      evaluatedItemsVar,
      gated: state.gated,
      depthGated: state.depthGated,
      predicate: mode === "predicate",
      flat: mode === "flat",
      unevaluatedTracking: state.unevaluatedTracking,
      formatTypes: state.formatTypes,
      byKeyword: state.byKeyword,
      hoistConstant: (expr: string, prefix = "C"): string => {
        const name = `${prefix}_${state.nextHoistId}`;
        state.nextHoistId += 1;
        state.hoistedConsts.push(`const ${name} = ${expr};`);
        return name;
      },
      scopeLocals,
    });
    // `declineImplements` lets a keyword hand its `implements` entries
    // back, so they compile normally. `discriminator` needs it: when it
    // cannot build a routing table it must not suppress the `oneOf` /
    // `anyOf` beside it, or the composition that is the normative
    // constraint never runs and every payload is rejected (#561).
    let declined = false;
    kw.compile({ ...ctx, declineImplements: () => void (declined = true) });
    seen.add(kw.keyword);
    if (kw.implements && !declined) for (const impl of kw.implements) seen.add(impl);
  }
}

const UNEVALUATED_LAST = new Set(["unevaluatedProperties", "unevaluatedItems"]);

function orderKeywordsForSchema(schema: SchemaObject, state: CompileState): KeywordDefinition[] {
  const present = state.ordered.filter((kw) => kw.keyword in schema);
  const lead = present.filter((kw) => !UNEVALUATED_LAST.has(kw.keyword));
  const trail = present.filter((kw) => UNEVALUATED_LAST.has(kw.keyword));
  return [...lead, ...trail];
}

/**
 * Reset the dynamic scope and seed it with the root schema's resource,
 * emitted at the top of each `validate()` call next to the `deps.depth`
 * reset and for the same reason: consecutive calls have to be
 * independent, and a throw part-way through a validation would
 * otherwise leave the scope pushed for whoever calls next.
 */
function seedDynamicScope(state: CompileState): string[] {
  return [`  ${DYN_SCOPE}.length = 0;`, `  ${DYN_SCOPE}.push(${quoteString(state.rootBaseUri)});`];
}

function assembleSource(state: CompileState, rootName: string): string {
  const parts: string[] = [];
  parts.push(`"use strict";`);
  parts.push("");
  if (state.hoistedConsts.length > 0) {
    parts.push(...state.hoistedConsts);
    parts.push("");
  }
  parts.push(...state.functionBodies);
  parts.push("");
  if (state.predicate) {
    // Predicate mode: root call returns boolean directly; no error
    // object, no startPath (predicate doesn't expose paths), no budget
    // reset. Keeping the top-level `validate` arity at 1 means the
    // V8 JIT only ever sees the monomorphic call site.
    parts.push(`function validate(${NAMES.DATA}) {`);
    // Reset the per-call recursion counter so consecutive validate()
    // calls are independent.
    if (state.depthGated) parts.push(`  ${NAMES.DEPS}.depth = 0;`);
    if (state.dynamicScope) parts.push(...seedDynamicScope(state));
    parts.push(`  return ${rootName}(${NAMES.DATA});`);
    parts.push(`}`);
  } else if (state.flat) {
    // Flat mode: the root returns a flat `ValidationError[]` (or null);
    // the result carries it under `errors` rather than a tree `error`.
    parts.push(`function validate(${NAMES.DATA}, startPath) {`);
    if (state.gated) {
      parts.push(`  ${NAMES.DEPS}.errorsRemaining = ${NAMES.DEPS}.maxErrors;`);
      parts.push(`  ${NAMES.DEPS}.truncated = false;`);
    }
    if (state.depthGated) parts.push(`  ${NAMES.DEPS}.depth = 0;`);
    if (state.dynamicScope) parts.push(...seedDynamicScope(state));
    parts.push(
      `  const errs = ${rootName}(${NAMES.DATA}, startPath !== undefined ? [...startPath] : []);`,
    );
    parts.push(`  if (errs === null) return { valid: true };`);
    if (state.gated) {
      parts.push(
        `  if (${NAMES.DEPS}.truncated) return { valid: false, errors: errs, truncated: true };`,
      );
    }
    parts.push(`  return { valid: false, errors: errs, truncated: false };`);
    parts.push(`}`);
  } else {
    parts.push(`function validate(${NAMES.DATA}, startPath) {`);
    if (state.gated) {
      // Reset the per-call budget and truncation flag so consecutive
      // validate() calls are independent.
      parts.push(`  ${NAMES.DEPS}.errorsRemaining = ${NAMES.DEPS}.maxErrors;`);
      parts.push(`  ${NAMES.DEPS}.truncated = false;`);
    }
    // Reset the per-call recursion counter (independent of the error
    // budget; maxDepth and maxErrors gate separately).
    if (state.depthGated) parts.push(`  ${NAMES.DEPS}.depth = 0;`);
    if (state.dynamicScope) parts.push(...seedDynamicScope(state));
    parts.push(
      `  const err = ${rootName}(${NAMES.DATA}, startPath !== undefined ? [...startPath] : []);`,
    );
    parts.push(`  if (err === null) return { valid: true };`);
    if (state.gated) {
      parts.push(
        `  if (${NAMES.DEPS}.truncated) return { valid: false, error: err, truncated: true };`,
      );
    }
    parts.push(`  return { valid: false, error: err, truncated: false };`);
    parts.push(`}`);
  }
  parts.push("return { validate };");
  return parts.join("\n");
}
