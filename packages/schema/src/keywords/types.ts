import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import type { CodeEmitter } from "../codegen/index.js";

/**
 * Runtime inputs exposed to generated validator source. Keyword authors
 * reference entries by name; the compiler wires the map into the new
 * Function's closure.
 *
 * @public
 */
export interface CompileRuntime {
  patterns: Map<string, RegExp>;
  formats: Map<string, (value: string) => boolean>;
}

/**
 * Which budget semantics to apply when pushing an error expression
 * onto the errors accumulator. See {@link KeywordCompileContext.emitError}.
 *
 * - `"leaf"`: fresh leaf error, counts against `maxErrors`.
 * - `"lift"`: already-counted error being propagated (unconditional push).
 *
 * @public
 */
export type ErrorKind = "leaf" | "lift";

/**
 * The output shape a compiled (sub)validator produces:
 *
 * - `"tree"`: returns a nested `ValidationError | null` (the default).
 * - `"flat"`: returns a de-nested `ValidationError[] | null`.
 * - `"predicate"`: returns a `boolean` and builds no errors.
 *
 * Usually a subschema compiles in its enclosing function's mode. The
 * composition keywords request `"predicate"` explicitly for branches
 * whose result is consumed only as a yes/no (the decision phase of
 * `anyOf` / `oneOf`, the `not` assertion, the `if` condition), so the
 * valid path never builds an error tree it then discards. See
 * {@link KeywordCompileContext.compileSubschema}.
 *
 * @public
 */
export type CompileMode = "tree" | "flat" | "predicate";

/**
 * Options for {@link KeywordCompileContext.validateSubschema}.
 *
 * @public
 */
export interface ValidateSubschemaOptions {
  /**
   * Extra path segment to push onto `path` for the duration of this
   * subschema's traversal (e.g. an array index or property name).
   * Pass a JS expression; literal strings must be quoted.
   */
  segment?: string;
}

/**
 * Options for
 * {@link KeywordCompileContext.compileAndCallSubschema}.
 *
 * @public
 */
export interface CompileAndCallOptions {
  /** JS expression for the data to pass to the sub-validator. */
  data: string;
  /**
   * Emitted into the "sub passed" branch. Receives the per-branch
   * evaluated-keys var names when the enclosing scope tracks either;
   * `null` otherwise. Merge into the caller's `outProps` / `outItems`
   * here; annotations from failing branches are not merged per the
   * 2020-12 spec, so the helper only exposes them on the pass side.
   */
  onPass: (gen: CodeEmitter, branchProps: string | null, branchItems: string | null) => void;
  /**
   * Emitted into the "sub failed" branch. `errVar` is the name of the
   * local const holding the sub-validator's returned error in tree
   * mode, or `null` in predicate mode (which has nothing to pass).
   * Keywords that short-circuit on failure in predicate mode emit
   * `return false;` via the `gen` here; tree-mode keywords typically
   * push `errVar` into their own errors array.
   */
  onFail: (
    gen: CodeEmitter,
    errVar: string | null,
    branchProps: string | null,
    branchItems: string | null,
  ) => void;
}

/**
 * The narrow context passed to each keyword's `compile()` function. Keyword
 * authors see only these names: no reference to the compiler, the full
 * vocabulary, or the validator instance.
 *
 * @public
 */
