import { Scope } from "./scope.js";

/**
 * Fresh-identifier generator surface. The only member custom-keyword
 * authors call on `ctx.gen.scope`.
 *
 * @public
 */
export interface NameGenerator {
  /** Mint a fresh identifier of the form `<prefix>N`, monotonically increasing per prefix. */
  name(prefix: string): string;
}

/**
 * The narrow code-emission surface a custom-keyword author sees via
 * {@link KeywordCompileContext.gen}. Defines the minimum API needed to
 * emit validator source without exposing the whole {@link CodeGen}
 * implementation.
 *
 * If you find yourself wanting a method that isn't here (e.g. `forIn`,
 * `forRange`), open an issue; the interface is intentionally small so
 * it's stable.
 *
 * @public
 */
export interface CodeEmitter {
  /** Shared name generator. */
  readonly scope: NameGenerator;
  /** Append a single line of source at the current indent level. */
  line(code: string): this;
  /** Emit an `if (cond) { then } else { else }` block. */
  if(cond: string, thenBody: (g: CodeEmitter) => void, elseBody?: (g: CodeEmitter) => void): this;
  /** Emit a `for (const name of expr) { ... }` loop. */
  forOf(name: string, expr: string, body: (g: CodeEmitter) => void): this;
  /** Emit a `for (const name in expr) { ... }` loop with a `hasOwn` guard. */
  forIn(name: string, expr: string, body: (g: CodeEmitter) => void): this;
  /** Emit a `for (let name = 0; name < limit; name += 1) { ... }` loop. */
  forRange(name: string, limit: string, body: (g: CodeEmitter) => void): this;
  /** Emit a `const name = expr;` declaration. */
  const(name: string, expr: string): this;
  /** Emit a `let name = expr;` declaration. */
  let(name: string, expr: string): this;
  /** Open an indentation level without emitting a brace pair. */
  indent(): this;
  /** Close an indentation level opened by {@link CodeEmitter.indent}. */
  dedent(): this;
}

/**
 * String-builder for generated JavaScript source. Each call appends a line (or
 * opens/closes a block) with automatic indentation.
 *
 * Used internally by the compiler. Custom-keyword authors interact with
 * the narrower {@link CodeEmitter} interface via `ctx.gen`.
 *
 * @internal
 */
export class CodeGen implements CodeEmitter {
  private readonly lines: string[] = [];
  private indentLevel = 0;
  /** Shared name generator. Keyword authors can request fresh identifiers here. */
  readonly scope: Scope = new Scope();

  /**
   * Append a single line of source at the current indent level.
   *
   * @param code - The source fragment (no trailing newline, no leading indent).
   * @returns `this`, for chaining.
   *
   * @example
   * ```ts
   * gen.line(`const n = 42;`);
   * ```
   */
  line(code: string): this {
    this.lines.push("  ".repeat(this.indentLevel) + code);
    return this;
  }

  /**
   * Append a blank line.
   *
   * @returns `this`, for chaining.
   */
  blank(): this {
    this.lines.push("");
    return this;
  }

  /**
   * Emit an `if (cond) { then } else { else }` block.
   *
   * @param cond - Condition expression.
   * @param thenBody - Callback populating the `then` branch.
   * @param elseBody - Optional callback populating the `else` branch.
   * @returns `this`, for chaining.
   *
   * @example
   * ```ts
   * gen.if("x > 0", (g) => g.line("return true;"));
   * ```
   */
  if(cond: string, thenBody: (g: CodeGen) => void, elseBody?: (g: CodeGen) => void): this {
    this.line(`if (${cond}) {`);
    this.indentLevel += 1;
    thenBody(this);
    this.indentLevel -= 1;
    if (elseBody) {
      this.line("} else {");
      this.indentLevel += 1;
      elseBody(this);
      this.indentLevel -= 1;
    }
    this.line("}");
    return this;
  }

  /**
   * Emit a `for (let name = 0; name < limit; name += 1) { ... }` loop.
   *
   * @param nameVar - Loop variable name.
   * @param limit - Upper bound expression.
   * @param body - Callback populating the loop body.
   * @returns `this`, for chaining.
   */
  forRange(nameVar: string, limit: string, body: (g: CodeGen) => void): this {
    this.line(`for (let ${nameVar} = 0; ${nameVar} < ${limit}; ${nameVar} += 1) {`);
    this.indentLevel += 1;
    body(this);
    this.indentLevel -= 1;
    this.line("}");
    return this;
  }

