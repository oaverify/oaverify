import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { NAMES, pathJoinExpr, rawExpr, type CodeGen } from "../codegen/index.js";
import type {
  CompileAndCallOptions,
  CompileMode,
  DynamicRefTarget,
  ErrorKind,
  FormatKind,
  KeywordCompileContext,
  KeywordDefinition,
  ValidateSubschemaOptions,
} from "./types.js";

const EMPTY_PATH_SEGMENTS: readonly string[] = Object.freeze([]);
const EMPTY_FORMAT_TYPES: ReadonlyMap<string, FormatKind> = new Map<string, FormatKind>();

/**
 * Inputs accepted by {@link createKeywordContext}. The compiler assembles
 * these from its own state; keyword authors never construct them directly.
 *
 * @public
 */
export interface KeywordContextInputs {
  gen: CodeGen;
  schema: unknown;
  parentSchema: SchemaObject;
  data: string;
  path: string;
  errors: string;
  /**
   * Extra path segments that the inliner has accumulated without
   * materializing them into `path`. See
   * {@link KeywordCompileContext.pathSegments}. Defaults to empty.
   */
  pathSegments?: readonly string[];
  compileSubschema: (schema: SchemaOrBoolean, mode?: CompileMode) => string;
  resolveRef: (ref: string) => string;
  /**
   * Whether a `$ref` is a recursion back-edge (its target is still on
   * the compile stack). Defaults to always-`false` when omitted. Used by
   * the `$ref` keyword to decide whether to emit the `maxDepth` guard.
   */
  isRecursiveRef?: (ref: string) => boolean;
  /**
   * Whether a `$dynamicRef` binds at runtime, and to what. Defaults to
   * always-`null` (static, `$ref` behaviour) when omitted, which is
   * what a compile unit without dynamic scoping wants.
   */
  resolveDynamicRef?: (ref: string) => DynamicRefTarget | null;
  /** Generated-source name of the dynamic scope array. */
  dynamicScopeName?: string;
  /** Generated-source name of the dynamic scope lookup helper. */
  dynamicLookupName?: string;
  evaluatedPropertiesVar?: string | null;
  evaluatedItemsVar?: string | null;
  /**
   * When `true`, a finite `maxErrors` was configured and push / loop
   * sites should emit the extra budget checks. When `false`, emit plain
   * `errors.push(x)` / unchecked loops; zero runtime overhead.
   */
  gated?: boolean;
  /**
   * When `true`, a finite `maxDepth` was configured and the `$ref`
   * keyword should emit the recursion-depth guard at back-edges. When
   * `false` (the default), refs compile to a plain call.
   */
  depthGated?: boolean;
  /**
   * When `true`, predicate mode is active: the generated function
   * returns `boolean`, not `ValidationError | null`. Every
   * error-emission site collapses to `return false;` and the
   * error-expression argument is discarded.
   */
  predicate?: boolean;
  /**
   * When `true`, flat-collection mode is active: each generated function
   * returns a flat `ValidationError[]` of leaves (no branch wrappers)
   * instead of a single tree node. Lift sites append the callee's list
   * onto the accumulator (`deps.appendErrors`) rather than pushing one
   * node, and the inline-wrap step is suppressed. Mutually exclusive
   * with {@link KeywordContextInputs.predicate}.
   */
  flat?: boolean;
  /**
   * Whether the compile unit uses `unevaluated*` (functions thread
   * evaluated-key out-params). Defaults to `false`. Gates the
   * predicate-decision optimization in composition keywords. See
   * {@link KeywordCompileContext.unevaluatedTracking}.
   */
  unevaluatedTracking?: boolean;
  /**
   * The compiler's full keyword registry. Used by
   * {@link KeywordCompileContext.validateSubschema} to inline a
   * subschema's single keyword directly instead of compiling it to a
   * fresh function. Optional: when omitted, subschema emission always
   * takes the function-call path.
   */
  byKeyword?: ReadonlyMap<string, KeywordDefinition>;
  /**
   * What each registered `format` name constrains. See
   * {@link KeywordCompileContext.formatTypeOf}. Defaults to empty, so a
   * context built without it treats every format as a string one, which
   * is what `format` did before numeric formats existed.
   */
  formatTypes?: ReadonlyMap<string, FormatKind>;
  /**
   * Depth counter for recursive multi-keyword inlining. Callers never
   * set this directly; the context threads it through
   * {@link KeywordCompileContext.validateSubschema} so deeply-nested
   * inline chains eventually fall back to the function-call path
   * rather than blowing up the compiled source.
   */
  inlineDepth?: number;
  /**
   * Callback for hoisting a schema-derived constant out of the
   * validator body to the module-level prelude. See
   * {@link KeywordCompileContext.hoistConstant}.
   */
  hoistConstant?: (expr: string, prefix?: string) => string;
  /**
   * Per-function-body memo backing
   * {@link KeywordCompileContext.scopeLocal}. The compiler creates one
   * map per validator function and threads the same instance into every
   * keyword context for that function, so keywords sharing a key reuse a
   * single emitted `const`. Omitted in inline contexts, where each
   * keyword emits its own local (no cross-keyword sharing needed).
   */
  scopeLocals?: Map<string, string>;
}

