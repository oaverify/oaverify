import type { SchemaLintIssue } from "./compiler.js";

/**
 * Range of string lengths a `pattern` can accept, in code points (the
 * unit JSON Schema 2020-12 §6.3 counts for `minLength` / `maxLength`,
 * and the unit `codePointLengthExpr` emits for them).
 *
 * `max` is `Infinity` for an unbounded pattern.
 */
export interface LengthSpan {
  min: number;
  max: number;
}

/** Thrown internally by the parser; never escapes {@link stringLengthRange}. */
class Unanalysable extends Error {}

/**
 * One parsed regex construct, carrying the lengths it can consume plus
 * whether it pins its position to the start or end of the subject.
 *
 * The anchor flags are what make the difference between "the match is
 * this long" and "the string is this long": JSON Schema `pattern` is a
 * search, not a full match, so `abc` accepts any string *containing*
 * `abc` and only `^abc$` bounds the string above.
 */
interface Node {
  min: number;
  max: number;
  startAnchored: boolean;
  endAnchored: boolean;
}

const ZERO_WIDTH: Node = { min: 0, max: 0, startAnchored: false, endAnchored: false };
const ONE_CHAR: Node = { min: 1, max: 1, startAnchored: false, endAnchored: false };

/** `Infinity * 0` is `NaN`; every other case is plain multiplication. */
function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return a * b;
}

/**
 * Match-length analysis for an ECMA-262 pattern, computed analytically.
 *
 * Returns the range of string lengths that can satisfy `pattern`, or
 * `undefined` when the pattern contains something this parser does not
 * model. **A caller must never read `undefined` as "nothing matches".**
 *
 * Two properties hold, and callers depend on both:
 *
 * 1. Anything unanalysable (backreferences, `\p{...}` property escapes,
 *    an empty character class, a malformed pattern, or a pattern that
 *    compiles only under the runtime's no-flag fallback) returns
 *    `undefined` rather than a guess.
 * 2. Where the analysis is imprecise it is imprecise *outward*: `min`
 *    may be lower than the true minimum and `max` higher than the true
 *    maximum, never the reverse. The only question asked of the result
 *    is `max < minLength || min > maxLength`, so an over-wide span can
 *    lose a true finding and can never manufacture a false one.
 *
 * The second property is the whole reason this is a parser rather than
 * a sampler. Sampling cannot tell a rare match from no match:
 * `^[0-9]{3}[A-Z0-9]{5}[0-9]$` hits on roughly 3e-5 of random strings,
 * so a few hundred thousand draws "prove" it matches nothing. A rule
 * whose findings mean "this is definitely broken" cannot be built on
 * that (#542).
 *
 * Zero-width constructs (`^`, `$`, `\b`, `\B`, lookaround) contribute
 * exactly 0, which is precise rather than merely safe. An anchor under
 * a quantifier that can skip it stops counting as an anchor, which
 * widens the span: `(^)*a$` reports `{min: 1, max: Infinity}`, and
 * since the group may match zero times that is exact: the pattern
 * accepts "xa" as readily as "a". Treating the anchor as surviving the
 * quantifier would bound the subject, which is the direction that
 * invents findings.
 *
 * @param pattern - The regex source, as written in the schema (no
 *   delimiters, no flags).
 *
 * @internal
 */
export function stringLengthRange(pattern: string): LengthSpan | undefined {
  // This parser reads `u`-mode syntax. The runtime falls back to a
  // no-flag `RegExp` when the `u` compile throws (see
  // `compilePatternRegex` in runtime.ts), and under that fallback the
  // *source length* of some
  // constructs is read differently: `\01` is one octal escape rather
  // than `\0` plus a literal `1`, and `\u{ZZ}` is a literal `u`
  // followed by a quantifier rather than one code point. Both make the
  // parser over-count, which is the one direction that manufactures a
  // false finding. Analysing only what compiles under `u` keeps the
  // parser's reading and the runtime's reading the same.
  try {
    new RegExp(pattern, "u");
  } catch {
    return undefined;
  }

  try {
    const parser = new PatternParser(pattern);
    const node = parser.parseDisjunction();
    if (!parser.done()) throw new Unanalysable(); // stray ")"
    return {
      min: node.min,
      // Unanchored at either end, the match can sit anywhere inside an
      // arbitrarily long subject.
      max: node.startAnchored && node.endAnchored ? node.max : Infinity,
    };
  } catch (err) {
    if (err instanceof Unanalysable) return undefined;
    throw err;
  }
}

