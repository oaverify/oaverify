/**
 * Tiny tokenizer for the JSONPath subset oaverify recognises in OpenAPI
 * Overlay 1.0 `target` strings. It is not a full JSONPath engine: we
 * accept the small closed-form set of shapes the OpenAPI Overlay spec
 * uses in practice ({@link ./translate.ts} matches against the token
 * stream), and surface a locating error on anything else.
 *
 * Tokens recognised:
 * - `$`: root marker (must lead the path)
 * - `.<name>`: dot-name (`info`, `paths`, `get`, ...)
 * - `.*`: dot-wildcard
 * - `['<key>']` / `["<key>"]`: bracket-key (single or double quoted)
 * - `[<digits>]`: bracket-index (numeric)
 * - `[*]`: bracket-wildcard
 * - `[?(<filter>)]`: bracket-filter, where `<filter>` is one of:
 *     - `@.<field>=='<value>'` (single field equality)
 *     - `@.<a>=='<va>' && @.<b>=='<vb>'` (two-field equality, AND)
 *     - `@.<field> contains '<value>'` (string-containment over an array field)
 *
 * @packageDocumentation
 */

/** One step in a parsed target path. */
export type PathToken =
  | { kind: "name"; name: string }
  | { kind: "wildcard" }
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "filter"; expr: FilterExpr };

/**
 * Recognised filter expressions inside `[?(...)]`. The translator
 * only acts on shapes the OpenAPI Overlay spec realistically uses;
 * arbitrary boolean algebra is out of scope.
 */
export type FilterExpr =
  /** Single field equality: `@.<field>=='<value>'`. */
  | { kind: "field-eq"; field: string; value: string }
  /** Two-field equality, AND-joined: `@.<a>=='<va>' && @.<b>=='<vb>'`. */
  | {
      kind: "field-eq-and";
      a: { field: string; value: string };
      b: { field: string; value: string };
    }
  /** Array-containment: `@.<field> contains '<value>'`. */
  | { kind: "field-contains"; field: string; value: string };

/**
 * Raised when a `target` string doesn't parse as one of the
 * recognised shapes. The thrown error carries the offending `target`
 * verbatim so the caller can locate it in an overlay document with
 * many actions.
 */
export class UnrecognisedTargetError extends Error {
  readonly target: string;
  constructor(target: string, reason: string) {
    super(`OpenAPI Overlay target ${JSON.stringify(target)} is not recognised: ${reason}`);
    this.target = target;
    this.name = "UnrecognisedTargetError";
  }
}

/**
 * Parse a JSONPath `target` string into a flat token stream.
 *
 * @throws {@link UnrecognisedTargetError} on syntactically malformed
 *         input or on filter shapes that fall outside the recognised
 *         set.
 */
export function parseTarget(target: string): PathToken[] {
  const lex = new Lexer(target);
  lex.expectRoot();
  const tokens: PathToken[] = [];
  while (!lex.atEnd()) {
    const tok = lex.readStep();
    tokens.push(tok);
  }
  return tokens;
}

/**
 * Hand-rolled lexer. The grammar is tiny enough that a regex-driven
 * parser would obscure as much as it'd save; an explicit cursor
 * makes the error sites obvious.
 */
class Lexer {
  private readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  expectRoot(): void {
    if (this.src.charAt(0) !== "$") {
      throw new UnrecognisedTargetError(this.src, "expected leading `$`");
    }
    this.pos = 1;
  }

  readStep(): PathToken {
    const c = this.peek();
    if (c === ".") {
      this.pos += 1;
      // Dot-wildcard.
      if (this.peek() === "*") {
        this.pos += 1;
        return { kind: "wildcard" };
      }
      // Recursive descent is not supported.
      if (this.peek() === ".") {
        throw new UnrecognisedTargetError(this.src, "recursive descent `..` is not supported");
      }
      const name = this.readDotName();
      return { kind: "name", name };
    }
    if (c === "[") {
      this.pos += 1;
      return this.readBracket();
    }
    throw new UnrecognisedTargetError(
      this.src,
      `unexpected character ${JSON.stringify(c)} at position ${this.pos}`,
    );
  }