  /**
   * Emit a `for (const nameVar of expr) { ... }` loop.
   *
   * @param nameVar - Loop variable name.
   * @param expr - Iterable expression.
   * @param body - Callback populating the loop body.
   * @returns `this`, for chaining.
   */
  forOf(nameVar: string, expr: string, body: (g: CodeGen) => void): this {
    this.line(`for (const ${nameVar} of ${expr}) {`);
    this.indentLevel += 1;
    body(this);
    this.indentLevel -= 1;
    this.line("}");
    return this;
  }

  /**
   * Emit a `for (const nameVar in expr) { ... }` loop. Also emits the standard
   * `hasOwn` guard to skip inherited properties.
   *
   * @param nameVar - Loop variable name.
   * @param expr - Object expression.
   * @param body - Callback populating the guarded loop body.
   * @returns `this`, for chaining.
   */
  forIn(nameVar: string, expr: string, body: (g: CodeGen) => void): this {
    this.line(`for (const ${nameVar} in ${expr}) {`);
    this.indentLevel += 1;
    this.line(`if (!Object.prototype.hasOwnProperty.call(${expr}, ${nameVar})) continue;`);
    body(this);
    this.indentLevel -= 1;
    this.line("}");
    return this;
  }

  /**
   * Emit a `const name = expr;` declaration.
   *
   * @param name - Identifier to bind.
   * @param expr - Initializer expression.
   * @returns `this`, for chaining.
   */
  const(name: string, expr: string): this {
    return this.line(`const ${name} = ${expr};`);
  }

  /**
   * Emit a `let name = expr;` declaration.
   *
   * @param name - Identifier to bind.
   * @param expr - Initializer expression.
   * @returns `this`, for chaining.
   */
  let(name: string, expr: string): this {
    return this.line(`let ${name} = ${expr};`);
  }

  /**
   * Enter an indentation level without emitting a brace pair. Rarely
   * used; prefer {@link CodeGen.if} / {@link CodeGen.forRange} / etc.
   *
   * @returns `this`, for chaining.
   */
  indent(): this {
    this.indentLevel += 1;
    return this;
  }

  /**
   * Exit an indentation level opened by {@link CodeGen.indent}.
   *
   * @returns `this`, for chaining.
   */
  dedent(): this {
    this.indentLevel -= 1;
    return this;
  }

  /**
   * Produce the generated source as a single string.
   *
   * @returns The accumulated source with `\n` separators.
   */
  toString(): string {
    return this.lines.join("\n");
  }
}

/**
 * Quote an arbitrary string as a JavaScript string literal suitable for
 * embedding into generated source.
 *
 * @param value - The string to quote.
 * @returns A quoted literal (including surrounding `"`).
 *
 * @example
 * ```ts
 * quoteString('a"b\nc'); // '"a\\"b\\nc"'
 * ```
 *
 * @public
 */
export function quoteString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Coerce a schema-supplied finite number into a JavaScript numeric
 * literal that is safe to interpolate directly into generated source.
 * Throws at compile time on non-numbers, NaN, and infinities.
 *
 * Use this for any keyword whose value lands raw in a generated JS
 * expression (e.g. `${data} > ${limit}`). Interpolating
 * `ctx.schema` directly is a codegen-injection vector when the
 * schema is attacker-supplied; this helper closes that path by
 * validating the value first and returning a known-safe `String(n)`.
 *
 * @param value - The schema-supplied value (untrusted).
 * @param keyword - The schema keyword being compiled. Surfaced in the
 *   error message so callers know which schema position to fix.
 * @returns The value rendered as a numeric literal, e.g. `"5"` or `"-1.5"`.
 * @throws Error when `value` is not a finite number.
 *
 * @public
 */
export function numberLiteral(value: unknown, keyword: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`keyword "${keyword}" requires a finite number; got ${describeValue(value)}`);
  }
  return String(value);
}

/**
 * Like {@link numberLiteral}, but additionally requires a non-negative
 * integer. Used for `maxLength`, `minItems`, `maxProperties`, etc.
 *
 * @param value - The schema-supplied value (untrusted).
 * @param keyword - The schema keyword being compiled.
 * @returns The value rendered as a numeric literal.
 * @throws Error if `value` is not an integer >= 0.
 *
 * @public
 */
export function nonNegativeIntegerLiteral(value: unknown, keyword: string): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `keyword "${keyword}" requires a non-negative integer; got ${describeValue(value)}`,
    );
  }
  return String(value);
}

