import { nonNegativeIntegerLiteral, quoteString } from "../codegen/index.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { APPLICATOR_VOCAB } from "./vocabulary-uris.js";

/**
 * The `prefixItems` keyword. Validates the first N items of an array against
 * a tuple of subschemas.
 *
 * @public
 */
export const prefixItemsKeyword: KeywordDefinition = {
  keyword: "prefixItems",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const schemas = ctx.schema as SchemaOrBoolean[];
    if (schemas.length === 0) return;
    ctx.gen.if(`Array.isArray(${ctx.data})`, (g) => {
      // Hoist `data.length` once: the per-position validateSubschema
      // calls are opaque to V8, which would otherwise reload the length
      // on every tuple-position comparison.
      const len = g.scope.name("len");
      g.const(len, `${ctx.data}.length`);
      schemas.forEach((sub, i) => {
        g.if(`${len} > ${i}`, (gi) => {
          ctx.validateSubschema(sub, `${ctx.data}[${i}]`, { segment: String(i) });
          if (ctx.evaluatedItemsVar !== null) {
            gi.line(`${ctx.evaluatedItemsVar}.add(${i});`);
          }
        });
      });
    });
  },
  evaluates: { items: true },
};

/**
 * The `items` keyword. Validates every array item AFTER the prefixItems
 * window (or every item if no prefixItems).
 *
 * @public
 */
export const itemsKeyword: KeywordDefinition = {
  keyword: "items",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const subSchema = ctx.schema as SchemaOrBoolean;
    const prefixLen = ctx.parentSchema.prefixItems?.length ?? 0;
    const start = prefixLen;
    ctx.gen.if(`Array.isArray(${ctx.data})`, (g) => {
      const i = g.scope.name("i");
      // Hoist the length: the per-item validateSubschema call is opaque
      // to V8, so `data.length` in the loop condition would reload each
      // iteration. Item validation never resizes the array.
      const len = g.scope.name("len");
      g.const(len, `${ctx.data}.length`);
      g.line(`for (let ${i} = ${start}; ${i} < ${len}; ${i} += 1) {`);
      g.indent();
      if (subSchema === true) {
        if (ctx.evaluatedItemsVar !== null) {
          g.line(`${ctx.evaluatedItemsVar}.add(${i});`);
        }
      } else if (subSchema === false) {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(quoteString("items"), `"no additional items allowed"`, `{}`, [i]),
        );
      } else {
        ctx.validateSubschema(subSchema, `${ctx.data}[${i}]`, { segment: i });
        if (ctx.evaluatedItemsVar !== null) {
          g.line(`${ctx.evaluatedItemsVar}.add(${i});`);
        }
      }
      ctx.emitBudgetBreak();
      g.dedent();
      g.line(`}`);
    });
  },
  evaluates: { items: true },
};

/**
 * The `contains` keyword. The array must have at least `minContains`
 * (default 1) and at most `maxContains` items matching the subschema.
 *
 * Dispatches for `minContains` and `maxContains` are suppressed; this
 * keyword handles them.
 *
 * @public
 */
export const containsKeyword: KeywordDefinition = {
  keyword: "contains",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  implements: ["minContains", "maxContains"],
  compile(ctx: KeywordCompileContext): void {
    const subSchema = ctx.schema as SchemaOrBoolean;
    // `contains` only reports its own count failure; the per-item match
    // errors are never surfaced. Test membership with a predicate sub in
    // every mode so failing items allocate no error tree and (critically)
    // never decrement the shared `maxErrors` budget. Running the sub in
    // error mode would consume the budget on thrown-away item errors and
    // could starve a real sibling error, flipping a verdict under a cap.
    const predFn = ctx.compileSubschema(subSchema, "predicate");
    const minLit =
      ctx.parentSchema.minContains === undefined
        ? "1"
        : nonNegativeIntegerLiteral(ctx.parentSchema.minContains, "minContains");
    const min = Number(minLit);
    const maxLit =
      ctx.parentSchema.maxContains === undefined
        ? null
        : nonNegativeIntegerLiteral(ctx.parentSchema.maxContains, "maxContains");
    ctx.gen.if(`Array.isArray(${ctx.data})`, (g) => {
      const count = g.scope.name("count");
      g.let(count, "0");
      const i = g.scope.name("i");
      // Hoist the length once for whichever loop runs below; the
      // sub-validator call in the body is opaque to V8.
      const len = g.scope.name("len");
      g.const(len, `${ctx.data}.length`);
      if (ctx.predicate) {
        // Predicate mode: count passing items via the sub-validator's
        // boolean return; no path, no error array. The match list
        // exists only to populate `evaluatedItems` for any sibling
        // `unevaluatedItems`.
        g.forRange(i, len, (gi) => {
          gi.if(`${predFn}(${ctx.data}[${i}])`, (gii) => {
            gii.line(`${count} += 1;`);
            if (ctx.evaluatedItemsVar !== null) {
              gii.line(`${ctx.evaluatedItemsVar}.add(${i});`);
            }
          });
        });
        if (min > 0) g.line(`if (${count} < ${minLit}) return false;`);
        if (maxLit !== null) g.line(`if (${count} > ${maxLit}) return false;`);
        return;
      }
      g.forRange(i, len, (gi) => {
        gi.if(`${predFn}(${ctx.data}[${i}])`, (gii) => {
          gii.line(`${count} += 1;`);
          if (ctx.evaluatedItemsVar !== null) {
            gii.line(`${ctx.evaluatedItemsVar}.add(${i});`);
          }
        });
      });
      if (min > 0) {
        g.if(`${count} < ${minLit}`, () => {
          // actual count lives in params.actual; dropping it from the
          // message turns the emitted string into a constant literal.
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("contains"),
              `\`must contain at least ${minLit} matching item(s)\``,
              `{ minContains: ${minLit}, actual: ${count} }`,
            ),
          );
        });
      }
      if (maxLit !== null) {
        g.if(`${count} > ${maxLit}`, () => {
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("maxContains"),
              `\`must contain at most ${maxLit} matching item(s)\``,
              `{ maxContains: ${maxLit}, actual: ${count} }`,
            ),
          );
        });
      }
    });
  },
  evaluates: { items: true },
};