/**
 * Construct a {@link KeywordCompileContext} from compiler-supplied inputs.
 *
 * @param inputs - Compiler state + keyword's own schema slice.
 * @returns A narrow, read-only context that keyword compile functions see.
 *
 * @example
 * ```ts
 * const ctx = createKeywordContext({ gen, schema: "number", parentSchema: ... });
 * typeKeyword.compile(ctx);
 * ```
 *
 * @public
 */
/**
 * Keywords that produce at most one error per application and have no
 * nested subschemas. When a subschema contains exactly one of these
 * keywords and nothing else that can emit errors, we can emit its
 * validation code inline in the enclosing function instead of
 * compiling it to a separate function, saving the per-call dispatch
 * cost and, more importantly, the eager `[...path, seg]` allocation
 * that function boundaries force.
 *
 * @internal
 */
const INLINEABLE_SINGLE_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

/**
 * Keys that force us to the function-call path regardless of the
 * {@link KeywordDefinition.applicator} flag. These are keywords whose
 * correctness depends on per-function state that the inline path
 * cannot supply:
 *
 * - `$ref` / `$dynamicRef` need a named function for cycle handling;
 *   bringing them into the inline body would lose the compiled-for
 *   cache that breaks cycles.
 *
 * The unevaluated-keys keywords (`unevaluatedProperties`,
 * `unevaluatedItems`) also need per-function state, but they are
 * already tagged `applicator: true` so the applicator check below
 * catches them; no need to list them here.
 */
const INLINE_DISQUALIFIERS = new Set(["$ref", "$dynamicRef"]);

/**
 * Applicator-keyword names not backed by their own {@link KeywordDefinition}
 * but which the inliner must still treat as applicators. `if` owns
 * `then` / `else` via the `implements` list; a schema that mentions
 * them in isolation (without `if`) should still fall back to the
 * function-call path rather than being treated as empty.
 */
const STANDALONE_APPLICATOR_FALLBACKS = new Set(["then", "else"]);

function isApplicatorKey(
  byKeyword: ReadonlyMap<string, KeywordDefinition> | undefined,
  k: string,
): boolean {
  if (byKeyword === undefined) return false;
  if (byKeyword.get(k)?.applicator === true) return true;
  return STANDALONE_APPLICATOR_FALLBACKS.has(k);
}

/**
 * Ceiling on how deep a chain of multi-keyword inlinings we'll follow
 * before falling back to function-call compilation. Protects against
 * pathologically self-referential schemas and bounds code bloat.
 */
const MAX_INLINE_DEPTH = 6;

/**
 * Above this many non-informational keys, a subschema's contribution
 * to the caller's inline body is judged too large; compile it as a
 * function instead.
 */
const MAX_INLINE_KEYWORDS = 10;

