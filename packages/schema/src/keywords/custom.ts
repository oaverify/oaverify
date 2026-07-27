import { NAMES, quoteString } from "../codegen/index.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";

/**
 * Vocabulary URI for user-registered keywords. Not a published JSON
 * Schema vocabulary; just a local tag that keeps custom entries
 * alongside the built-in ones in the keyword registry. It is an
 * identifier, not a fetchable document, so nothing resolves it; the
 * repository URL is used because that is a namespace this project
 * demonstrably controls.
 *
 * @public
 */
export const customKeywordVocabulary = "https://github.com/oaverify/oaverify/vocab/custom-keywords";

/**
 * Failure detail a {@link CustomKeywordValidator} may return to customize
 * the emitted {@link import("@oaverify/internal-core").ValidationError}. Omitted fields
 * take sensible defaults: `message` becomes
 * `"value failed custom keyword \"<name>\""`; `params` defaults to `{}`.
 *
 * @public
 */
export interface CustomKeywordFailure {
  message?: string;
  params?: Record<string, unknown>;
}

/**
 * A user-supplied validator invoked whenever its associated keyword
 * appears in a schema.
 *
 * - Return `true` for a valid value.
 * - Return `false` to emit a generic failure error for that keyword.
 * - Return a {@link CustomKeywordFailure} object to customize the error
 *   `message` and/or `params`.
 *
 * The `schemaValue` argument is the JSON value the keyword carries in
 * the schema. Since schemas are JSON, `schemaValue` is always
 * JSON-serialisable; callers may close over precomputed values (e.g. a
 * compiled regex) at registration time if per-validation work should be
 * avoided.
 *
 * @public
 */
export type CustomKeywordValidator = (
  data: unknown,
  schemaValue: unknown,
  path: readonly (string | number)[],
) => boolean | CustomKeywordFailure;

/**
 * Build a {@link KeywordDefinition} for a user-registered keyword name.
 * The generated code calls into the per-validator
 * `deps.customKeywords` map, so a single compiled validator dispatches
 * all custom keywords through one uniform shim.
 *
 * @internal
 */
export function createCustomKeywordDefinition(keyword: string): KeywordDefinition {
  const keywordLit = quoteString(keyword);
  const defaultMessage = quoteString(`value failed custom keyword "${keyword}"`);
  return {
    keyword,
    vocabulary: customKeywordVocabulary,
    compile(ctx: KeywordCompileContext): void {
      const schemaValueJson = JSON.stringify(ctx.schema);
      const resultVar = ctx.gen.scope.name("custom");
      ctx.gen.line(
        `const ${resultVar} = ${NAMES.DEPS}.customKeywords.get(${keywordLit})(${ctx.data}, ${schemaValueJson}, ${ctx.effectivePathExpr});`,
      );
      ctx.gen.if(`${resultVar} !== true`, () => {
        const messageVar = ctx.gen.scope.name("customMsg");
        const paramsVar = ctx.gen.scope.name("customParams");
        ctx.gen.line(
          `const ${messageVar} = (${resultVar} && typeof ${resultVar} === "object" && typeof ${resultVar}.message === "string") ? ${resultVar}.message : ${defaultMessage};`,
        );
        ctx.gen.line(
          `const ${paramsVar} = (${resultVar} && typeof ${resultVar} === "object" && ${resultVar}.params && typeof ${resultVar}.params === "object") ? ${resultVar}.params : {};`,
        );
        ctx.emitError("leaf", ctx.leafErrorExpr(keywordLit, messageVar, paramsVar));
      });
    },
  };
}