class PatternParser {
  private i = 0;

  constructor(private readonly src: string) {}

  done(): boolean {
    return this.i >= this.src.length;
  }

  private peek(): string {
    return this.src[this.i] ?? "";
  }

  private eat(s: string): boolean {
    if (this.src.startsWith(s, this.i)) {
      this.i += s.length;
      return true;
    }
    return false;
  }

  /** `alternative ("|" alternative)*` */
  parseDisjunction(): Node {
    const alts: Node[] = [this.parseAlternative()];
    while (this.peek() === "|") {
      this.i += 1;
      alts.push(this.parseAlternative());
    }
    if (alts.length === 1) return alts[0] as Node;
    return {
      min: Math.min(...alts.map((a) => a.min)),
      max: Math.max(...alts.map((a) => a.max)),
      // An alternation is anchored only if every branch is: one loose
      // branch is enough to let the subject grow.
      startAnchored: alts.every((a) => a.startAnchored),
      endAnchored: alts.every((a) => a.endAnchored),
    };
  }

  /** `term*`, up to `|`, `)`, or end of input. */
  private parseAlternative(): Node {
    const terms: Node[] = [];
    while (!this.done() && this.peek() !== "|" && this.peek() !== ")") {
      terms.push(this.parseTerm());
    }

    let min = 0;
    let max = 0;
    for (const t of terms) {
      min += t.min;
      max += t.max;
    }

    // An anchor pins the alternative only if everything before it (or
    // after it, for `$`) can be absent: `x?^y` is start-anchored when
    // `x` is skipped, `x^y` is not anchored by any reading that matches.
    let startAnchored = false;
    for (const t of terms) {
      if (t.startAnchored) {
        startAnchored = true;
        break;
      }
      if (t.min > 0) break;
    }
    let endAnchored = false;
    for (let k = terms.length - 1; k >= 0; k -= 1) {
      const t = terms[k] as Node;
      if (t.endAnchored) {
        endAnchored = true;
        break;
      }
      if (t.min > 0) break;
    }

    return { min, max, startAnchored, endAnchored };
  }

  /** `assertion | atom quantifier?` */
  private parseTerm(): Node {
    const atom = this.parseAtom();
    const quant = this.parseQuantifier();
    if (quant === undefined) return atom;
    return {
      min: mul(atom.min, quant.min),
      max: mul(atom.max, quant.max),
      // A quantifier that can skip its atom entirely takes the anchor
      // with it. Keeping the flag here is what would let `(^)*a$` claim
      // a bounded subject, which is the one direction that is unsafe.
      startAnchored: quant.min >= 1 && atom.startAnchored,
      endAnchored: quant.min >= 1 && atom.endAnchored,
    };
  }

  private parseAtom(): Node {
    const c = this.peek();

    if (c === "^") {
      this.i += 1;
      return { ...ZERO_WIDTH, startAnchored: true };
    }
    if (c === "$") {
      this.i += 1;
      return { ...ZERO_WIDTH, endAnchored: true };
    }
    if (c === "(") return this.parseGroup();
    if (c === "[") return this.parseClass();
    if (c === ".") {
      this.i += 1;
      return ONE_CHAR;
    }
    if (c === "\\") return this.parseEscape();
    // A quantifier with nothing to quantify is a malformed pattern.
    if (c === "*" || c === "+" || c === "?") throw new Unanalysable();

    // Literal character. Consumed by code point, since `minLength`
    // counts code points and a literal astral character occupies two
    // UTF-16 units in the source.
    const cp = this.src.codePointAt(this.i);
    if (cp === undefined) throw new Unanalysable();
    this.i += String.fromCodePoint(cp).length;
    return ONE_CHAR;
  }