/**
 * Like {@link numberLiteral}, but additionally requires a strictly positive
 * value. Used for `multipleOf`, where zero would mean "every number is a
 * multiple of zero" (vacuous, and triggers a division by zero in the
 * generated check).
 *
 * @param value - The schema-supplied value (untrusted).
 * @param keyword - The schema keyword being compiled.
 * @returns The value rendered as a numeric literal.
 * @throws Error if `value` is not a finite number > 0.
 *
 * @public
 */
export function positiveNumberLiteral(value: unknown, keyword: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `keyword "${keyword}" requires a finite positive number; got ${describeValue(value)}`,
    );
  }
  return String(value);
}

/**
 * Coerce a schema-supplied boolean into a JavaScript boolean literal
 * (`"true"` or `"false"`) safe to interpolate into generated source.
 *
 * @param value - The schema-supplied value (untrusted).
 * @param keyword - The schema keyword being compiled.
 * @returns `"true"` or `"false"`.
 * @throws Error if `value` is not a boolean.
 *
 * @public
 */
export function booleanLiteral(value: unknown, keyword: string): string {
  if (typeof value !== "boolean") {
    throw new Error(`keyword "${keyword}" requires a boolean; got ${describeValue(value)}`);
  }
  return value ? "true" : "false";
}

/**
 * Validate a schema-supplied array-of-strings keyword value (`required`,
 * `enum`-adjacent name lists) before a keyword iterates it.
 *
 * The failure this prevents is quiet rather than loud. A bare string
 * passes an unchecked `as string[]` cast and then iterates as its own
 * characters: `required: "id"` becomes a demand for properties `"i"`
 * and `"d"`, so the payload the author meant to accept is rejected and
 * one they never imagined is not. Unlike a keyword that rejects
 * everything, nothing about the running system looks wrong.
 *
 * @param value - The schema-supplied value (untrusted).
 * @param keyword - The schema keyword being compiled, named in the error.
 * @returns The value as a string array.
 * @throws Error when `value` is not an array, or holds a non-string.
 *
 * @public
 */
export function stringArrayValue(value: unknown, keyword: string): string[] {
  const reason = checkStringArray(value);
  if (reason !== undefined) throw new Error(`keyword "${keyword}" ${reason}`);
  return value as string[];
}

/**
 * Non-throwing half of {@link stringArrayValue}, for
 * `KeywordDefinition.validateKeywordValue`. Returns the reason a value
 * is unusable, or `undefined` when it is fine. Both halves go through
 * this one check so the whole-graph pre-pass and codegen cannot drift
 * on what a keyword accepts.
 *
 * @public
 */
export function checkStringArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return `requires an array of strings; got ${describeValue(value)}`;
  }
  const badAt = value.findIndex((v) => typeof v !== "string");
  if (badAt !== -1) {
    return `requires an array of strings; element ${badAt} is ${describeValue(value[badAt])}`;
  }
  return undefined;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return `number ${String(value)}`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Emit a JavaScript expression that produces a new path array consisting of a
 * runtime base path plus some extra segments.
 *
 * @param baseExpr - JS expression that evaluates to the base path array.
 * @param segments - Static segments to append. Strings become quoted literals;
 *                   numbers embed as-is; expressions wrapped with
 *                   {@link rawExpr} embed verbatim.
 * @returns A JS expression like `[...path, "foo", i0]`.
 *
 * @example
 * ```ts
 * pathJoinExpr("path", ["foo", rawExpr("i0")]); // '[...path, "foo", i0]'
 * ```
 *
 * @public
 */
export function pathJoinExpr(baseExpr: string, segments: PathSegmentLike[]): string {
  if (segments.length === 0) return baseExpr;
  const parts = segments.map(renderSegment);
  return `[...${baseExpr}, ${parts.join(", ")}]`;
}

/**
 * Wrapper that marks a string as a raw JS expression rather than a literal
 * path segment. Used by {@link pathJoinExpr}.
 *
 * @param expr - The raw JavaScript expression.
 * @returns A tagged object recognized by path helpers.
 *
 * @example
 * ```ts
 * rawExpr("i0"); // produces { raw: "i0" }
 * ```
 *
 * @public
 */
export function rawExpr(expr: string): RawExpression {
  return { raw: expr };
}

/**
 * A raw JavaScript expression used in place of a literal path segment.
 *
 * @public
 */
export interface RawExpression {
  raw: string;
}

/**
 * Something acceptable as a path segment during codegen: a literal string or
 * number, or a raw expression created with {@link rawExpr}.
 *
 * @public
 */
export type PathSegmentLike = string | number | RawExpression;

function renderSegment(segment: PathSegmentLike): string {
  if (typeof segment === "string") return quoteString(segment);
  if (typeof segment === "number") return String(segment);
  return segment.raw;
}
