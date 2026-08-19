/**
 * A resumable, byte-fed SAX tokenizer for JSON. Feed it arbitrary byte
 * chunks with {@link JsonTokenizer.write} and signal end-of-input with
 * {@link JsonTokenizer.end}; it drives a {@link JsonEventHandler} in
 * document order.
 *
 * Correctness anchors:
 *
 *   - **Chunk-boundary safe.** A token, a UTF-8 multibyte sequence, or
 *     an escape may be split across `write` calls; the machine carries
 *     the partial state across.
 *   - **Match `JSON.parse`.** Numbers are JS doubles; lone surrogate
 *     escapes are accepted; trailing non-whitespace is rejected;
 *     multiple top-level texts are rejected.
 *   - **A U+FEFF inside a string is content.** It survives decoding and
 *     reaches the handler, so a string keyword compares against what the
 *     sender wrote. A document-*leading* BOM is a parse error, which is
 *     what `JSON.parse` does and what RFC 8259 8.1 permits ("MAY
 *     ignore"). The spec reader's `trimStdinText` strips one on the
 *     stdin path, because a document piped from an editor or a shell
 *     tracks what those emit rather than what `JSON.parse` accepts.
 *   - **Decoded strings, escape-aware lengths.** String content is
 *     decoded to JS text (UTF-8 + JSON escapes, surrogate-pair escapes
 *     combined). Lengths are counted in Unicode code points, not UTF-16
 *     units, without relying on `String.prototype.length`.
 *
 * A parse error throws {@link JsonParseError} (carrying the byte offset)
 * from `write` / `end`. Parse errors are terminal; the engine layer
 * turns the throw into a fatal `error` on the side channel.
 *
 * @packageDocumentation
 */

import type { JsonEventHandler } from "./handler.js";

/**
 * Thrown on malformed JSON. `byteOffset` is the stream-absolute offset
 * of the offending byte (or end-of-input).
 *
 * @public
 */
export class JsonParseError extends Error {
  readonly byteOffset: number;
  constructor(message: string, byteOffset: number) {
    super(`${message} (at byte ${byteOffset})`);
    this.name = "JsonParseError";
    this.byteOffset = byteOffset;
  }
}

// Parser states. Structural states drive the JSON grammar; the IN_*
// states resume a token split across chunks.
const ST_VALUE = 0; // expect a value (whitespace skipped)
const ST_VALUE_OR_END_ARRAY = 1; // first array element: value or `]`
const ST_KEY_OR_END_OBJECT = 2; // after `{`: key string or `}`
const ST_KEY = 3; // after `,` in object: key string
const ST_COLON = 4; // expect `:`
const ST_COMMA_OR_END_ARRAY = 5; // after element: `,` or `]`
const ST_COMMA_OR_END_OBJECT = 6; // after member: `,` or `}`
const ST_END = 7; // root value done: only whitespace then EOF
const ST_IN_STRING = 8; // inside a string body
const ST_IN_STRING_ESCAPE = 9; // just consumed `\`
const ST_IN_STRING_UNICODE = 10; // collecting `\uXXXX` hex digits
const ST_IN_NUMBER = 11; // accumulating a number literal
const ST_IN_LITERAL = 12; // accumulating true / false / null

// Container kinds on the scope stack.
const CTX_OBJECT = 0;
const CTX_ARRAY = 1;

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_BACKSLASH = 0x5c;

// Shared zero-length buffer for flushing the streaming decoder at a
// string's end (avoids a per-string allocation).
const EMPTY = new Uint8Array(0);

function isWhitespace(b: number): boolean {
  return b === CH_SPACE || b === CH_LF || b === CH_TAB || b === CH_CR;
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30; // 0-9
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10; // a-f
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10; // A-F
  return -1;
}

/**
 * A string's length in Unicode code points.
 *
 * Iterating the string yields one per code point, pairing surrogates.
 * Written as a loop rather than `[...s].length` so no array is built,
 * and because the spread form trips `typescript(no-misused-spread)` in
 * the type-aware lint.
 *
 * `@oaverify/internal-schema` has the same helper for the buffered
 * engine, and does not re-export it through
 * `@oaverify/core/schema/internals`, so a local copy is cheaper than
 * widening that surface for four lines.
 */
function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * @public
 */