export interface KeywordCompileContext {
  /** Handle for emitting source into the current validator function. */
  readonly gen: CodeEmitter;
  /** The keyword's own schema value (e.g. `"number"` for `type`). */
  readonly schema: unknown;
  /** The whole surrounding schema object (so cross-keyword peeks are possible). */
  readonly parentSchema: SchemaObject;
  /** JS expression referring to the data variable at this scope (e.g. `"data"`). */
  readonly data: string;
  /** JS expression referring to the current path array (e.g. `"path"`). */
  readonly path: string;
  /** JS expression referring to the error accumulator (e.g. `"errors"`). */
  readonly errors: string;
  /**
   * Compile a nested subschema to its own function and return the
   * function's identifier. The returned name is callable with
   * `(data, path)` inside generated code. Use this when a keyword
   * needs direct access to the function name; most composition-style
   * keywords are better served by
   * {@link KeywordCompileContext.compileAndCallSubschema}, which also
   * hides the predicate-vs-tree call-signature split.
   *
   * `mode` overrides the output shape of the compiled function. It
   * defaults to the enclosing function's mode. Pass `"predicate"` to
   * compile a branch whose result is consumed only as a boolean (its
   * function takes `(data)` and returns `boolean`); pass the enclosing
   * mode (or omit) for a branch whose errors are reported. See
   * {@link CompileMode}.
   */
  compileSubschema(schema: SchemaOrBoolean, mode?: CompileMode): string;
  /**
   * Compile a subschema and emit a call + pass/fail branch, abstracting
   * over the two call conventions:
   *
   * - Tree mode: `const ev = fn(data, path, bProps, bItems); if (ev === null) { onPass } else { onFail(ev) }`
   * - Predicate: `if (fn(data, bProps, bItems)) { onPass } else { onFail(null) }`
   *
   * When the enclosing scope tracks evaluated properties or items, the
   * helper allocates per-branch accumulator Sets and passes their names
   * to the callbacks so the caller can merge them into its own outputs
   * on the pass branch (the 2020-12 spec discards annotations from
   * failing branches). When no tracking is active, both callbacks see
   * `null` for the branch variables.
   *
   * The sub-validator is called once; what each branch does is
   * keyword-specific: composition keywords push the error into a
   * per-keyword errors array on fail, `not` emits a leaf on pass,
   * etc. The abstraction deliberately stops at the call shape.
   */
  compileAndCallSubschema(schema: SchemaOrBoolean, options: CompileAndCallOptions): void;
  /**
   * Resolve a `$ref` (absolute URI or fragment) to a compiled function
   * name. Used by `$ref` and `$dynamicRef` keywords.
   */
  resolveRef(ref: string): string;
  /**
   * `true` when `ref` is a recursion back-edge: its target schema is
   * still on the compile stack, so the emitted call closes a cycle.
   * The `$ref` / `$dynamicRef` keywords consult this to decide whether
   * to wrap the call in the {@link KeywordCompileContext.depthGated}
   * recursion-depth guard. Forward refs return `false`.
   */
  isRecursiveRef(ref: string): boolean;
  /** JS expression for the Set tracking evaluated properties, or `null`. */
  readonly evaluatedPropertiesVar: string | null;
  /** JS expression for the Set tracking evaluated items, or `null`. */
  readonly evaluatedItemsVar: string | null;
  /**
   * `true` when the runtime error-budget short-circuit is active (a
   * finite `maxErrors` was configured and the schema does not track
   * evaluated keys; see the note on the compiler's `CompileState.gated`).
   * Keyword authors usually don't need to read this directly; prefer
   * {@link KeywordCompileContext.emitError} /
   * {@link KeywordCompileContext.emitBudgetBreak} which inspect it.
   */
  readonly gated: boolean;
  /**
   * `true` when a finite `maxDepth` cap was configured. The `$ref` /
   * `$dynamicRef` keywords read this together with
   * {@link KeywordCompileContext.isRecursiveRef} to emit the
   * recursion-depth guard; other keywords don't need it.
   */
  readonly depthGated: boolean;
  /**
   * `true` when predicate mode is active: the compiled validator
   * returns `boolean` and constructs no error tree. Most keywords
   * don't need to read this directly: `emitError`,
   * `errorStatement`, `leafErrorExpr`, and `validateSubschema` all
   * do the right thing automatically. Composition-style keywords
   * that inspect a sub-validator's return value for their own
   * control flow (`allOf`, `anyOf`, `oneOf`, `not`, `if/then/else`,
   * `$ref`, `contains`, `discriminator`, `dependentSchemas`) must
   * branch on this flag; sub-validators in predicate mode return
   * `boolean`, not `ValidationError | null`, and don't take a
   * `path` argument.
   */
  readonly predicate: boolean;
  /**
   * `true` when flat-collection mode is active: the compiled validator
   * returns a flat `ValidationError[]` of leaves (no branch wrappers).
   * Like {@link KeywordCompileContext.predicate}, most keywords don't
   * read this: `emitError`/`errorStatement` append a sub-validator's
   * list automatically on a `"lift"`, and the inline-wrap step is
   * suppressed. The branch-*wrapping* composition keywords (`allOf`,
   * `anyOf`, `oneOf`) must branch on it: instead of collecting child
   * nodes and wrapping them, they append each failing branch's leaves
   * flat and emit a single childless marker leaf for the composition
   * keyword itself. Mutually exclusive with
   * {@link KeywordCompileContext.predicate}.
   */
  readonly flat: boolean;
  /**
   * `true` when the compile unit uses `unevaluatedProperties` /
   * `unevaluatedItems` anywhere, so functions thread evaluated-key
   * out-params. Composition keywords read this to gate the two-phase
   * (predicate-decision) optimization: predicate sub-validators don't
   * produce evaluated keys, so when tracking is on, branches whose
   * annotations must merge (`anyOf` / `oneOf` matches, the `if`
   * condition) keep the eager error-mode path instead. (`not` never
   * contributes evaluated keys, so it ignores this.)
   */
  readonly unevaluatedTracking: boolean;
  /**
   * Emit an error-push statement directly into the current code
   * generator. Pick the right `kind` based on where the error
   * expression came from:
   *
   * - `"leaf"`: freshly-minted leaf error, created in this call.
   *   Counts against the `maxErrors` budget when one is configured;
   *   short-circuits cleanly when the cap has been hit.
   * - `"lift"`: an already-counted error being propagated up the
   *   tree (a sub-validator's return value) or a branch wrapper
   *   around already-counted children (`createBranchError`). Always
   *   unconditional, never touches the budget counter.
   *
   * Using the wrong kind silently miscounts errors against the
   * budget, so think about it each time. TypeScript enforces that you
   * supply one of the two names; the intent of the choice is on you.
   */
  emitError(kind: ErrorKind, errExpr: string): void;
  /**
   * String form of {@link KeywordCompileContext.emitError}: returns
   * the statement instead of emitting it. Useful inside compound
   * source like a `switch` body, where the push appears inline in a
   * larger `gen.line(...)` call.
   */
  errorStatement(kind: ErrorKind, errExpr: string): string;
  /**
   * Flat-mode helper: a statement that appends the flat
   * `ValidationError[]` produced by `srcExpr` onto the accumulator
   * variable `destVar` (via `deps.appendErrors`, null-safe on both
   * sides). Used by the branch-wrapping composition keywords to buffer
   * per-branch leaves (`anyOf` / `oneOf`) before deciding whether to
   * commit or discard them. Only meaningful when
   * {@link KeywordCompileContext.flat} is `true`.
   */
  appendErrorsStatement(destVar: string, srcExpr: string): string;
  /**
   * Build a budget-guarded `break;` statement for use at the bottom of
   * hot loops (array items / property keys / applicator branches).
   * Returns `""` when uncapped so callers can emit it unconditionally.
   */
  budgetBreakStatement(): string;
  /**
   * Emit the statement from
   * {@link KeywordCompileContext.budgetBreakStatement} directly into
   * the current code generator. Useful at the tail of loops so they
   * short-circuit once the error cap is hit.
   */
  emitBudgetBreak(): void;
  /**
   * Emit validation for a subschema against `dataExpr`, writing any
   * errors into the current scope's accumulator. When `segment` is
   * provided, wraps the emission in a `path.push(seg) … path.pop()`
   * pair so the shared-mutable `path` array carries the extra segment
   * only for the duration of this subschema's traversal.
   *
   * When the subschema is simple enough (a boolean, or a single
   * validation keyword from a safe whitelist) the keyword's code is
   * inlined directly, avoiding the per-call function dispatch. For
   * anything more complex, it falls back to compiling the subschema
   * into a named function and emitting the usual call + lift. Either
   * way the path is reused, not re-allocated.
   *
   * This is the right helper for the common "descend into a
   * subschema and emit any errors" pattern, used by `properties`,
   * `items`, `additionalProperties`, etc. Composition keywords that
   * need the sub-validator's return value for their own logic
   * (`allOf`, `anyOf`, `oneOf`, …) should call
   * {@link KeywordCompileContext.compileSubschema} instead.
   */
  validateSubschema(
    schema: SchemaOrBoolean,
    dataExpr: string,
    options?: ValidateSubschemaOptions,
  ): void;
  /**
   * Pending path segments to splice as trailing args into
   * `createLeafError` / `createBranchError`. Populated by the
   * subschema inliner when it flattens a segmented
   * `validateSubschema` call into the enclosing function body:
   * instead of pre-materializing `[...path, seg]` for the inner
   * keyword contexts (which the runtime then re-snapshots, doubling
   * allocation), we leave `path` unchanged and let leaf keywords
   * splice segments as extra args.
   *
   * Most keywords don't need to read this directly: prefer
   * {@link KeywordCompileContext.leafErrorExpr} /
   * {@link KeywordCompileContext.branchErrorExpr}, which both
   * already consume it.
   */
  readonly pathSegments: readonly string[];
  /**
   * JS expression producing the effective path at runtime,
   * equivalent to `ctx.path` when `pathSegments` is empty, and to
   * `[...path, seg1, seg2, …]` otherwise. Prefer the error helpers
   * for error construction; reach for this only when a keyword
   * needs to pass the runtime path to something other than
   * `createLeafError` / `createBranchError` (e.g. a user-supplied
   * custom-keyword callback).
   */
  readonly effectivePathExpr: string;
  /**
   * Assemble a `deps.createLeafError(...)` call expression, splicing
   * any pending {@link KeywordCompileContext.pathSegments} plus the
   * caller's own `extraSegments` as trailing args. Up to two total
   * extras embed as explicit parameters (matching the runtime
   * signature); three or more fall back to eagerly materializing the
   * extended path at the call site (rare; pathologically nested
   * inlined subschemas).
   *
   * @param codeExpr - Pre-quoted JS expression for the error code
   *   (e.g. `quoteString("type")`).
   * @param messageExpr - JS expression for the message (literal or
   *   template string).
   * @param paramsExpr - JS expression for the `params` object, or
   *   `"{}"`.
   * @param extraSegments - Additional segments this keyword wants to
   *   append (e.g. a missing property name). Appended after any
   *   already-pending `pathSegments`.
   */
  leafErrorExpr(
    codeExpr: string,
    messageExpr: string,
    paramsExpr: string,
    extraSegments?: readonly string[],
  ): string;
  /**
   * Assemble a `deps.createBranchError(...)` call expression. Same
   * trailing-segment rules as {@link KeywordCompileContext.leafErrorExpr}.
   */
  branchErrorExpr(
    codeExpr: string,
    messageExpr: string,
    childrenExpr: string,
    paramsExpr?: string,
    extraSegments?: readonly string[],
  ): string;
  /**
   * Emit a `const <name> = <expr>;` declaration at the top of the
   * generated module (outside every validator function). Returns the
   * minted identifier so callers can reference the hoisted value from
   * their validator body.
   *
   * Use this for schema-derived constants that would otherwise be
   * allocated on every validate call: Sets of known property names,
   * required-name arrays, enum candidates. The hoisted value must be
   * immutable from the validator's perspective (the validator reads it;
   * nothing in the generated code mutates it).
   *
   * The optional `prefix` is used to name the identifier for easier
   * debugging of generated source. Defaults to `"C"`.
   */
  hoistConstant(expr: string, prefix?: string): string;
  /**
   * Compute a runtime value once per validator-function scope and share
   * it across keywords. Emits `const <name> = <expr>;` into the current
   * function body the first time a given `key` is seen, and returns the
   * same identifier for every later call with that `key` within the same
   * function. Use for values derived from the runtime `data` that more
   * than one keyword on the same schema needs: the object-shape guard
   * (`typeof data === "object" && …`) is the canonical case, shared by
   * `required` / `properties` / `additionalProperties` / etc.
   *
   * The sibling of {@link KeywordCompileContext.hoistConstant}: that one
   * lifts a compile-time-derived constant to module scope (runs once at
   * factory init); this one caches a per-call value inside the validator
   * body (runs once per `validate()`). Reach for `hoistConstant` when the
   * value depends only on the schema, `scopeLocal` when it depends on the
   * data.
   *
   * Call this at the keyword's top-level entry (before opening loops or
   * `if` blocks), so the emitted `const` dominates every sibling
   * keyword's code. The `expr` must be evaluable at that point (i.e.
   * rooted in the function's `data` parameter) and side-effect-free; it
   * is computed unconditionally, so a guard that would throw on the wrong
   * input type is not a valid `expr`.
   *
   * @param key - Stable cache key. Keywords that want to share a value
   *   must pass the same key (e.g. `` `isObject:${ctx.data}` ``).
   * @param expr - The JS expression to bind. Must match for a given key.
   * @param prefix - Identifier prefix for readable generated source.
   *   Defaults to `"L"`.
   */
  scopeLocal(key: string, expr: string, prefix?: string): string;
}