export function createKeywordContext(inputs: KeywordContextInputs): KeywordCompileContext {
  const evaluatedPropertiesVar = inputs.evaluatedPropertiesVar ?? null;
  const evaluatedItemsVar = inputs.evaluatedItemsVar ?? null;
  const gated = inputs.gated ?? false;
  const depthGated = inputs.depthGated ?? false;
  const predicate = inputs.predicate ?? false;
  const flat = inputs.flat ?? false;
  const unevaluatedTracking = inputs.unevaluatedTracking ?? false;
  const formatTypes = inputs.formatTypes ?? EMPTY_FORMAT_TYPES;
  const formatTypeOf = (name: string): FormatKind => formatTypes.get(name) ?? "string";
  const isRecursiveRef = inputs.isRecursiveRef ?? ((): boolean => false);
  const resolveDynamicRef = inputs.resolveDynamicRef ?? ((): DynamicRefTarget | null => null);
  const pathSegments = inputs.pathSegments ?? EMPTY_PATH_SEGMENTS;
  const effectivePathExpr =
    pathSegments.length === 0
      ? inputs.path
      : pathJoinExpr(
          inputs.path,
          pathSegments.map((s) => rawExpr(s)),
        );
  // Fall back to a local-scope const when no compiler-provided hoist sink
  // is threaded in (for tests or out-of-tree callers that build a
  // context directly). In that case the "hoisted" value just lives in
  // the current validator body; correct but not optimized.
  let localHoistCounter = 0;
  const hoistConstant =
    inputs.hoistConstant ??
    ((expr: string, prefix = "C"): string => {
      const name = `${prefix}_local${localHoistCounter}`;
      localHoistCounter += 1;
      inputs.gen.const(name, expr);
      return name;
    });

  // Per-function-body shared local: emit `const <name> = <expr>;` once
  // per key, hand back the same identifier on repeat calls. When no
  // shared memo is threaded in (inline contexts, tests), fall back to a
  // fresh local each call: still computed once at the emission point,
  // just not shared across keywords.
  const scopeLocal = (key: string, expr: string, prefix = "L"): string => {
    const sink = inputs.scopeLocals;
    const cached = sink?.get(key);
    if (cached !== undefined) return cached;
    const name = inputs.gen.scope.name(prefix);
    inputs.gen.const(name, expr);
    sink?.set(key, name);
    return name;
  };

  const errorStatement = (kind: ErrorKind, errExpr: string): string => {
    if (predicate) {
      // Predicate mode: we don't construct an error tree, so any
      // error-emission site just short-circuits. The `errExpr` is
      // intentionally discarded; its `ctx.path` / `createLeafError`
      // references never reach the generated source.
      void kind;
      void errExpr;
      return "return false;";
    }
    if (kind === "leaf") return emitPushStatement(inputs.errors, errExpr, gated, flat);
    // kind === "lift": already-counted sub-validator result being
    // propagated. Never interacts with the budget. In flat mode the
    // callee returns a `ValidationError[]` (its leaves), so the lift
    // appends that list onto the accumulator; in tree mode it returns a
    // single node, pushed as one child.
    if (flat) {
      const append = appendErrorsStatement(inputs.errors, errExpr);
      if (!gated) return append;
      // Gated flat mode: a callee that drained the budget already
      // returned early from its own frame; bail from this frame too so
      // the unwind reaches the top instead of running the remaining
      // keywords one frame up. Braced so the compound stays a single
      // block statement at unbraced `if (e !== null) ...` call sites.
      //
      // The bail can fire between a validateSubschema push/pop pair,
      // leaving the shared path array one segment long. Unobservable
      // today: every frame on the unwind bails before touching the
      // path again, error paths were copied at creation, and the
      // top-level validate() hands each call a fresh array. Keep that
      // invariant in mind before adding code that reads the mutable
      // path after a lifted fast-return.
      return (
        `{ ${append} if (${NAMES.DEPS}.errorsRemaining <= 0) { ` +
        `${NAMES.DEPS}.truncated = true; return ${inputs.errors}; } }`
      );
    }
    return `(${inputs.errors} ??= []).push(${errExpr});`;
  };
  // Append a flat `ValidationError[]` expression onto an accumulator
  // variable via the runtime helper. Used for flat-mode lifts and for
  // the per-branch buffers in `anyOf` / `oneOf`. The helper is null-safe
  // on both arguments, so `destVar` may start as `null`.
  const appendErrorsStatement = (destVar: string, srcExpr: string): string =>
    `${destVar} = ${NAMES.DEPS}.appendErrors(${destVar}, ${srcExpr});`;
  const emitError = (kind: ErrorKind, errExpr: string): void => {
    inputs.gen.line(errorStatement(kind, errExpr));
  };
  const budgetBreakStatement = (): string =>
    // Predicate mode never fills an error budget; its loops short-
    // circuit with `return false;` directly. Returning `""` keeps
    // existing `emitBudgetBreak()` callers a no-op. Gated flat mode
    // needs no loop breaks either: every push and lift site returns
    // from the function the moment the budget drains, so a loop head
    // can never observe an exhausted budget; skipping the check saves
    // a deps load + compare per iteration on the valid path.
    predicate || !gated || flat
      ? ""
      : `if (${NAMES.DEPS}.errorsRemaining <= 0) { ${NAMES.DEPS}.truncated = true; break; }`;
  const emitBudgetBreak = (): void => {
    const stmt = budgetBreakStatement();
    if (stmt !== "") inputs.gen.line(stmt);
  };

  // Assemble a `deps.createLeafError(...)` / `createBranchError(...)`
  // call. Up to two trailing segments embed as explicit parameters,
  // matching the runtime signature; three-plus fall back to eagerly
  // materializing `[...path, ...segs]` at the call site (rare:
  // pathologically nested inlined subschemas, capped by
  // MAX_INLINE_DEPTH).
  const assembleErrorExpr = (
    fnName: string,
    fixedArgs: (pathExpr: string) => string,
    allSegs: readonly string[],
  ): string => {
    if (allSegs.length === 0) {
      return `${NAMES.DEPS}.${fnName}(${fixedArgs(inputs.path)})`;
    }
    if (allSegs.length <= 2) {
      return `${NAMES.DEPS}.${fnName}(${fixedArgs(inputs.path)}, ${allSegs.join(", ")})`;
    }
    const materialized = pathJoinExpr(
      inputs.path,
      allSegs.map((s) => rawExpr(s)),
    );
    return `${NAMES.DEPS}.${fnName}(${fixedArgs(materialized)})`;
  };
  const concatSegs = (extras: readonly string[]): readonly string[] =>
    extras.length === 0
      ? pathSegments
      : pathSegments.length === 0
        ? extras
        : [...pathSegments, ...extras];
  const leafErrorExpr = (
    codeExpr: string,
    messageExpr: string,
    paramsExpr: string,
    extraSegments: readonly string[] = EMPTY_PATH_SEGMENTS,
  ): string =>
    assembleErrorExpr(
      "createLeafError",
      (pathExpr: string) => `${codeExpr}, ${pathExpr}, ${messageExpr}, ${paramsExpr}`,
      concatSegs(extraSegments),
    );
  const branchErrorExpr = (
    codeExpr: string,
    messageExpr: string,
    childrenExpr: string,
    paramsExpr: string = "{}",
    extraSegments: readonly string[] = EMPTY_PATH_SEGMENTS,
  ): string =>
    assembleErrorExpr(
      "createBranchError",
      (pathExpr: string) =>
        `${codeExpr}, ${pathExpr}, ${messageExpr}, ${childrenExpr}, ${paramsExpr}`,
      concatSegs(extraSegments),
    );

  const inlineDepth = inputs.inlineDepth ?? 0;

  /**
   * Try to inline a subschema's keywords directly into the current
   * function body. Returns `true` iff the inline path was taken;
   * callers fall back to compiling a named function on `false`.
   *
   * Three classes of inline:
   * - Empty / pure-metadata schema → no-op.
   * - Single-keyword from the safe whitelist → one keyword's code
   *   emitted directly. Tree shape preserved (keyword emits at most
   *   one error).
   * - Multi-keyword without $ref and under the size/depth ceilings →
   *   emit every keyword's code, then (if >1 error actually fired)
   *   wrap the new errors in a "schema" branch to match the tree
   *   shape of the would-be function's `wrapErrors` return value.
   */
  const tryInline = (
    schema: SchemaObject,
    dataExpr: string,
    innerPathSegments?: readonly string[],
  ): boolean => {
    const innerSegments = innerPathSegments ?? pathSegments;
    if (inputs.byKeyword === undefined) return false;
    const allKeys = Object.keys(schema);
    const validationKeys: string[] = [];
    for (const k of allKeys) {
      // Annotation keywords (title, description, $comment, etc.) are
      // registered with `annotation: true` and emit no code; safe to
      // skip. Unknown keys fall through to `validationKeys` so the
      // inliner conservatively refuses to inline them, which matches
      // the old behavior for pre-`annotation`-flag unknowns.
      if (inputs.byKeyword.get(k)?.annotation === true) continue;
      if (INLINE_DISQUALIFIERS.has(k)) return false;
      validationKeys.push(k);
    }
    if (validationKeys.length === 0) return true; // empty-ish schema; nothing to emit

    // Single-keyword: simplest case, whitelist match, no wrapping needed.
    if (validationKeys.length === 1) {
      const k = validationKeys[0]!;
      if (!INLINEABLE_SINGLE_KEYWORDS.has(k)) return false;
      const kw = inputs.byKeyword.get(k);
      if (kw === undefined) return false;
      const innerCtx = createKeywordContext({
        gen: inputs.gen,
        schema: (schema as Record<string, unknown>)[k],
        parentSchema: schema,
        data: dataExpr,
        path: inputs.path,
        pathSegments: innerSegments,
        errors: inputs.errors,
        compileSubschema: inputs.compileSubschema,
        resolveRef: inputs.resolveRef,
        evaluatedPropertiesVar: null,
        evaluatedItemsVar: null,
        gated,
        predicate,
        flat,
        byKeyword: inputs.byKeyword,
        formatTypes,
        inlineDepth: inlineDepth + 1,
        hoistConstant: inputs.hoistConstant,
      });
      kw.compile(innerCtx);
      return true;
    }

    // Multi-keyword inline is limited to pure-leaf combinations
    // (type + required + bounds, etc.). Schemas that contain any
    // applicator are left to the function-call path; the per-call
    // dispatch pays for itself on hot loops because V8 monomorphizes
    // the function better than it can optimize a massive inlined
    // loop body.
    if (validationKeys.some((k) => isApplicatorKey(inputs.byKeyword, k))) return false;
    if (validationKeys.length > MAX_INLINE_KEYWORDS) return false;
    if (inlineDepth >= MAX_INLINE_DEPTH) return false;

    // Snapshot the errors array length; if >1 new error fires, wrap
    // the new ones in a "schema" branch so the tree shape matches a
    // named function's `wrapErrors` output. Predicate mode skips the
    // snapshot/wrap entirely; inlined keywords return `false` on
    // failure so there's nothing to wrap.
    // Flat mode never wraps: inlined keywords push their leaves straight
    // onto the accumulator, so there is nothing to snapshot or collapse.
    // Predicate mode short-circuits on failure, so likewise nothing to
    // wrap. Skipping the snapshot here also skips the wrap block below.
    const startVar = predicate || flat ? null : inputs.gen.scope.name("_start");
    // errors may be null (lazy allocation). Treat null as length-0 for
    // the snapshot; the wrap check below also guards against null.
    if (startVar !== null)
      inputs.gen.const(startVar, `${inputs.errors} === null ? 0 : ${inputs.errors}.length`);

    // Keyword ordering mirrors the compiler's top-level dispatch: run
    // validation keywords first (leaf checks) in their defined vocab
    // order, then applicators, then unevaluated; this matches what
    // `compileSchemaKeywords` does for function-compiled subschemas.
    const present = new Set(validationKeys);
    const runOrder: string[] = [];
    for (const [name] of inputs.byKeyword) {
      if (present.has(name)) runOrder.push(name);
    }

    const seen = new Set<string>();
    for (const kwName of runOrder) {
      if (seen.has(kwName)) continue;
      const kw = inputs.byKeyword.get(kwName);
      if (kw === undefined) continue;
      seen.add(kwName);
      // Skip keywords this keyword implements, as the main compile loop does.
      const kwDef = kw as { compile: (ctx: KeywordCompileContext) => void; implements?: string[] };
      if (kwDef.implements) for (const impl of kwDef.implements) seen.add(impl);
      const innerCtx = createKeywordContext({
        gen: inputs.gen,
        schema: (schema as Record<string, unknown>)[kwName],
        parentSchema: schema,
        data: dataExpr,
        path: inputs.path,
        pathSegments: innerSegments,
        errors: inputs.errors,
        compileSubschema: inputs.compileSubschema,
        resolveRef: inputs.resolveRef,
        evaluatedPropertiesVar: null,
        evaluatedItemsVar: null,
        gated,
        predicate,
        flat,
        byKeyword: inputs.byKeyword,
        formatTypes,
        inlineDepth: inlineDepth + 1,
        hoistConstant: inputs.hoistConstant,
      });
      kw.compile(innerCtx);
    }

    // Wrap if >1 new error actually fired; error-tree mode only.
    // errors may still be null here if no keyword pushed anything (or
    // only the budget got exhausted without pushing); the null-check
    // short-circuits the wrap.
    if (startVar !== null) {
      const wrappedVar = inputs.gen.scope.name("_wrapped");
      // The wrap expression lives at the same extended path as its
      // leaf children; use the inner-scope segments directly (not
      // the outer ctx's `pathSegments`, which is what the public
      // helpers would concat).
      // Always include the empty `params` slot so the runtime
      // helper correctly sees any trailing segments in the
      // `extraSegment` / `extraSegment2` positions.
      const wrapExpr = assembleErrorExpr(
        "createBranchError",
        (pathExpr: string) =>
          `"schema", ${pathExpr}, "schema validation failed", ${wrappedVar}, {}`,
        innerSegments,
      );
      inputs.gen.if(
        `${inputs.errors} !== null && ${inputs.errors}.length - ${startVar} > 1`,
        () => {
          inputs.gen.const(wrappedVar, `${inputs.errors}.splice(${startVar})`);
          inputs.gen.line(`${inputs.errors}.push(${wrapExpr});`);
        },
      );
    }

    return true;
  };

  const validateSubschema = (
    schema: SchemaOrBoolean,
    dataExpr: string,
    options?: ValidateSubschemaOptions,
  ): void => {
    const segment = options?.segment;
    // Inline path threads `pathSegments` through the inner keyword
    // contexts: leaves splice the segments as trailing
    // createLeafError args, avoiding the pre-materialized
    // `[...path, seg]` double-allocation. Function-call fallback
    // keeps the classic push/pop-then-call shape because the callee
    // reads the (mutated) shared array directly.
    if (schema === true) return;
    if (schema === false) {
      if (predicate) {
        inputs.gen.line("return false;");
        return;
      }
      // `leafErrorExpr` picks up the ctx's pending pathSegments plus
      // the subschema's own segment (if any) automatically.
      const falseErr = leafErrorExpr(
        '"false"',
        '"schema is false, nothing is valid"',
        "{}",
        segment !== undefined ? [segment] : EMPTY_PATH_SEGMENTS,
      );
      emitError("leaf", falseErr);
      return;
    }
    const innerSegments =
      segment === undefined
        ? pathSegments
        : pathSegments.length === 0
          ? [segment]
          : [...pathSegments, segment];
    if (tryInline(schema, dataExpr, innerSegments)) return;
    // Function-call fallback: push/pop around the call so the callee
    // sees the extended path via the shared array (no per-call
    // allocation just to pass a path).
    const fn = inputs.compileSubschema(schema);
    if (predicate) {
      inputs.gen.line(`if (!${fn}(${dataExpr})) return false;`);
      return;
    }
    if (segment !== undefined) {
      inputs.gen.line(`${inputs.path}.push(${segment});`);
    }
    const errVar = inputs.gen.scope.name("e");
    inputs.gen.const(errVar, `${fn}(${dataExpr}, ${inputs.path})`);
    inputs.gen.if(`${errVar} !== null`, () => {
      emitError("lift", errVar);
    });
    if (segment !== undefined) {
      inputs.gen.line(`${inputs.path}.pop();`);
    }
  };

  const compileAndCallSubschema = (
    schema: SchemaOrBoolean,
    options: CompileAndCallOptions,
  ): void => {
    const fn = inputs.compileSubschema(schema);
    // When the enclosing scope tracks evaluated props or items, each
    // call gets its own branch-local Set so annotations from a failing
    // branch don't leak into the caller. When tracking is off for both,
    // we can skip the branch vars entirely; the sub-validator's trailing
    // params default to `undefined`.
    const needBranchVars = evaluatedPropertiesVar !== null || evaluatedItemsVar !== null;
    const branchProps = needBranchVars ? inputs.gen.scope.name("bProps") : null;
    const branchItems = needBranchVars ? inputs.gen.scope.name("bItems") : null;
    if (branchProps !== null && branchItems !== null) {
      inputs.gen.const(branchProps, evaluatedPropertiesVar !== null ? "new Set()" : "undefined");
      inputs.gen.const(branchItems, evaluatedItemsVar !== null ? "new Set()" : "undefined");
    }
    const trailingArgs = needBranchVars ? `, ${branchProps!}, ${branchItems!}` : "";
    if (predicate) {
      inputs.gen.if(
        `${fn}(${options.data}${trailingArgs})`,
        (g) => options.onPass(g, branchProps, branchItems),
        (g) => options.onFail(g, null, branchProps, branchItems),
      );
      return;
    }
    const errVar = inputs.gen.scope.name("e");
    inputs.gen.const(errVar, `${fn}(${options.data}, ${inputs.path}${trailingArgs})`);
    inputs.gen.if(
      `${errVar} === null`,
      (g) => options.onPass(g, branchProps, branchItems),
      (g) => options.onFail(g, errVar, branchProps, branchItems),
    );
  };

  return {
    gen: inputs.gen,
    schema: inputs.schema,
    parentSchema: inputs.parentSchema,
    // Replaced by the compiler, which owns the `implements` bookkeeping;
    // a no-op for anyone building a context directly.
    declineImplements: () => {},
    data: inputs.data,
    path: inputs.path,
    pathSegments,
    effectivePathExpr,
    errors: inputs.errors,
    compileSubschema: inputs.compileSubschema,
    compileAndCallSubschema,
    resolveRef: inputs.resolveRef,
    isRecursiveRef,
    resolveDynamicRef,
    dynamicScopeName: inputs.dynamicScopeName ?? "dynScope",
    dynamicLookupName: inputs.dynamicLookupName ?? "dynLookup",
    evaluatedPropertiesVar,
    evaluatedItemsVar,
    gated,
    depthGated,
    predicate,
    flat,
    unevaluatedTracking,
    formatTypeOf,
    errorStatement,
    emitError,
    appendErrorsStatement,
    budgetBreakStatement,
    emitBudgetBreak,
    leafErrorExpr,
    branchErrorExpr,
    validateSubschema,
    hoistConstant,
    scopeLocal,
  };
}

