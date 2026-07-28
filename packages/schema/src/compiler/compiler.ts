import type {
  PathSegment,
  SchemaObject,
  SchemaOrBoolean,
  ValidationError,
} from "@oaverify/internal-core";
import { CodeGen, NAMES } from "../codegen/index.js";
import { buildKeywordMap } from "../introspection.js";
import type { CompileMode, Dialect, KeywordDefinition } from "../keywords/types.js";
import { createKeywordContext, emitPushStatement } from "../keywords/context.js";
import { createCustomKeywordDefinition, type CustomKeywordValidator } from "../keywords/custom.js";
import {
  createRefResolver,
  resolve,
  SchemaRegistry,
  type RefResolver,
  type ResolvedGraph,
} from "../resolve/index.js";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
  walkSubschemas,
} from "../subschema-positions.js";
import { createDeps, type RegexCompiler, type ValidatorDeps } from "./runtime.js";
import { assertWellFormedSchema } from "./well-formed.js";

// Token scan fed into CompileStats.emittedTreeRuntime. Word-boundaried
// so stray mentions inside string literals (e.g. an error message that
// happens to contain "wrapErrors") don't count; every real emission
// spells the helper as a bare identifier.
const TREE_RUNTIME_HELPERS = /\b(?:createLeafError|createBranchError|wrapErrors)\b/;

/**
 * Default mode for {@link CompileOptions.strict}. Warns on partially-
 * implemented keywords (currently `$dynamicRef`); silent on unknown
 * keys. Callers opt into stricter behavior with `"strict"` or opt
 * out with `"off"`.
 */
const DEFAULT_SCHEMA_LINT_MODE = "warn" as const;

/**
 * Sibling keys explicitly permitted alongside `$ref` under OAS 3.0
 * (Schema Object §4.7.24.2): metadata-only, no validation effect.
 * Anything else gets silently dropped under
 * `refSuppressesSiblings: true`.
 */
const OAS30_REF_SIBLINGS_ALLOWED = new Set(["$ref", "description", "summary"]);

/** Composition keys that can introduce a `required` key from elsewhere. */
const COMPOSITION_KEYS = ["$ref", "allOf", "oneOf", "anyOf"] as const;

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

function runSchemaLint(
  schema: SchemaOrBoolean,
  byKeyword: Map<string, KeywordDefinition>,
  mode: "warn" | "strict",
  rules: { refSuppressesSiblings: boolean },
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
  walkSubschemas(schema, (node, path) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;

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
      if (mode !== "strict") continue;
      if (known.has(key)) continue;
      // `x-*` extensions are tolerated by OpenAPI convention; accept
      // them in strict mode too.
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

    // silent-rewrite/* checks are always-on (any non-"off" mode).
    if (rules.refSuppressesSiblings && typeof obj.$ref === "string") {
      for (const key of Object.keys(obj)) {
        if (OAS30_REF_SIBLINGS_ALLOWED.has(key)) continue;
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

    if (Array.isArray(obj.required)) {
      const hasComposition = COMPOSITION_KEYS.some((k) => k in obj);
      if (!hasComposition) {
        const props = obj.properties;
        const propKeys =
          typeof props === "object" && props !== null && !Array.isArray(props)
            ? new Set(Object.keys(props as Record<string, unknown>))
            : new Set<string>();
        for (const name of obj.required) {
          if (typeof name !== "string") continue;
          if (propKeys.has(name)) continue;
          issues.push({
            code: "silent-rewrite/required-not-in-properties",
            keyword: "required",
            path,
            message:
              path.length === 0
                ? `required: "${name}" at <root> not declared in properties (likely a typo)`
                : `required: "${name}" at "${path}" not declared in properties (likely a typo)`,
          });
        }
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
              message: `${key}[${i}] is structurally identical to ${key}[${j}] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec`,
            });
            break;
          }
        }
      }
    }
  });
  return issues;
}

/**
 * Result of a default-mode `validate()` call: a flat list of leaf
 * errors under `errors`. This is the v3 default (`output: "flat"`),
 * shaped to match ajv's zero-config result. Every failing leaf keyword
 * (`type`, `required`, `minimum`, …) is its own record, plus a childless
 * marker leaf for each failed composition keyword (`anyOf` / `oneOf`);
 * no `"schema"` branch wrappers. Each record is a {@link ValidationError}
 * with an empty `children`, so the `@oaverify/internal-core` renderers consume it
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
       * budget drains, without checking the remaining keywords. Under
       * the v3 default (`maxErrors: 1`) every failing result therefore
       * reports `truncated: true`. `false` means the cap was never hit
       * and the list is complete.
       */
      truncated: boolean;
    };

