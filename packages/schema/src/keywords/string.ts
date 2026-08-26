import { NAMES, nonNegativeIntegerLiteral, quoteString } from "../codegen/index.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB, FORMAT_ASSERTION_VOCAB, FORMAT_VOCAB } from "./vocabulary-uris.js";

/**
 * The JSON Schema `maxLength` keyword. String data must have at most N
 * (UTF-16 code-unit-safe) characters.
 *
 * @public
 */
export const maxLengthKeyword: KeywordDefinition = {
  keyword: "maxLength",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "maxLength");
    // Condition short-circuits on `.length`; valid strings inside the
    // bound never walk. The `actual` in the error params keeps the
    // exact code-point count (cold path, only built when the error fires).
    const condExpr = `${NAMES.DEPS}.exceedsMaxCodePoints(${ctx.data}, ${limit})`;
    const actualExpr = codePointLengthExpr(ctx.data);
    ctx.gen.if(`typeof ${ctx.data} === "string" && ${condExpr}`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("maxLength"),
          `\`must have at most ${limit} characters\``,
          `{ maxLength: ${limit}, actual: ${actualExpr} }`,
        ),
      );
    });
  },
};

/**
 * The JSON Schema `minLength` keyword. String data must have at least N
 * characters.
 *
 * @public
 */
export const minLengthKeyword: KeywordDefinition = {
  keyword: "minLength",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "minLength");
    // Condition short-circuits on `.length`; the `actual` in the error
    // params keeps the exact code-point count (cold path).
    const condExpr = `${NAMES.DEPS}.belowMinCodePoints(${ctx.data}, ${limit})`;
    const actualExpr = codePointLengthExpr(ctx.data);
    ctx.gen.if(`typeof ${ctx.data} === "string" && ${condExpr}`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("minLength"),
          `\`must have at least ${limit} characters\``,
          `{ minLength: ${limit}, actual: ${actualExpr} }`,
        ),
      );
    });
  },
};

/**
 * The JSON Schema `pattern` keyword. String data must match the ECMA-262
 * regex given as the schema value.
 *
 * @public
 */
export const patternKeyword: KeywordDefinition = {
  keyword: "pattern",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const source = ctx.schema as string;
    const patternLit = quoteString(source);
    const patternVar = ctx.hoistConstant(`${NAMES.DEPS}.compilePattern(${patternLit})`, "pattern");
    ctx.gen.if(`typeof ${ctx.data} === "string" && !${patternVar}.test(${ctx.data})`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("pattern"),
          `\`must match pattern ${escapeMessage(source)}\``,
          `{ pattern: ${patternLit}, actual: ${ctx.data} }`,
        ),
      );
    });
  },
};

/**
 * The JSON Schema 2020-12 `format` keyword, annotation-only mode. Matches
 * the spec default: `format` is a structural hint, not an assertion. Use
 * {@link formatAssertionKeyword} (or the OpenAPI validator) to actually
 * reject malformed strings.
 *
 * @public
 */
export const formatKeyword: KeywordDefinition = {
  keyword: "format",
  vocabulary: FORMAT_VOCAB,
  compile(): void {
    // format-annotation mode: emit no runtime check.
  },
};

/**
 * The JSON Schema 2020-12 `format` keyword, assertion mode. When a
 * validator is registered for the named format, the value must pass it.
 * Callers activate this by including {@link formatAssertionVocabulary}
 * ahead of {@link formatVocabulary}.
 *
 * A format constrains one JSON type. String formats (`date-time`,
 * `uuid`) are asserted on strings, numeric ones (`int32`, `int64`) on
 * numbers, and a value of any other type is a no-op, per JSON Schema
 * 2020-12 §7. So is a format name nothing is registered under, and so
 * is one registered as `false`.
 *
 * Which guard is emitted comes from the format's declared type at
 * compile time, so a site costs one `typeof` test either way. A string
 * format also carries a comparison against
 * {@link CompileOptions.maxFormatLength}, and a numeric one does not,
 * because a number has no length. Setting that cap to `Infinity` emits
 * the guard this keyword produced before #960, byte for byte.
 *
 * @public
 */
export const formatAssertionKeyword: KeywordDefinition = {
  keyword: "format",
  vocabulary: FORMAT_ASSERTION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const formatName = ctx.schema as string;
    // `false` registers the name and asserts nothing, so there is no
    // guard to emit. Unregistered names still emit the string guard:
    // `emitStandalone` compiles with a registry it does not run with,
    // and a name absent at compile time may be present at run time.
    // See `KeywordCompileContext.formatTypeOf`.
    const declaredType = ctx.formatTypeOf(formatName);
    if (declaredType === "none") return;
    const jsType = declaredType === "number" ? "number" : "string";

    const formatLit = quoteString(formatName);
    // Hoisted to module scope: the Map lookup runs once when the
    // factory binds deps, not per validate() call (or per element when
    // inlined in an items loop). Consequence: formats must be
    // registered before compileSchema returns, which the `formats`
    // option guarantees; mutating deps.formats afterwards is not
    // observed. Same lifecycle as the hoisted deps.compilePattern.
    // Reaching `.validate` here rather than per call is why the tagged
    // registry costs nothing on the hot path.
    const fnVar = ctx.hoistConstant(`${NAMES.DEPS}.formats.get(${formatLit})?.validate`, "fmt");
    // Above `maxFormatLength` a string format is not asserted, and the
    // value is accepted. Several format grammars are `(?:X{4})*` over an
    // unbounded matching run, which pushes a frame onto V8's regex
    // backtrack stack per iteration and throws `RangeError` out of
    // `validate()` on a long enough *valid* value (#960). Skipping is the
    // permissive answer and the specified one: `format` is annotation-only
    // by default in 2020-12, so a value too large to check safely falls
    // back to exactly that rather than being called invalid on no evidence.
    //
    // Numeric formats have no length, so they never carry the guard, and an
    // `Infinity` cap emits nothing at all: codegen stays byte-identical to
    // the uncapped path.
    const lengthGuard =
      jsType === "string" && Number.isFinite(ctx.maxFormatLength)
        ? ` && ${ctx.data}.length <= ${ctx.maxFormatLength}`
        : "";
    ctx.gen.if(
      `typeof ${ctx.data} === "${jsType}"${lengthGuard} && ${fnVar} !== undefined && !${fnVar}(${ctx.data})`,
      () => {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("format"),
            `\`must match format ${escapeMessage(formatName)}\``,
            `{ format: ${formatLit}, actual: ${ctx.data} }`,
          ),
        );
      },
    );
  },
};

/**
 * Emit an expression that returns the Unicode code-point count of a string.
 * JSON Schema 2020-12 §6.3 specifies that `minLength` / `maxLength` count
 * code points, so surrogate pairs (emoji, astral CJK, ...) count as one.
 * Delegates to the `countCodePoints` runtime helper, which iterates without
 * allocating an intermediate array; `[...s].length` would spike memory on
 * large strings before the length check could reject them.
 */
function codePointLengthExpr(dataExpr: string): string {
  return `${NAMES.DEPS}.countCodePoints(${dataExpr})`;
}

function escapeMessage(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
