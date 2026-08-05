import { NAMES, quoteString } from "../codegen/index.js";
import type { DynamicRefTarget, KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VOCAB } from "./vocabulary-uris.js";

/**
 * Emit a recursive (`$ref` back-edge) call wrapped in the `maxDepth`
 * guard. `deps.depth` is incremented in the condition and decremented on
 * both branches, so it tracks the current nesting depth and unwinds with
 * the native stack. When the cap is exceeded the call is skipped (the
 * stack stops growing) and a `depth` leaf error stands in for the
 * subtree that wasn't validated.
 */
function compileGuardedRefCall(
  ctx: KeywordCompileContext,
  fn: string,
  passProps: string,
  passItems: string,
): void {
  const deps = NAMES.DEPS;
  const cond = `++${deps}.depth > ${deps}.maxDepth`;
  if (ctx.predicate) {
    ctx.gen.if(
      cond,
      (g) => {
        g.line(`${deps}.depth -= 1;`);
        g.line("return false;");
      },
      (g) => {
        const okVar = g.scope.name("refOk");
        g.const(okVar, `${fn}(${ctx.data}, ${passProps}, ${passItems})`);
        g.line(`${deps}.depth -= 1;`);
        g.line(`if (!${okVar}) return false;`);
      },
    );
    return;
  }
  const msgExpr = "`data nesting exceeds the configured maxDepth (${" + deps + ".maxDepth})`";
  const depthErr = ctx.leafErrorExpr(quoteString("depth"), msgExpr, `{ limit: ${deps}.maxDepth }`);
  ctx.gen.if(
    cond,
    (g) => {
      g.line(`${deps}.depth -= 1;`);
      ctx.emitError("leaf", depthErr);
    },
    (g) => {
      const errVar = g.scope.name("refErr");
      g.const(errVar, `${fn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
      g.line(`${deps}.depth -= 1;`);
      g.if(`${errVar} !== null`, () => ctx.emitError("lift", errVar));
    },
  );
}

/**
 * Emit the call for a `$dynamicRef` that binds at runtime.
 *
 * The callee is picked per call by walking the dynamic scope
 * outermost-first, so the same compiled function serves every call site
 * and the compiler's schema-identity cache is untouched.
 *
 * The depth guard goes on unconditionally when a `maxDepth` was
 * configured. `isRecursiveRef` asks whether one statically known target
 * is on the compile stack, and a site with several possible callees has
 * no such target. A guard that was not needed costs a counter
 * increment; a guard that was needed and missing is an uncaught
 * `RangeError`.
 */
function compileDynamicRefCall(ctx: KeywordCompileContext, target: DynamicRefTarget): void {
  // A Map, not an object. The keys are base URIs, which come from user
  // `$id` values, and a plain object would answer a lookup for
  // `constructor` (or any other inherited name) with something that is
  // not a validator, then call it.
  const table = ctx.hoistConstant(
    `new Map([${target.candidates
      .map(([base, fn]) => `[${quoteString(base)}, ${fn}]`)
      .join(", ")}])`,
    "DYN",
  );
  const fn = ctx.gen.scope.name("dynFn");
  ctx.gen.const(fn, `${ctx.dynamicLookupName}(${table}, ${target.fallback})`);

  const passProps = ctx.evaluatedPropertiesVar ?? "undefined";
  const passItems = ctx.evaluatedItemsVar ?? "undefined";
  if (ctx.depthGated) {
    compileGuardedRefCall(ctx, fn, passProps, passItems);
    return;
  }
  if (ctx.predicate) {
    ctx.gen.line(`if (!${fn}(${ctx.data}, ${passProps}, ${passItems})) return false;`);
    return;
  }
  const errVar = ctx.gen.scope.name("dynErr");
  ctx.gen.const(errVar, `${fn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
  ctx.gen.if(`${errVar} !== null`, () => ctx.emitError("lift", errVar));
}

function compileRefCall(ctx: KeywordCompileContext, ref: string): void {
  const fn = ctx.resolveRef(ref);
  // A $ref targets a single schema whose annotations (evaluated keys)
  // count toward the enclosing scope, so we thread the caller's
  // evaluated-key sets straight through.
  const passProps = ctx.evaluatedPropertiesVar ?? "undefined";
  const passItems = ctx.evaluatedItemsVar ?? "undefined";
  // Only recursive (cycle-closing) refs can grow the call stack without
  // bound, so the guard goes there and nowhere else; forward refs and
  // the uncapped default compile to a plain call.
  if (ctx.depthGated && ctx.isRecursiveRef(ref)) {
    compileGuardedRefCall(ctx, fn, passProps, passItems);
    return;
  }
  if (ctx.predicate) {
    ctx.gen.line(`if (!${fn}(${ctx.data}, ${passProps}, ${passItems})) return false;`);
    return;
  }
  const errVar = ctx.gen.scope.name("refErr");
  ctx.gen.const(errVar, `${fn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
  ctx.gen.if(`${errVar} !== null`, () => ctx.emitError("lift", errVar));
}

/**
 * The JSON Schema 2020-12 `$ref` keyword. Resolves the reference to another
 * schema and delegates validation to its compiled function.
 *
 * Circular references are handled by the compiler's schema-identity cache:
 * the function name is reserved before the body is generated, so a recursive
 * `$ref` back to the enclosing schema compiles to a normal recursive call.
 *
 * @public
 */
export const refKeyword: KeywordDefinition = {
  keyword: "$ref",
  vocabulary: CORE_VOCAB,
  compile(ctx) {
    const ref = ctx.schema as string;
    compileRefCall(ctx, ref);
  },
};

/**
 * The JSON Schema 2020-12 `$dynamicRef` keyword.
 *
 * A plain-name reference whose target declares the matching
 * `$dynamicAnchor` (the bookending requirement) binds to the
 * **outermost** declaration of that anchor in the current dynamic
 * scope, resolved per call at runtime. Everything else behaves exactly
 * like `$ref` and compiles through the same path: a pointer fragment, a
 * target that declares no matching `$dynamicAnchor`, a target that
 * carries only a plain `$anchor`, and any schema whose compile unit
 * does not use both `$dynamicRef` and `$dynamicAnchor`.
 *
 * `$dynamicRef` to an anchor with no declaration in scope falls back to
 * its static target, which is the same schema `$ref` would have reached.
 *
 * @remarks
 * The candidate anchors are the ones the resolver found in the root
 * schema and in `external`. A caller who supplies its own
 * `refResolver` reaching schemas outside both is resolving documents
 * the anchor scan never saw, and a `$dynamicAnchor` declared only in
 * one of those does not join the dynamic scope; such a `$dynamicRef`
 * binds to its static target.
 *
 * @public
 */
export const dynamicRefKeyword: KeywordDefinition = {
  keyword: "$dynamicRef",
  vocabulary: CORE_VOCAB,
  compile(ctx) {
    const ref = ctx.schema as string;
    const dynamic = ctx.resolveDynamicRef(ref);
    if (dynamic === null) {
      compileRefCall(ctx, ref);
      return;
    }
    compileDynamicRefCall(ctx, dynamic);
  },
};

/**
 * Declarative `$dynamicAnchor` keyword. Collected during resolution.
 *
 * No runtime code is emitted here. An anchor is registered by the
 * resource that declares it, so the compiler pushes the base URI at the
 * boundary rather than at the anchor; see the compiler's
 * `compileValidator`.
 *
 * @public
 */
export const dynamicAnchorKeyword: KeywordDefinition = {
  keyword: "$dynamicAnchor",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty: anchor is consumed at resolve time
  },
};

/**
 * Declarative `$anchor` keyword. Collected during resolution; no runtime
 * code is emitted.
 *
 * @public
 */
export const anchorKeyword: KeywordDefinition = {
  keyword: "$anchor",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty: anchor is consumed at resolve time
  },
};

/**
 * Declarative `$id` keyword. Collected during resolution; no runtime code
 * is emitted.
 *
 * @public
 */
export const idKeyword: KeywordDefinition = {
  keyword: "$id",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty
  },
};

/**
 * Declarative `$defs` keyword. Its value is a record of subschemas
 * reachable via `$ref`; no runtime code is emitted.
 *
 * @public
 */
export const defsKeyword: KeywordDefinition = {
  keyword: "$defs",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty: resolved on demand via $ref
  },
};

/**
 * Declarative `$schema` keyword. No runtime behavior.
 *
 * @public
 */
export const schemaDialectKeyword: KeywordDefinition = {
  keyword: "$schema",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty
  },
};

/**
 * Declarative `$comment` keyword. No runtime behavior.
 *
 * @public
 */
export const commentKeyword: KeywordDefinition = {
  keyword: "$comment",
  vocabulary: CORE_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty
  },
};