/**
 * Result of a tree-mode (`output: "tree"`) `validate()` call: a single
 * nested {@link ValidationError} tree under `error`, with `"schema"`
 * branch nodes mirroring the schema's composition structure. The opt-in
 * counterpart to the flat {@link ValidationResult} default. The HTTP
 * validator in `@oaverify/internal-validator` compiles in this mode so it can nest
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
   * Number of named `validate_N` helper functions emitted. A schema
   * that gets fully inlined compiles to one function (`validate_0`);
   * subschemas that stay as functions each add one.
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
   * Warnings produced by {@link CompileOptions.strict}. Empty unless
   * strict mode is active and found something to flag. Never contains
   * compile-blocking issues; strict mode only reports; the caller
   * decides whether to treat any entry as fatal.
   */
  schemaLintIssues: readonly SchemaLintIssue[];
}

/**
 * A single finding from strict-mode schema linting (see
 * {@link CompileOptions.strict}).
 *
 * @public
 */
export interface SchemaLintIssue {
  /**
   * - `"partial-feature"`: the schema uses a keyword flagged as
   *   partially-implemented (e.g. `$dynamicRef` without runtime
   *   dynamic-scope rebinding). Compile still succeeds; the emitted
   *   validator's semantics for this keyword may not match the spec.
   * - `"unknown-keyword"`: the schema declares a key that's not in the
   *   active dialect, not an `x-*` extension, and not a standard
   *   `$`-prefixed metadata key. Likely a typo.
   * - `"silent-rewrite/ref-siblings-oas30"`: under OAS 3.0
   *   (`refSuppressesSiblings: true`), a schema with `$ref` plus
   *   sibling keywords other than `description` / `summary`. The
   *   siblings are silently dropped; the validator runs the `$ref`
   *   target only.
   * - `"silent-rewrite/required-not-in-properties"`: a `required`
   *   array names a key that doesn't appear in the same schema's
   *   `properties`. Almost always a typo. Conservative: skipped on
   *   schemas that mix `required` with `$ref` / `allOf` / `oneOf` /
   *   `anyOf` (the named key could be contributed by a composed
   *   branch).
   * - `"silent-rewrite/redundant-composition-branches"`: an `oneOf` /
   *   `anyOf` array where two or more branches are structurally
   *   identical after compile-time rewrites (notably the validator's
   *   `format: binary` opaque-body bypass). The compiled validator's
   *   semantics differ from the source spec: identical branches
   *   collapse, changing the match-count behavior.
   */
  code:
    | "partial-feature"
    | "unknown-keyword"
    | "silent-rewrite/ref-siblings-oas30"
    | "silent-rewrite/required-not-in-properties"
    | "silent-rewrite/redundant-composition-branches";
  /** The offending keyword / key name as written in the schema. */
  keyword: string;
  /** Dotted path from the root schema to the subschema holding the key. */
  path: string;
  /** Human-readable explanation. */
  message: string;
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
  /** The generated source. Exposed for debugging/snapshot testing only. */
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
 * Ordering convention (shared with
 * {@link oaverify!ValidatorOptions}):
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

  /** Pre-registered format validators, keyed by format name. */
  formats?: Record<string, (value: string) => boolean>;
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
   *   and `truncated`. The rich diagnostic shape; what `@oaverify/internal-validator`
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
   * overhead). Must be a positive integer (>= 1); `compileSchema` throws
   * otherwise.
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
   * - `"off"`: silence on everything (pre-v-strict behavior).
   * - `"warn"` (default): warn on keywords flagged as
   *   partially-implemented (currently `$dynamicRef`; its runtime
   *   dynamic-scope rebinding is not emitted).
   * - `"strict"`: warn on partial features AND unknown keys (keys not
   *   in the active dialect, not `x-*` extensions, not standard
   *   `$`-prefixed metadata). Catches typos like `minimumx: 5`.
   */
  schemaLint?: "off" | "warn" | "strict";

  // --- 4. Schema-compile-specific extras ---

  /** Additional external named schemas that `$ref` can resolve to. */
  external?: Map<string, SchemaOrBoolean>;
  /** Custom ref resolver; overrides the default (which resolves fragments within the root). */
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
  readonly compiledFor: Map<CompileMode, Map<SchemaOrBoolean, string>>;
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
   * `return false;` instead of pushing into an accumulator. See
   * {@link CompileOptions.predicate}.
   */
  readonly predicate: boolean;
  /**
   * `true` when flat-collection mode was requested. Compiled subfunctions
   * return a flat `ValidationError[]` of leaves (or `null`) instead of a
   * single (possibly branch-wrapped) node; lift sites append rather than
   * push, and the inline-wrap and composition-wrap steps are replaced by
   * flat appends plus marker leaves. See {@link CompileOptions.flat}.
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

/** `output` selects the result shape; absent it, the default is `"flat"`. */
function resolveOutputMode(options: CompileOptions): "flat" | "tree" | "predicate" {
  return options.output ?? "flat";
}