  private readDotName(): string {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.src.charCodeAt(this.pos);
      const isLetter = (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
      const isDigit = ch >= 0x30 && ch <= 0x39;
      const isUnderscoreOrDash = ch === 0x5f || ch === 0x2d;
      if (!(isLetter || isDigit || isUnderscoreOrDash)) break;
      this.pos += 1;
    }
    if (this.pos === start) {
      throw new UnrecognisedTargetError(
        this.src,
        `expected identifier after \`.\` at position ${this.pos}`,
      );
    }
    return this.src.slice(start, this.pos);
  }

  private readBracket(): PathToken {
    const c = this.peek();
    if (c === "*") {
      this.pos += 1;
      this.expectChar("]");
      return { kind: "wildcard" };
    }
    if (c === "'" || c === '"') {
      const key = this.readQuotedString(c);
      this.expectChar("]");
      return { kind: "key", key };
    }
    if (c === "?") {
      this.pos += 1;
      this.expectChar("(");
      const expr = this.readFilter();
      this.expectChar(")");
      this.expectChar("]");
      return { kind: "filter", expr };
    }
    if (c >= "0" && c <= "9") {
      const start = this.pos;
      while (!this.atEnd() && this.peek() >= "0" && this.peek() <= "9") this.pos += 1;
      const index = Number.parseInt(this.src.slice(start, this.pos), 10);
      this.expectChar("]");
      return { kind: "index", index };
    }
    throw new UnrecognisedTargetError(
      this.src,
      `unsupported bracket form starting with ${JSON.stringify(c)} at position ${this.pos}`,
    );
  }

  private readQuotedString(quote: string): string {
    this.expectChar(quote);
    const start = this.pos;
    while (!this.atEnd() && this.peek() !== quote) {
      if (this.peek() === "\\") {
        // Permit `\'` and `\"` escapes; ignore unrecognised escapes.
        this.pos += 1;
      }
      this.pos += 1;
    }
    if (this.atEnd()) {
      throw new UnrecognisedTargetError(this.src, "unterminated quoted key");
    }
    const value = this.src.slice(start, this.pos).replace(/\\(['"])/g, "$1");
    this.expectChar(quote);
    return value;
  }

  private readFilter(): FilterExpr {
    // Recognised filter shapes (see file-level TSDoc). Parse greedily;
    // any deviation throws.
    const first = this.readFilterAtom();
    this.skipWhitespace();
    if (this.peek() === "&" && this.src.charAt(this.pos + 1) === "&") {
      this.pos += 2;
      this.skipWhitespace();
      const second = this.readFilterAtom();
      if (first.kind !== "field-eq" || second.kind !== "field-eq") {
        throw new UnrecognisedTargetError(
          this.src,
          "AND-joined filter only supports two `@.field=='value'` clauses",
        );
      }
      return {
        kind: "field-eq-and",
        a: { field: first.field, value: first.value },
        b: { field: second.field, value: second.value },
      };
    }
    return first;
  }

  private readFilterAtom(): FilterExpr {
    this.skipWhitespace();
    this.expectChar("@");
    this.expectChar(".");
    const field = this.readDotName();
    this.skipWhitespace();
    // `==` equality.
    if (this.peek() === "=" && this.src.charAt(this.pos + 1) === "=") {
      this.pos += 2;
      this.skipWhitespace();
      const q = this.peek();
      if (q !== "'" && q !== '"') {
        throw new UnrecognisedTargetError(this.src, "expected quoted value after `==`");
      }
      const value = this.readQuotedString(q);
      return { kind: "field-eq", field, value };
    }
    // `contains` keyword (array-containment).
    if (this.src.startsWith("contains", this.pos)) {
      this.pos += "contains".length;
      this.skipWhitespace();
      const q = this.peek();
      if (q !== "'" && q !== '"') {
        throw new UnrecognisedTargetError(this.src, "expected quoted value after `contains`");
      }
      const value = this.readQuotedString(q);
      return { kind: "field-contains", field, value };
    }
    throw new UnrecognisedTargetError(
      this.src,
      `unsupported filter operator at position ${this.pos} (expected \`==\` or \`contains\`)`,
    );
  }

  private peek(): string {
    return this.src.charAt(this.pos);
  }

  private expectChar(c: string): void {
    if (this.peek() !== c) {
      throw new UnrecognisedTargetError(
        this.src,
        `expected ${JSON.stringify(c)} at position ${this.pos}, got ${JSON.stringify(this.peek())}`,
      );
    }
    this.pos += 1;
  }

  private skipWhitespace(): void {
    while (!this.atEnd() && (this.peek() === " " || this.peek() === "\t")) this.pos += 1;
  }
}