/**
 * What {@link KeywordDefinition.validateKeywordValue} is told about the
 * position it is checking. An object rather than positional arguments so
 * later additions do not change the signature.
 *
 * @public
 */
export interface KeywordValueContext {
  /** The keyword being checked, e.g. `"type"`. */
  keyword: string;
  /**
   * Dotted path to the keyword's value, relative to the compiled schema
   * (`"$defs.Amounts.type"`; `"type"` at the root). Points at the value
   * itself rather than the schema holding it, since the value is what is
   * wrong.
   */
  path: string;
  /**
   * The schema object holding the keyword. Present because a few
   * keywords' contracts genuinely depend on a sibling: OAS 3.0 `type`
   * reads `nullable`. Not an invitation to reach further; see the
   * caveat on {@link KeywordDefinition.validateKeywordValue}.
   */
  parentSchema: SchemaObject;
}

/**
 * Definition of a single schema keyword that plugs into a {@link Vocabulary}.
 *
 * @public
 */
export interface KeywordDefinition {
  /** The keyword name (e.g. `"type"`, `"properties"`). */
  keyword: string;
  /** The vocabulary URI this keyword belongs to. */
  vocabulary: string;
  /** Generate validation code for this keyword. */
  compile: (ctx: KeywordCompileContext) => void;
  /**
   * Check the schema-side value of this keyword before code generation.
   *
   * Return `undefined` to accept, or a short reason to reject. The
   * compiler supplies the keyword name and the schema path, so the
   * reason is the keyword-local half of the sentence:
   *
   * ```ts
   * validateKeywordValue: (value) =>
   *   Array.isArray(value) ? undefined : `requires an array; got ${typeof value}`,
   * // keyword "myKeyword" at "properties.a.myKeyword" requires an array; got string
   * ```
   *
   * This runs over every schema in the document, including subschemas
   * no `$ref` reaches, so a keyword defining it is checked even where
   * it is never compiled. Keep the same check in `compile` (or have
   * both call one shared parser): `compile` can be reached through
   * paths that did not go through the pre-pass, and a bare
   * `ctx.schema as T` cast is how `required: "id"` came to iterate as
   * the characters `"i"` and `"d"`.
   *
   * For keyword-local value contracts only. Anything needing to see an
   * ancestor, a sibling keyword, or the whole document belongs in a
   * lint pass, not here; this hook cannot see them, and a rule that
   * pretends otherwise will be wrong under `not` and inside dead
   * composition branches.
   */
  validateKeywordValue?: (value: unknown, context: KeywordValueContext) => string | undefined;
  /**
   * Reserved for declarative compile-time ordering. Currently unused;
   * keyword execution order comes from the vocabulary's `keywords`
   * array order (with `unevaluatedProperties` / `unevaluatedItems`
   * pushed to the tail). Author your vocabulary's array in the order
   * keywords should run; do not rely on this field.
   */
  dependsOn?: string[];
  /**
   * Names of keywords whose semantics this keyword subsumes. The
   * dispatcher treats them as already-handled when this keyword is
   * present, so the strict-mode unknown-key check doesn't flag them
   * and the per-keyword inliner doesn't emit duplicate code.
   *
   * Use when a custom keyword semantically replaces a built-in pair:
   * `discriminator` declares `implements: ["oneOf", "anyOf"]` because
   * its dispatch logic supersedes both; `if`/`then`/`else` declares
   * `implements: ["then", "else"]` so the partner keys aren't dispatched
   * a second time on their own; `contains` declares
   * `implements: ["minContains", "maxContains"]` so the bounds-only
   * keys are folded into the `contains` codegen.
   */
  implements?: string[];
  /**
   * Reserved for declarative compile-time ordering. Currently unused;
   * see {@link KeywordDefinition.dependsOn}. Set the vocabulary's
   * `keywords` array order instead.
   */
  before?: string;
  /**
   * Declares that this keyword contributes to evaluated-properties /
   * evaluated-items tracking, the bookkeeping `unevaluatedProperties`
   * and `unevaluatedItems` consume. Set the relevant sub-flag for any
   * keyword that "evaluates" object members or array positions
   * (`properties`, `patternProperties`, `items`, `contains`, …). A
   * missed flag silently breaks `unevaluated*` siblings, which will
   * then see members as unevaluated and reject valid data.
   */
  evaluates?: { properties?: boolean; items?: boolean };
  /**
   * When `true`, this keyword descends into subschemas (`items`,
   * `properties`, `allOf`, `not`, …). The flag drives the subschema
   * inliner to take the function-call path for multi-keyword schemas
   * containing this keyword. Setting it wrong is a silent
   * mis-optimization: a missed flag costs correctness (an inlined
   * applicator can skip the per-function evaluated-keys state) and
   * speed (V8 can't monomorphize a huge inlined body).
   */
  applicator?: boolean;
  /**
   * When `true`, declares this keyword to be pure annotation/metadata:
   * it emits no runtime validation code. Annotation keywords can coexist
   * with inlineable keywords without disqualifying the schema. Used by
   * the subschema inliner to decide which keys to skip when counting
   * "real" validation keywords. A keyword defining `annotation: true`
   * should also have an empty `compile`.
   */
  annotation?: boolean;
  /**
   * Short explanation when this keyword is only partially supported:
   * the compiler accepts and dispatches it, but the emitted validation
   * doesn't fully match the spec. Surfaced via the compile-time strict
   * mode (see {@link CompileOptions.schemaLint}) so users know they're
   * getting degraded semantics rather than a silent fallback.
   *
   * Example: `$dynamicRef` sets `partial` because the implementation
   * resolves statically against the anchor map rather than walking the
   * runtime dynamic scope.
   */
  partial?: string;
}