  private parseGroup(): Node {
    // Lookaround asserts without consuming, so its contents are parsed
    // (to find the matching paren) and its length discarded.
    let zeroWidth = false;
    if (this.eat("(?=") || this.eat("(?!") || this.eat("(?<=") || this.eat("(?<!")) {
      zeroWidth = true;
    } else if (this.eat("(?:")) {
      // plain non-capturing group
    } else if (this.src.startsWith("(?<", this.i)) {
      const close = this.src.indexOf(">", this.i);
      if (close === -1) throw new Unanalysable();
      this.i = close + 1; // named capture group
    } else if (this.eat("(?")) {
      throw new Unanalysable(); // modifier groups and anything else new
    } else {
      this.i += 1; // capturing group
    }

    const inner = this.parseDisjunction();
    if (!this.eat(")")) throw new Unanalysable(); // unbalanced
    return zeroWidth ? ZERO_WIDTH : inner;
  }

  private parseClass(): Node {
    this.i += 1; // "["
    if (this.eat("^")) {
      // negated class; still exactly one code point
    }
    // An empty class matches nothing at all. That makes the schema
    // unsatisfiable for a reason that has nothing to do with its length
    // bounds, so this rule declines to speak rather than report the
    // wrong cause.
    if (this.peek() === "]") throw new Unanalysable();

    while (!this.done() && this.peek() !== "]") {
      if (this.peek() === "\\") {
        this.i += 1;
        const esc = this.peek();
        if (esc === "") throw new Unanalysable();
        // Property escapes can match strings of more than one code
        // point under the `v` flag; decline rather than assume.
        if (esc === "p" || esc === "P") throw new Unanalysable();
        this.i += 1;
        continue;
      }
      const cp = this.src.codePointAt(this.i);
      if (cp === undefined) throw new Unanalysable();
      this.i += String.fromCodePoint(cp).length;
    }
    if (!this.eat("]")) throw new Unanalysable();
    return ONE_CHAR;
  }

  private parseEscape(): Node {
    this.i += 1; // "\"
    const c = this.peek();
    if (c === "") throw new Unanalysable(); // trailing backslash

    // Word boundaries assert a position without consuming.
    if (c === "b" || c === "B") {
      this.i += 1;
      return ZERO_WIDTH;
    }
    // A backreference's length is whatever the referenced group
    // captured, which is not a property of the pattern's shape.
    if (c === "k" || (c >= "1" && c <= "9")) throw new Unanalysable();
    if (c === "p" || c === "P") throw new Unanalysable();

    // Every remaining escape denotes exactly one character; they differ
    // only in how much source they occupy, and miscounting that would
    // silently turn the trailing digits of `A` into four literals.
    if (c === "u") {
      if (this.src[this.i + 1] === "{") {
        const close = this.src.indexOf("}", this.i);
        if (close === -1) throw new Unanalysable();
        // Only a well-formed code point escape is one code point. The
        // `u`-mode precheck already rejects the alternative, and this
        // keeps the parser honest for any caller reaching it directly.
        const payload = this.src.slice(this.i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(payload) || Number.parseInt(payload, 16) > 0x10_ff_ff) {
          throw new Unanalysable();
        }
        this.i = close + 1;
        return ONE_CHAR;
      }
      return this.consumeFixedEscape(4);
    }
    if (c === "x") return this.consumeFixedEscape(2);
    if (c === "c") return this.consumeFixedEscape(1);

    // `\d`, `\w`, `\s`, their negations, and identity escapes (`\.`).
    this.i += 1;
    return ONE_CHAR;
  }

  /**
   * Consume an escape whose payload is a fixed number of source
   * characters (`\uXXXX`, `\xNN`, `\cX`). A malformed payload reads as
   * an identity escape under one interpretation and a syntax error
   * under another, so decline rather than pick.
   */
  private consumeFixedEscape(payload: number): Node {
    const start = this.i + 1;
    const text = this.src.slice(start, start + payload);
    if (text.length < payload) throw new Unanalysable();
    const ok = payload === 1 ? /^[A-Za-z]$/.test(text) : /^[0-9a-fA-F]+$/.test(text);
    if (!ok) throw new Unanalysable();
    this.i = start + payload;
    return ONE_CHAR;
  }

