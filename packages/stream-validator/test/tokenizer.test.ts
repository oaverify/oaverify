import { describe, expect, it } from "vitest";
import type { JsonEventHandler } from "../src/tokenizer/index.js";
import { JsonParseError, JsonTokenizer } from "../src/tokenizer/index.js";

const enc = new TextEncoder();

/** A normalized event (string chunks merged), chunk-invariant. */
type Event =
  | { t: "startObject"; o: number }
  | { t: "endObject"; o: number }
  | { t: "startArray"; o: number }
  | { t: "endArray"; o: number }
  | { t: "key"; v: string; cp: number; s: number; e: number }
  | { t: "string"; v: string; cp: number; s: number; e: number }
  | { t: "number"; v: number; raw: string; s: number; e: number }
  | { t: "boolean"; v: boolean; s: number; e: number }
  | { t: "null"; s: number; e: number };

/**
 * Records a normalized event stream and reconstructs the JS value, so a
 * test can assert both event-stream equality across chunkings and value
 * parity with `JSON.parse`.
 */
class Recorder implements JsonEventHandler {
  events: Event[] = [];
  private stack: Array<{ container: unknown; key: string | null }> = [];
  private root: unknown = undefined;
  private curString = "";
  private stringStartOffset = 0;

  get value(): unknown {
    return this.root;
  }

  private addValue(v: unknown): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.root = v;
      return;
    }
    if (Array.isArray(top.container)) top.container.push(v);
    else (top.container as Record<string, unknown>)[top.key as string] = v;
  }

  onStartObject(o: number): void {
    this.events.push({ t: "startObject", o });
    const container = {};
    this.addValue(container);
    this.stack.push({ container, key: null });
  }
  onEndObject(o: number): void {
    this.events.push({ t: "endObject", o });
    this.stack.pop();
  }
  onStartArray(o: number): void {
    this.events.push({ t: "startArray", o });
    const container: unknown[] = [];
    this.addValue(container);
    this.stack.push({ container, key: null });
  }
  onEndArray(o: number): void {
    this.events.push({ t: "endArray", o });
    this.stack.pop();
  }
  onKey(v: string, cp: number, s: number, e: number): void {
    this.events.push({ t: "key", v, cp, s, e });
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined) top.key = v;
  }
  onStringStart(o: number): void {
    this.curString = "";
    this.stringStartOffset = o;
  }
  onStringChunk(chunk: string): void {
    this.curString += chunk;
  }
  onStringEnd(cp: number, s: number, e: number): void {
    this.events.push({ t: "string", v: this.curString, cp, s, e });
    this.addValue(this.curString);
  }
  onNumber(v: number, raw: string, s: number, e: number): void {
    this.events.push({ t: "number", v, raw, s, e });
    this.addValue(v);
  }
  onBoolean(v: boolean, s: number, e: number): void {
    this.events.push({ t: "boolean", v, s, e });
    this.addValue(v);
  }
  onNull(s: number, e: number): void {
    this.events.push({ t: "null", s, e });
    this.addValue(null);
  }
}