/**
 * Compile a JSON Schema 2020-12 document into an executable validator.
 *
 * @param schema - The schema (object or boolean) to compile.
 * @param options - Vocabularies, formats, external schemas.
 * @returns A validator function plus the generated source.
 *
 * @example
 * ```ts
 * const v = compileSchema({ type: "number" }, { dialect: jsonSchemaDialect });
 * v.validate(1.5); // { valid: true }
 * v.validate("x"); // { valid: false, errors: [{ code: "type", ... }], truncated: false }
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
  // Before anything else: a malformed slot either compiles to a
  // silently-weakened validator or throws an unlocated TypeError from
  // inside codegen. Covers `external` too, since those are compiled on
  // `$ref` and a guarantee that held for only part of the graph would
  // be worse than none.
  assertWellFormedSchema(schema);
  if (options.external) {
    for (const [name, sub] of options.external) {
      assertWellFormedSchema(sub, `external schema "${name}"`);
    }
  }

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

  const mode = resolveOutputMode(options);
  const predicate = mode === "predicate";
  const flat = mode === "flat";

  // v3 default: fast-fail (stop at the first error), matching ajv's
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
  if (options.formats) {
    for (const name of Object.keys(options.formats)) {
      const fn = options.formats[name];
      if (fn !== undefined) deps.formats.set(name, fn);
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
    unevaluatedEmitted: false,
    compileValidator(sub, mode) {
      return compileValidator(sub, state, mode);
    },
  };

  // Top-level output shape. Subschemas default to this; the composition
  // keywords request `"predicate"` per-branch on top of it.
  const topMode: CompileMode = predicate ? "predicate" : flat ? "flat" : "tree";
  const rootName = compileValidator(schema, state, topMode);

  const wholeSource = assembleSource(state, rootName);
  const lintMode = options.schemaLint ?? DEFAULT_SCHEMA_LINT_MODE;
  const schemaLintIssues: readonly SchemaLintIssue[] =
    lintMode === "off"
      ? []
      : runSchemaLint(schema, byKeyword, lintMode, {
          refSuppressesSiblings: state.refSuppressesSiblings,
        });
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
    return { validate, source: wholeSource, stats };
  }
  if (flat) {
    const factory = new Function(NAMES.DEPS, wholeSource) as (
      deps: ValidatorDeps,
    ) => CompiledFlatSchemaFactory;
    const { validate } = factory(deps);
    return { validate, source: wholeSource, stats };
  }
  const factory = new Function(NAMES.DEPS, wholeSource) as (
    deps: ValidatorDeps,
  ) => CompiledTreeSchemaFactory;
  const { validate } = factory(deps);
  return { validate, source: wholeSource, stats };
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

/** Per-mode slice of {@link CompileState.compiledFor}, created on demand. */
function cacheFor(state: CompileState, mode: CompileMode): Map<SchemaOrBoolean, string> {
  let m = state.compiledFor.get(mode);
  if (m === undefined) {
    m = new Map();
    state.compiledFor.set(mode, m);
  }
  return m;
}

function compileValidator(schema: SchemaOrBoolean, state: CompileState, mode: CompileMode): string {
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
    if (target !== null && !(state.depthGated && state.compiling.has(target))) {
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
  const evalParams = state.unevaluatedTracking
    ? `, ${NAMES.OUT_EVAL_PROPS}, ${NAMES.OUT_EVAL_ITEMS}`
    : "";
  const params =
    mode === "predicate"
      ? `${NAMES.DATA}${evalParams}`
      : `${NAMES.DATA}, ${NAMES.PATH}${evalParams}`;
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
  const subCompiler = (subSchema: SchemaOrBoolean, subMode: CompileMode = mode): string =>
    compileValidator(subSchema, state, subMode);
  const currentBaseUri = state.graph.schemaBaseUri.get(schema) ?? state.graph.baseUri;
  const resolveRefToFunction = (ref: string): string => {
    const target = state.refResolver.resolve(ref, currentBaseUri);
    return compileValidator(target, state, mode);
  };
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
      isRecursiveRef,
      evaluatedPropertiesVar,
      evaluatedItemsVar,
      gated: state.gated,
      depthGated: state.depthGated,
      predicate: mode === "predicate",
      flat: mode === "flat",
      unevaluatedTracking: state.unevaluatedTracking,
      byKeyword: state.byKeyword,
      hoistConstant: (expr: string, prefix = "C"): string => {
        const name = `${prefix}_${state.nextHoistId}`;
        state.nextHoistId += 1;
        state.hoistedConsts.push(`const ${name} = ${expr};`);
        return name;
      },
      scopeLocals,
    });
    kw.compile(ctx);
    seen.add(kw.keyword);
    if (kw.implements) for (const impl of kw.implements) seen.add(impl);
  }
}

const UNEVALUATED_LAST = new Set(["unevaluatedProperties", "unevaluatedItems"]);

function orderKeywordsForSchema(schema: SchemaObject, state: CompileState): KeywordDefinition[] {
  const present = state.ordered.filter((kw) => kw.keyword in schema);
  const lead = present.filter((kw) => !UNEVALUATED_LAST.has(kw.keyword));
  const trail = present.filter((kw) => UNEVALUATED_LAST.has(kw.keyword));
  return [...lead, ...trail];
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