export class JsonTokenizer {
  private readonly handler: JsonEventHandler;
  // `ignoreBOM` keeps a U+FEFF that appears in the input instead of
  // treating it as a byte-order mark. Every `decode` with
  // `{ stream: false }` ends the decode stream, so the next call starts a
  // fresh one, and a fresh stream strips a U+FEFF that begins it. A
  // decoded run begins at a string's opening quote, after an escape, and
  // after a chunk boundary that ended the stream, so a BOM at any of
  // those three positions was deleted from the value while the
  // escape-aware code-point counter still counted it (#851).
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  private state = ST_VALUE;
  private readonly stack: number[] = [];
  private sawRootValue = false;
  private ended = false;

  // Stream-absolute offset of chunk[0] for the chunk currently being
  // processed. `pos(i)` derives the absolute offset of chunk[i].
  private baseOffset = 0;

  // String state.
  private stringIsKey = false;
  private stringStart = 0;
  private keyBuf = "";
  private strCodePoints = 0;
  private pendingHighSurrogate = false;
  // `\uXXXX` accumulation.
  private uniValue = 0;
  private uniDigits = 0;

  // Number / literal accumulation.
  private tokenStart = 0;
  private numBuf = "";
  private litExpected = "";
  private litValue: boolean | null = null;
  private litPos = 0;

  constructor(handler: JsonEventHandler) {
    this.handler = handler;
  }