/**
 * Build a JS statement that pushes a single {@link ValidationError}
 * expression into the errors accumulator, optionally honoring the
 * `maxErrors` budget when `gated` is `true`. Callers of this helper
 * pass it to {@link CodeGen.line} or embed it into a generated block.
 *
 * With `flatReturn` (gated flat mode), draining the budget returns the
 * accumulator from the enclosing function immediately: `truncated`
 * means "the cap was reached; the list may be incomplete", so there is
 * nothing left to do once the cap is hit, and skipping the remaining
 * keyword checks is what makes `maxErrors: 1` a true fast-fail
 * (matching ajv's `allErrors: false`). Tree mode keeps the
 * keep-walking form: its early return would have to route through
 * `wrapErrors` and would change the tree shape of pending inline
 * wraps, so it stays drop-and-continue.
 *
 * @internal
 */
export function emitPushStatement(
  errorsVar: string,
  errExpr: string,
  gated: boolean,
  flatReturn = false,
): string {
  if (!gated) return `(${errorsVar} ??= []).push(${errExpr});`;
  if (!flatReturn) {
    return (
      `if (${NAMES.DEPS}.errorsRemaining > 0) { (${errorsVar} ??= []).push(${errExpr}); ${NAMES.DEPS}.errorsRemaining -= 1; }` +
      ` else { ${NAMES.DEPS}.truncated = true; }`
    );
  }
  return (
    `if (${NAMES.DEPS}.errorsRemaining > 0) { (${errorsVar} ??= []).push(${errExpr}); ` +
    `if ((${NAMES.DEPS}.errorsRemaining -= 1) === 0) { ${NAMES.DEPS}.truncated = true; return ${errorsVar}; } }` +
    ` else { ${NAMES.DEPS}.truncated = true; return ${errorsVar}; }`
  );
}
