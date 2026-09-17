import {
  checkNonNegativeInteger,
  NAMES,
  nonNegativeIntegerLiteral,
  quoteString,
} from "../codegen/index.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB } from "./vocabulary-uris.js";

/**
 * The JSON Schema `maxItems` keyword. Array data must have at most N items.
 *
 * @public
 */
export const maxItemsKeyword: KeywordDefinition = {
  keyword: "maxItems",
  validateKeywordValue: checkNonNegativeInteger,
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "maxItems");
    ctx.gen.if(`Array.isArray(${ctx.data}) && ${ctx.data}.length > ${limit}`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("maxItems"),
          `\`must have at most ${limit} items\``,
          `{ maxItems: ${limit}, actual: ${ctx.data}.length }`,
        ),
      );
    });
  },
};

/**
 * The JSON Schema `minItems` keyword. Array data must have at least N items.
 *
 * @public
 */
export const minItemsKeyword: KeywordDefinition = {
  keyword: "minItems",
  validateKeywordValue: checkNonNegativeInteger,
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "minItems");
    ctx.gen.if(`Array.isArray(${ctx.data}) && ${ctx.data}.length < ${limit}`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("minItems"),
          `\`must have at least ${limit} items\``,
          `{ minItems: ${limit}, actual: ${ctx.data}.length }`,
        ),
      );
    });
  },
};

/**
 * The JSON Schema `uniqueItems` keyword. When set to `true`, every array
 * item must be pairwise not-deep-equal.
 *
 * @public
 */
export const uniqueItemsKeyword: KeywordDefinition = {
  keyword: "uniqueItems",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    if (ctx.schema !== true) return;
    const dup = ctx.gen.scope.name("dup");
    ctx.gen.if(`Array.isArray(${ctx.data})`, (g) => {
      // Runtime helper does one Map-backed scan for primitives plus a
      // pairwise deepEqual sweep of object/array items. Replaces the
      // previous inline O(N^2) nested loop; generated code stays tiny
      // and V8 gets to monomorphize the hot helper.
      g.const(dup, `${NAMES.DEPS}.findDuplicate(${ctx.data})`);
      g.if(`${dup} !== null`, () => {
        // Duplicate indices live in params.duplicates; keep the
        // message as a baked literal to avoid per-error template
        // concatenation.
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("uniqueItems"),
            `"must have unique items"`,
            `{ duplicates: [${dup}.a, ${dup}.b] }`,
          ),
        );
      });
    });
  },
};

/**
 * The JSON Schema `minContains` keyword. Sets the minimum number of array
 * items that must match `contains`; the minimum defaults to 1 when omitted.
 *
 * This definition requires a non-negative integer, even when `contains` is
 * absent, and emits no validation code. Select it alongside
 * {@link containsKeyword} when composing a custom dialect; that keyword
 * emits the match-count assertion. Without `contains`, a valid bound has
 * no effect on instance validation.
 *
 * @public
 */
export const minContainsKeyword: KeywordDefinition = {
  keyword: "minContains",
  annotation: true,
  vocabulary: CORE_VALIDATION_VOCAB,
  validateKeywordValue: checkNonNegativeInteger,
  compile(): void {},
};

/**
 * The JSON Schema `maxContains` keyword. Sets the maximum number of array
 * items that may match `contains`; there is no maximum when omitted.
 *
 * This definition requires a non-negative integer, even when `contains` is
 * absent, and emits no validation code. Select it alongside
 * {@link containsKeyword} when composing a custom dialect; that keyword
 * emits the match-count assertion. Without `contains`, a valid bound has
 * no effect on instance validation.
 *
 * @public
 */
export const maxContainsKeyword: KeywordDefinition = {
  keyword: "maxContains",
  annotation: true,
  vocabulary: CORE_VALIDATION_VOCAB,
  validateKeywordValue: checkNonNegativeInteger,
  compile(): void {},
};