  /**
   * The lowest input-byte offset whose emission must wait for a member-edit
   * decision: the start of an object key currently mid-parse (so a key that
   * straddles a chunk boundary is not echoed before a rename can rewrite it),
   * else `+Infinity`. The editing echo holds bytes at or past this offset.
   * Values are never held here (only keys are edit targets), so a large value
   * streams regardless. Cheap to call after {@link write}.
   */
  editHoldOffset(): number {
    if (
      this.stringIsKey &&
      (this.state === ST_IN_STRING ||
        this.state === ST_IN_STRING_ESCAPE ||
        this.state === ST_IN_STRING_UNICODE)
    ) {
      return this.stringStart;
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Feed the next chunk of input bytes. The per-byte state dispatch is
   * inlined here (rather than a per-byte method call) because it is the
   * hot loop; the string body, numbers, and escapes batch in their own
   * scanners.
   */
  write(chunk: Uint8Array): void {
    if (this.ended) throw new JsonParseError("write after end", this.baseOffset);
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      const state = this.state;
      if (state === ST_IN_STRING) {
        i = this.scanStringBody(chunk, i);
        continue;
      }
      const b = chunk[i] as number;
      switch (state) {
        case ST_VALUE:
        case ST_VALUE_OR_END_ARRAY:
          if (isWhitespace(b)) i += 1;
          else if (b === 0x5d /* ] */ && state === ST_VALUE_OR_END_ARRAY) i = this.closeArray(i);
          else i = this.beginValue(chunk, i);
          break;
        case ST_KEY_OR_END_OBJECT:
          if (isWhitespace(b)) i += 1;
          else if (b === 0x7d /* } */) i = this.closeObject(i);
          else if (b === CH_QUOTE) i = this.beginString(i, true);
          else this.fail("expected object key or '}'", i);
          break;
        case ST_KEY:
          if (isWhitespace(b)) i += 1;
          else if (b === CH_QUOTE) i = this.beginString(i, true);
          else this.fail("expected object key", i);
          break;
        case ST_COLON:
          if (isWhitespace(b)) i += 1;
          else if (b === 0x3a /* : */) {
            this.state = ST_VALUE;
            i += 1;
          } else this.fail("expected ':'", i);
          break;
        case ST_COMMA_OR_END_ARRAY:
          if (isWhitespace(b)) i += 1;
          else if (b === 0x2c /* , */) {
            this.state = ST_VALUE;
            i += 1;
          } else if (b === 0x5d /* ] */) i = this.closeArray(i);
          else this.fail("expected ',' or ']'", i);
          break;
        case ST_COMMA_OR_END_OBJECT:
          if (isWhitespace(b)) i += 1;
          else if (b === 0x2c /* , */) {
            this.state = ST_KEY;
            i += 1;
          } else if (b === 0x7d /* } */) i = this.closeObject(i);
          else this.fail("expected ',' or '}'", i);
          break;
        case ST_END:
          if (isWhitespace(b)) i += 1;
          else this.fail("unexpected trailing content after JSON value", i);
          break;
        case ST_IN_STRING_ESCAPE:
          i = this.stepStringEscape(chunk, i);
          break;
        case ST_IN_STRING_UNICODE:
          i = this.stepStringUnicode(chunk, i);
          break;
        case ST_IN_NUMBER:
          i = this.stepNumber(chunk, i);
          break;
        case ST_IN_LITERAL:
          i = this.stepLiteral(chunk, i);
          break;
        default:
          this.fail("internal: bad state", i);
      }
    }
    this.baseOffset += n;
  }

  /** Signal end-of-input and flush any token in progress. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    // A number is the one token whose end is a delimiter; EOF is a valid
    // delimiter, so finalize an in-progress number here.
    if (this.state === ST_IN_NUMBER) {
      this.finishNumber(this.baseOffset);
      // finishNumber moves to a post-value state; fall through to checks.
    }
    if (
      this.state === ST_IN_STRING ||
      this.state === ST_IN_STRING_ESCAPE ||
      this.state === ST_IN_STRING_UNICODE
    ) {
      throw new JsonParseError("unterminated string", this.baseOffset);
    }
    if (this.state === ST_IN_LITERAL) {
      throw new JsonParseError("unterminated literal", this.baseOffset);
    }
    if (this.stack.length > 0) {
      throw new JsonParseError("unexpected end of input: unclosed container", this.baseOffset);
    }
    if (!this.sawRootValue) {
      throw new JsonParseError("unexpected end of input: no JSON value", this.baseOffset);
    }
    // state is ST_END (or a post-value root state) -> clean finish.
  }

  private pos(i: number): number {
    return this.baseOffset + i;
  }

  private fail(message: string, i: number): never {
    throw new JsonParseError(message, this.pos(i));
  }

  private beginValue(chunk: Uint8Array, i: number): number {
    const b = chunk[i] as number;
    if (b === CH_QUOTE) return this.beginString(i, false);
    if (b === 0x7b /* { */) {
      this.handler.onStartObject(this.pos(i));
      this.stack.push(CTX_OBJECT);
      this.state = ST_KEY_OR_END_OBJECT;
      return i + 1;
    }
    if (b === 0x5b /* [ */) {
      this.handler.onStartArray(this.pos(i));
      this.stack.push(CTX_ARRAY);
      this.state = ST_VALUE_OR_END_ARRAY;
      return i + 1;
    }
    if (b === 0x2d /* - */ || isDigit(b)) {
      this.tokenStart = this.pos(i);
      this.numBuf = "";
      this.state = ST_IN_NUMBER;
      return i; // re-process the byte in number state
    }
    if (b === 0x74 /* t */) return this.beginLiteral(i, "true", true);
    if (b === 0x66 /* f */) return this.beginLiteral(i, "false", false);
    if (b === 0x6e /* n */) return this.beginLiteral(i, "null", null);
    return this.fail("unexpected character; expected a value", i);
  }

  private beginString(i: number, isKey: boolean): number {
    this.stringIsKey = isKey;
    this.stringStart = this.pos(i);
    this.strCodePoints = 0;
    this.pendingHighSurrogate = false;
    this.keyBuf = "";
    this.state = ST_IN_STRING;
    if (!isKey) this.handler.onStringStart(this.pos(i));
    return i + 1; // consume the opening quote
  }

  // Fast path: scan a run of literal string-body bytes, decode it, and
  // emit / accumulate. Stops at a quote (string end), a backslash
  // (escape), or the chunk end. Returns the next index.
  private scanStringBody(chunk: Uint8Array, start: number): number {
    let i = start;
    const n = chunk.length;
    let nonAscii = false;
    while (i < n) {
      const b = chunk[i] as number;
      if (b === CH_QUOTE || b === CH_BACKSLASH) break;
      if (b < 0x20) return this.fail("unescaped control character in string", i);
      if (b >= 0x80) nonAscii = true;
      i++;
    }
    if (i > start) {
      // Any literal text separates a `\uXXXX` high surrogate from a later
      // low one, so the counter treats them as unpaired. Hoisted out of
      // the loop: per-byte it never ran for a run of continuation bytes,
      // which are literal text (one U+FFFD each) and do separate the
      // pair. A partial sequence the decoder still holds is the one case
      // where the delivered string pairs them anyway; see #886.
      this.pendingHighSurrogate = false;
      // Decode the literal run (streaming: a multibyte char split at the
      // chunk end is held by the decoder and completed next chunk).
      const atChunkEnd = i === n;
      const text = this.decoder.decode(chunk.subarray(start, i), { stream: atChunkEnd });
      // Count the decode's output. Counting input bytes missed a stray
      // continuation byte, which is no lead byte and one U+FFFD, so a
      // lead-byte count read a string of them as empty: `minLength`
      // rejected 1000 characters as too short, and once `maxLength` shared
      // this counter it stopped bounding them at all (#852).
      //
      // An all-ASCII run that produced one UTF-16 unit per byte decoded to
      // one BMP code point per byte, so the length is the count and the
      // common case never walks the string. Both conditions are needed:
      // the length test alone accepts a run finishing an astral character
      // the decoder held, whose two remaining bytes give two units, and
      // the ASCII test alone accepts a run that a held character prefixes.
      this.strCodePoints +=
        !nonAscii && text.length === i - start ? text.length : countCodePoints(text);
      if (text.length > 0) this.emitStringText(text, this.pos(start));
    }
    if (i >= n) return i; // chunk exhausted mid-string
    const b = chunk[i] as number;
    if (b === CH_QUOTE) return this.finishString(i);
    // backslash
    this.state = ST_IN_STRING_ESCAPE;
    return i + 1;
  }

  private emitStringText(text: string, offset: number): void {
    if (this.stringIsKey) this.keyBuf += text;
    // `strCodePoints` counts exactly what has been emitted: the literal
    // scan counts the decoded run, and both escape paths increment before
    // emitting.
    else this.handler.onStringChunk(text, offset, this.strCodePoints);
  }

  private stepStringEscape(chunk: Uint8Array, i: number): number {
    const b = chunk[i] as number;
    let ch: string | undefined;
    switch (b) {
      case CH_QUOTE:
        ch = '"';
        break;
      case CH_BACKSLASH:
        ch = "\\";
        break;
      case 0x2f /* / */:
        ch = "/";
        break;
      case 0x62 /* b */:
        ch = "\b";
        break;
      case 0x66 /* f */:
        ch = "\f";
        break;
      case 0x6e /* n */:
        ch = "\n";
        break;
      case 0x72 /* r */:
        ch = "\r";
        break;
      case 0x74 /* t */:
        ch = "\t";
        break;
      case 0x75 /* u */:
        this.uniValue = 0;
        this.uniDigits = 0;
        this.state = ST_IN_STRING_UNICODE;
        return i + 1;
      default:
        return this.fail("invalid string escape", i);
    }
    // Two-char escape: one code point, breaks any pending surrogate.
    this.strCodePoints++;
    this.pendingHighSurrogate = false;
    this.emitStringText(ch, this.pos(i));
    this.state = ST_IN_STRING;
    return i + 1;
  }

  private stepStringUnicode(chunk: Uint8Array, i: number): number {
    const v = hexValue(chunk[i] as number);
    if (v < 0) return this.fail("invalid \\u escape: expected hex digit", i);
    this.uniValue = (this.uniValue << 4) | v;
    this.uniDigits++;
    if (this.uniDigits < 4) return i + 1;
    // Completed a \uXXXX unit.
    const unit = this.uniValue;
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (this.pendingHighSurrogate && isLow) {
      // Completes a surrogate pair: counts 0 (the high already counted 1).
      this.pendingHighSurrogate = false;
    } else {
      this.strCodePoints++;
      this.pendingHighSurrogate = isHigh;
    }
    // Append the code unit (lone surrogates accepted, matching JSON.parse).
    this.emitStringText(String.fromCharCode(unit), this.pos(i));
    this.state = ST_IN_STRING;
    return i + 1;
  }

  private finishString(i: number): number {
    // Flush any UTF-8 partial held by the decoder (valid input leaves
    // none; truncated bytes decode to U+FFFD, matching Buffer#toString).
    const tail = this.decoder.decode(EMPTY, { stream: false });
    // The flush completes any sequence the decoder held, so it can emit a
    // U+FFFD the literal-run branch never saw: a `write` ending mid
    // sequence followed by one starting with the closing quote leaves
    // `i === start`, skipping that branch entirely. Counting only there
    // left the string one code point short (#852).
    if (tail.length > 0) {
      this.strCodePoints += countCodePoints(tail);
      this.emitStringText(tail, this.pos(i));
    }
    const endOffset = this.pos(i) + 1; // past the closing quote
    if (this.stringIsKey) {
      this.handler.onKey(this.keyBuf, this.strCodePoints, this.stringStart, endOffset);
      this.keyBuf = "";
      this.state = ST_COLON;
    } else {
      this.handler.onStringEnd(this.strCodePoints, this.stringStart, endOffset);
      this.afterValue();
    }
    return i + 1; // consume the closing quote
  }

  private beginLiteral(i: number, word: string, value: boolean | null): number {
    this.litExpected = word;
    this.litValue = value;
    this.litPos = 0;
    this.tokenStart = this.pos(i);
    this.state = ST_IN_LITERAL;
    return i; // re-process the first byte in literal state
  }

  private stepLiteral(chunk: Uint8Array, i: number): number {
    const expected = this.litExpected.charCodeAt(this.litPos);
    if ((chunk[i] as number) !== expected) {
      return this.fail(`invalid literal; expected '${this.litExpected}'`, i);
    }
    this.litPos++;
    if (this.litPos === this.litExpected.length) {
      const end = this.pos(i) + 1;
      if (this.litValue === null) this.handler.onNull(this.tokenStart, end);
      else this.handler.onBoolean(this.litValue, this.tokenStart, end);
      this.afterValue();
    }
    return i + 1;
  }

  private stepNumber(chunk: Uint8Array, i: number): number {
    // Scan the whole run of number bytes in this chunk and append it in
    // one decode, rather than concatenating char by char. (latin1 == ASCII
    // for the number grammar's bytes; a Buffer view avoids a per-char loop
    // and a spread that a huge literal could overflow.)
    const n = chunk.length;
    let j = i;
    while (j < n) {
      const b = chunk[j] as number;
      if (
        isDigit(b) ||
        b === 0x2d /* - */ ||
        b === 0x2b /* + */ ||
        b === 0x2e /* . */ ||
        b === 0x65 /* e */ ||
        b === 0x45 /* E */
      ) {
        j += 1;
      } else break;
    }
    if (j > i) {
      // Build the run's ASCII string in one append (no per-char re-entry
      // into step, and no Buffer view; a typed-array allocation per
      // number showed up hot in profiling).
      let run = "";
      for (let k = i; k < j; k++) run += String.fromCharCode(chunk[k] as number);
      this.numBuf += run;
    }
    if (j < n) {
      // A non-number byte ends the literal; re-process it after finishing.
      this.finishNumber(this.pos(j));
    }
    return j; // chunk exhausted mid-number, or stopped at the delimiter
  }

  private finishNumber(end: number): void {
    const raw = this.numBuf;
    if (!NUMBER_RE.test(raw)) {
      throw new JsonParseError(`invalid number literal '${raw}'`, this.tokenStart);
    }
    this.handler.onNumber(Number(raw), raw, this.tokenStart, end);
    this.numBuf = "";
    this.afterValue();
  }

  private closeObject(i: number): number {
    this.handler.onEndObject(this.pos(i));
    this.stack.pop();
    this.afterValue();
    return i + 1;
  }

  private closeArray(i: number): number {
    this.handler.onEndArray(this.pos(i));
    this.stack.pop();
    this.afterValue();
    return i + 1;
  }

  // Transition after a complete value (scalar, or a just-closed
  // container) based on the enclosing scope.
  private afterValue(): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.sawRootValue = true;
      this.state = ST_END;
    } else if (top === CTX_ARRAY) {
      this.state = ST_COMMA_OR_END_ARRAY;
    } else {
      this.state = ST_COMMA_OR_END_OBJECT;
    }
  }
}

// Strict JSON number grammar: an optional minus, an integer part with no
// leading zeros, an optional fraction, an optional exponent. Rejects the
// forms JSON.parse rejects (`01`, `1.`, `.5`, `1e`, `+1`).
const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
