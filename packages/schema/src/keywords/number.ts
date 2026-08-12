import { numberLiteral, positiveNumberLiteral, quoteString } from "../codegen/index.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB } from "./vocabulary-uris.js";

/**
 * Ceiling on the `multipleOf` tolerance, in units of `q`. A quarter unit
 * is about ten orders of magnitude above the worst drift a legitimate
 * multiple produces (~2.9e-11, from `16384.3 / 0.1`) and well below the
 * half unit at which a tolerance would accept any value at all.
 */
const MAX_TOLERANCE = 0.25;

function numberGuard(dataExpr: string): string {
  return `typeof ${dataExpr} === "number" && Number.isFinite(${dataExpr})`;
}

function emitNumericError(
  ctx: KeywordCompileContext,
  code: string,
  message: string,
  paramsObj: string,
): void {
  ctx.emitError("leaf", ctx.leafErrorExpr(quoteString(code), message, paramsObj));
}

/**
 * The JSON Schema `multipleOf` keyword. Data must be divisible by the schema
 * value (without floating-point remainder).
 *
 * The check compares `data / divisor` against its nearest integer with a
 * relative epsilon so valid multiples aren't rejected when the division
 * produces a non-terminating binary fraction. IEEE-754 rounding error
 * grows roughly with magnitude, so a flat tolerance is wrong at both
 * ends: a value like `143.48 / 0.01` drifts by about `1.82e-12`, while
 * values near `1` stay within `1e-14`. Scaling by `16 * Number.EPSILON *
 * max(1, |q|, |divisor|)` gives each multiple of `divisor` the same
 * proportional slack without letting true non-multiples sneak through.
 *
 * Two bounds keep that scaling from swallowing the top of the range:
 *
 * - The tolerance is capped at `MAX_TOLERANCE`. Unbounded, it reaches a
 *   whole unit of `q` around `|q| > 1.4e14` and then admits anything:
 *   `1e15` against `multipleOf: 3` lands `0.3125` away from an integer
 *   under a tolerance of `3.55`. Measured drift across real divisors
 *   peaks around `2.9e-11`, so the cap sits far above any legitimate
 *   case and far below one unit.
 * - A non-finite `q` falls back to a remainder test. `data` is finite
 *   (the guard says so), but a small enough divisor overflows the
 *   division, and `Infinity - Infinity` is `NaN`, which compares `false`
 *   against every tolerance. That silently admitted `1e308` against
 *   `multipleOf: 0.123456789` (the official draft2020-12 case under
 *   "float division = inf"). `%` is exact fmod and cannot overflow, so
 *   it answers this end of the range directly. Rejecting outright would
 *   be wrong: `1e308` against `multipleOf: 0.5` overflows the same way
 *   and is a genuine multiple, which the optional `float-overflow.json`
 *   case asserts.
 *
 * @public
 */
export const multipleOfKeyword: KeywordDefinition = {
  keyword: "multipleOf",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const divisor = positiveNumberLiteral(ctx.schema, "multipleOf");
    const q = ctx.gen.scope.name("q");
    const tol = ctx.gen.scope.name("tol");
    // 16 * Number.EPSILON ~= 3.55e-15. The `divisor` factor keeps the
    // tolerance proportional when the spec uses tiny divisors (e.g. 1e-7);
    // MAX_TOLERANCE stops the |q| factor from growing past a quarter unit.
    const tolExpr =
      `Math.min(16 * Number.EPSILON * Math.max(1, Math.abs(${q}), Math.abs(${divisor})), ` +
      `${MAX_TOLERANCE})`;
    ctx.gen.if(numberGuard(ctx.data), () => {
      ctx.gen.const(q, `${ctx.data} / ${divisor}`);
      ctx.gen.const(tol, tolExpr);
      ctx.gen.if(
        `Number.isFinite(${q}) ` +
          `? Math.abs(${q} - Math.round(${q})) > ${tol} ` +
          `: ${ctx.data} % ${divisor} !== 0`,
        () => {
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("multipleOf"),
              `\`must be a multiple of ${divisor}\``,
              `{ multipleOf: ${divisor}, actual: ${ctx.data} }`,
            ),
          );
        },
      );
    });
  },
};

/**
 * The JSON Schema `maximum` keyword. Data must be <= the schema value.
 *
 * @public
 */
export const maximumKeyword: KeywordDefinition = {
  keyword: "maximum",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "maximum");
    ctx.gen.if(`${numberGuard(ctx.data)} && ${ctx.data} > ${limit}`, () => {
      emitNumericError(
        ctx,
        "maximum",
        `\`must be <= ${limit}\``,
        `{ maximum: ${limit}, actual: ${ctx.data} }`,
      );
    });
  },
};

/**
 * The JSON Schema `exclusiveMaximum` keyword. Data must be < the schema value.
 *
 * @public
 */
export const exclusiveMaximumKeyword: KeywordDefinition = {
  keyword: "exclusiveMaximum",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "exclusiveMaximum");
    ctx.gen.if(`${numberGuard(ctx.data)} && ${ctx.data} >= ${limit}`, () => {
      emitNumericError(
        ctx,
        "exclusiveMaximum",
        `\`must be < ${limit}\``,
        `{ exclusiveMaximum: ${limit}, actual: ${ctx.data} }`,
      );
    });
  },
};

/**
 * The JSON Schema `minimum` keyword. Data must be >= the schema value.
 *
 * @public
 */
export const minimumKeyword: KeywordDefinition = {
  keyword: "minimum",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "minimum");
    ctx.gen.if(`${numberGuard(ctx.data)} && ${ctx.data} < ${limit}`, () => {
      emitNumericError(
        ctx,
        "minimum",
        `\`must be >= ${limit}\``,
        `{ minimum: ${limit}, actual: ${ctx.data} }`,
      );
    });
  },
};

/**
 * The JSON Schema `exclusiveMinimum` keyword. Data must be > the schema value.
 *
 * @public
 */
export const exclusiveMinimumKeyword: KeywordDefinition = {
  keyword: "exclusiveMinimum",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "exclusiveMinimum");
    ctx.gen.if(`${numberGuard(ctx.data)} && ${ctx.data} <= ${limit}`, () => {
      emitNumericError(
        ctx,
        "exclusiveMinimum",
        `\`must be > ${limit}\``,
        `{ exclusiveMinimum: ${limit}, actual: ${ctx.data} }`,
      );
    });
  },
};
