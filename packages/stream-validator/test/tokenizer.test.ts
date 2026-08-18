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
  // A decoded run starts at the opening quote, after an escape, and
  // after a chunk boundary. These pin the other two: a key (the same
  // run, a louder failure, since `required` and `additionalProperties`
  // both misfire on a renamed key) and a post-escape run.
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
    // The counter was already right when the decoder dropped the BOM from
    // the value (#851), so this pins the half that never broke.
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