/** Tokenize `bytes` split into chunks of `chunkSize` (0 = single shot). */
function run(bytes: Uint8Array, chunkSize = 0): Recorder {
  const rec = new Recorder();
  const tok = new JsonTokenizer(rec);
  if (chunkSize <= 0) {
    tok.write(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      tok.write(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
  }
  tok.end();
  return rec;
}

const VALID_DOCS: string[] = [
  "42",
  "-0",
  "0.5",
  "1e10",
  "-1.25e-3",
  '"hello"',
  '""',
  "true",
  "false",
  "null",
  "[]",
  "{}",
  "[1,2,3]",
  '{"a":1,"b":[true,null,"x"]}',
  '{"nested":{"deep":{"x":[1,{"y":2}]}}}',
  '  {  "a" : 1 ,\n"b"\t: 2 }  ',
  '"escapes: \\" \\\\ \\/ \\b \\f \\n \\r \\t"',
  '"unicode: \\u00e9 \\u0041"',
  '"astral escape: \\ud83d\\ude00"',
  '"astral literal: \u{1f600}"',
  '"mixed é\u{1f600}text"',
  '{"\\u006b\\u0065\\u0079":"value"}',
  // A BOM is a legal character inside a string value, and only a decoder
  // that keeps it can compare `const` / `enum` / `pattern` against what
  // the caller actually sent (#851).
  '"\ufeffleading BOM"',
  '{"a":"\ufeff","b":"x\ufeffy"}',
  // A decoded run that follows an ended stream starts at the opening
  // quote or after an escape; a chunk end keeps the stream open. These
  // pin a key (the same run, a louder failure, since `required` and
  // `additionalProperties` both misfire on a renamed key) and a
  // post-escape run.
  '{"\ufeffk":1}',
  '"a\\n\ufeffb"',
  '[{"a":[]},{"b":{}},[]]',
  '"lone surrogate: \\ud800 end"',
];

describe("JsonTokenizer value parity with JSON.parse", () => {
  for (const doc of VALID_DOCS) {
    it(`reconstructs ${JSON.stringify(doc)}`, () => {
      const rec = run(enc.encode(doc));
      expect(rec.value).toEqual(JSON.parse(doc));
    });
  }
});

describe("JsonTokenizer chunk-boundary invariance", () => {
  for (const doc of VALID_DOCS) {
    it(`same events + value at every chunk size for ${JSON.stringify(doc)}`, () => {
      const bytes = enc.encode(doc);
      const whole = run(bytes);
      const expectedValue = JSON.parse(doc);
      expect(whole.value).toEqual(expectedValue);
      // Replay split at every chunk size, including byte-by-byte (size 1).
      for (let size = 1; size <= bytes.length; size++) {
        const rec = run(bytes, size);
        expect(rec.events, `chunkSize=${size}`).toEqual(whole.events);
        expect(rec.value, `chunkSize=${size}`).toEqual(expectedValue);
      }
    });
  }
});

/**
 * Malformed UTF-8, as raw bytes. `VALID_DOCS` takes its expectations from
 * `JSON.parse` of a JS string, so it can only ever describe well-formed
 * input, and no suite fed bytes a decoder must replace. That is the gap
 * #886 sat in: the delivered value depended on where the `write` boundary
 * fell, which no well-formed document can show.
 *
 * The oracle is `JSON.parse(Buffer.from(bytes).toString("utf8"))`, which
 * is what a caller buffering the whole body would get.
 */
const MALFORMED_DOCS: Array<[string, Uint8Array]> = [
  // A truncated 4-byte lead, an escape, then the continuation byte that
  // would have completed it. Split before the backslash, the held bytes
  // used to survive the escape and merge with the byte after it into
  // U+1F600, so the value was `"\n\u{1f600}"` at one chunk size and
  // `"\ufffd\n\ufffd"` at every other (#886).
  [
    "truncated lead, escape, stray continuation",
    Uint8Array.from([0x22, 0xf0, 0x9f, 0x98, 0x5c, 0x6e, 0x80, 0x22]),
  ],
  // The same shape against a `\uXXXX` escape rather than a two-char one.
  [
    "truncated lead, \\u escape, stray continuation",
    Uint8Array.from([0x22, 0xe2, 0x82, 0x5c, 0x75, 0x30, 0x30, 0x34, 0x31, 0x80, 0x22]),
  ],
  // A truncated sequence a high surrogate escape precedes and a low one
  // follows: the flush has to separate the pair the way a literal run does.
  [
    "surrogate escape, truncated lead, surrogate escape",
    Uint8Array.from([
      0x22, 0x5c, 0x75, 0x64, 0x38, 0x33, 0x64, 0xf0, 0x9f, 0x5c, 0x75, 0x64, 0x65, 0x30, 0x30,
      0x22,
    ]),
  ],
  // Truncated immediately before the closing quote: the case #852 fixed,
  // kept here so the flush cannot regress in the other direction.
  [
    "truncated lead before the closing quote",
    Uint8Array.from([0x22, 0x61, 0xf0, 0x9f, 0x98, 0x22]),
  ],
  // Stray continuation bytes are one U+FFFD each and no lead byte.
  ["stray continuation bytes", Uint8Array.from([0x22, 0x80, 0x80, 0x80, 0x22])],
  // A key, not a value: the same run reaches `keyBuf` instead of the
  // handler, and a renamed key misfires `required` as well as the value.
  [
    "truncated lead in a key",
    Uint8Array.from([0x7b, 0x22, 0xf0, 0x9f, 0x98, 0x5c, 0x6e, 0x80, 0x22, 0x3a, 0x31, 0x7d]),
  ],
];

describe("JsonTokenizer value parity with JSON.parse for malformed UTF-8", () => {
  for (const [label, bytes] of MALFORMED_DOCS) {
    it(`reconstructs ${label}`, () => {
      const expected: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(run(bytes).value).toEqual(expected);
    });
  }
});

describe("JsonTokenizer chunk-boundary invariance for malformed UTF-8", () => {
  for (const [label, bytes] of MALFORMED_DOCS) {
    it(`same events + value at every chunk size for ${label}`, () => {
      const whole = run(bytes);
      const expectedValue: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(whole.value).toEqual(expectedValue);
      for (let size = 1; size <= bytes.length; size++) {
        const rec = run(bytes, size);
        expect(rec.events, `chunkSize=${size}`).toEqual(whole.events);
        expect(rec.value, `chunkSize=${size}`).toEqual(expectedValue);
      }
    });
  }
});

describe("JsonTokenizer escape-aware code-point length", () => {
  const cases: Array<[string, number]> = [
    ['"abc"', 3],
    ['"\\n\\t"', 2], // two two-char escapes = 2 code points
    ['"\\u00e9"', 1], // a six-char \u escape = 1
    ['"\\ud83d\\ude00"', 1], // surrogate-escape pair = 1
    ['"\u{1f600}"', 1], // astral literal = 1 (4 UTF-8 bytes)
    ['"\\ud800"', 1], // lone high-surrogate escape = 1
    ['"a\u{1f600}b"', 3],
    ['"\\u00e9\u{1f600}"', 2],
    // The counter measures the decode's output (#852), so it dropped the
    // BOM alongside the value and this case fails without the fix too.
    ['"\ufeffa"', 2],
  ];
  for (const [doc, expected] of cases) {
    it(`counts ${JSON.stringify(doc)} as ${expected} code points`, () => {
      const rec = run(enc.encode(doc));
      const ev = rec.events[0];
      expect(ev?.t).toBe("string");
      if (ev?.t === "string") expect(ev.cp).toBe(expected);
    });
  }

  it("counts key length escape-aware", () => {
    const rec = run(enc.encode('{"\\ud83d\\ude00":1}'));
    const key = rec.events.find((e) => e.t === "key");
    expect(key?.t).toBe("key");
    if (key?.t === "key") {
      expect(key.v).toBe("\u{1f600}");
      expect(key.cp).toBe(1);
    }
  });
});

describe("JsonTokenizer rejects malformed input (matching JSON.parse)", () => {
  const bad: string[] = [
    "", // no value
    "   ", // whitespace only
    "42x", // trailing garbage
    // The other half of the BOM contract: inside a string it is content,
    // at the document start it is a parse error, which is what
    // `JSON.parse` does and RFC 8259 8.1 permits (#851).
    "\ufeff42",
    "1 2", // two top-level texts
    "[1,]", // trailing comma
    "[1 2]", // missing comma
    "{}}", // trailing close
    '{"a":1,}', // trailing comma in object
    '{"a"}', // missing colon + value
    '{"a":}', // missing value
    "{a:1}", // unquoted key
    "[", // unclosed array
    "{", // unclosed object
    '"unterminated', // unterminated string
    "01", // leading zero
    "1.", // bare decimal point
    ".5", // leading decimal point
    "1e", // dangling exponent
    "+1", // leading plus
    '"bad \\x escape"', // invalid escape
    '"bad \\u00zz"', // invalid \u hex
    "[1,2", // unclosed after elements
    "nul", // truncated literal
    "tru", // truncated literal
    "True", // wrong case
  ];
  for (const doc of bad) {
    it(`rejects ${JSON.stringify(doc)}`, () => {
      // JSON.parse must also reject it (sanity on the test corpus).
      expect(() => JSON.parse(doc)).toThrow();
      expect(() => run(enc.encode(doc))).toThrow(JsonParseError);
      // Rejection is chunk-invariant: byte-by-byte also throws.
      expect(() => run(enc.encode(doc), 1)).toThrow(JsonParseError);
    });
  }

  it("carries the byte offset on the error", () => {
    try {
      run(enc.encode("42x"));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonParseError);
      expect((err as JsonParseError).byteOffset).toBe(2);
    }
  });
});

describe("JsonTokenizer number values", () => {
  for (const raw of ["0", "-0", "123", "-123", "1.5", "1e3", "1E3", "-1.5e-10", "2.5e+2"]) {
    it(`parses ${raw} as ${Number(raw)}`, () => {
      const rec = run(enc.encode(raw));
      expect(rec.value).toBe(Number(raw));
    });
  }

  it("yields Infinity for an overflowing literal, like JSON.parse", () => {
    const rec = run(enc.encode("1e400"));
    expect(rec.value).toBe(JSON.parse("1e400"));
    expect(rec.value).toBe(Infinity);
  });
});