/**
 * A collection of keywords under a single vocabulary URI.
 *
 * @public
 */
export interface Vocabulary {
  /** Vocabulary URI (per JSON Schema spec). */
  uri: string;
  /**
   * Ordered list of keyword definitions. Read-only: the compiler and the
   * introspection cache rely on a stable vocabulary keyword order, and an
   * `as const` keyword array satisfies this directly.
   */
  keywords: readonly KeywordDefinition[];
}

/**
 * Keyword-dispatcher rules that vary between dialects. Fields go here
 * when a dialect difference can't be expressed as a keyword override
 * (i.e. it operates above the vocabulary level).
 *
 * @public
 */
export interface DialectRules {
  /**
   * OpenAPI 3.0 semantics: when a schema has `$ref`, every sibling
   * keyword is ignored. Default `false` (JSON Schema 2020-12 and
   * OpenAPI 3.1+ semantics, where siblings are honored).
   */
  refSuppressesSiblings: boolean;
}

/**
 * A compile-time dialect: a vocabulary stack plus the dispatcher rules
 * that make it coherent. Every call to `compileSchema` picks exactly
 * one dialect. The built-in dialects are {@link jsonSchemaDialect},
 * {@link openapi31Dialect}, and {@link oas30Dialect}.
 *
 * @public
 */
export interface Dialect {
  /** Short identifier for debugging / introspection (e.g. `"oas3.0"`). */
  readonly id: string;
  /** Vocabularies whose keywords are available during compile. */
  readonly vocabularies: readonly Vocabulary[];
  /** Keyword-dispatcher rules (currently just `refSuppressesSiblings`). */
  readonly rules: DialectRules;
}