  /**
   * `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each optionally lazy.
   * Returns `undefined` when the next character does not start one.
   */
  private parseQuantifier(): { min: number; max: number } | undefined {
    const c = this.peek();
    let range: { min: number; max: number } | undefined;

    if (c === "*") {
      this.i += 1;
      range = { min: 0, max: Infinity };
    } else if (c === "+") {
      this.i += 1;
      range = { min: 1, max: Infinity };
    } else if (c === "?") {
      this.i += 1;
      range = { min: 0, max: 1 };
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d+)?)?\}/.exec(this.src.slice(this.i));
      // A `{` that is not a well-formed quantifier is a literal brace
      // (Annex B), so leave it for the next atom.
      if (m === null) return undefined;
      this.i += m[0].length;
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[3] === undefined ? Infinity : Number(m[3]);
      range = { min: lo, max: hi };
    }

    if (range === undefined) return undefined;
    // Laziness changes which match is preferred, not which lengths are
    // possible.
    this.eat("?");
    return range;
  }
}

/** `<root>` for the walk root, `"a.b"` otherwise. Matches the sibling lint rules. */
function at(path: string): string {
  return path === "" ? "<root>" : `"${path}"`;
}

/** Long patterns are quoted in full only up to this, to keep findings readable. */
const PATTERN_ECHO_LIMIT = 60;

function echoPattern(pattern: string): string {
  return pattern.length <= PATTERN_ECHO_LIMIT
    ? pattern
    : `${pattern.slice(0, PATTERN_ECHO_LIMIT)}...`;
}

function describeSpan(span: LengthSpan): string {
  if (span.max === Infinity) return `length ${span.min} or more`;
  if (span.min === span.max) return `length ${span.min}`;
  return `length ${span.min} to ${span.max}`;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Is this schema's `type` exactly "string", so that `pattern` and the
 * length bounds constrain every instance it accepts?
 *
 * Deliberately narrow. Where `type` is absent or admits another type,
 * a pattern that contradicts the length bounds kills only the string
 * branch: `{minLength: 9, pattern: "^ab$"}` still accepts the number
 * `1`, so "no instance can satisfy this" would be false. That is a
 * defect worth knowing about, and a different finding from this one.
 * This family's value is that a finding means the position is provably
 * dead, so it stays silent rather than widen (#542, and the same call
 * #514 makes for `enum` members).
 */
function isStringOnly(type: unknown): boolean {
  if (type === "string") return true;
  return Array.isArray(type) && type.length === 1 && type[0] === "string";
}

/**
 * Report a `pattern` whose match length cannot overlap the sibling
 * `minLength` / `maxLength` bounds. No string validates at that
 * position, and the author never meant that: the shape in the wild is
 * `pattern: '(^[a-zA-Z0-9](9)$)'` alongside `minLength: 9`, where
 * `(9)` is a group matching the literal `9` and `{9}` was meant.
 *
 * Silent whenever {@link stringLengthRange} cannot analyse the pattern,
 * or the schema admits a type other than string.
 *
 * @internal
 */
export function collectPatternLengthIssue(
  obj: Record<string, unknown>,
  path: string,
): SchemaLintIssue | undefined {
  const pattern = obj["pattern"];
  if (typeof pattern !== "string") return undefined;
  if (!isStringOnly(obj["type"])) return undefined;

  const minLength = obj["minLength"];
  const maxLength = obj["maxLength"];
  const hasMin = isNonNegativeInteger(minLength);
  const hasMax = isNonNegativeInteger(maxLength);
  if (!hasMin && !hasMax) return undefined;

  const span = stringLengthRange(pattern);
  if (span === undefined) return undefined;

  let clash: string | undefined;
  if (hasMin && span.max < minLength) {
    clash = `"minLength": ${minLength} can never be satisfied`;
  } else if (hasMax && span.min > maxLength) {
    clash = `"maxLength": ${maxLength} can never be satisfied`;
  }
  if (clash === undefined) return undefined;

  return {
    code: "unsatisfiable/pattern-length",
    keyword: "pattern",
    path,
    message: `"pattern" "${echoPattern(pattern)}" at ${at(path)} matches only strings of ${describeSpan(span)}, so ${clash}; no string validates here`,
  };
}
