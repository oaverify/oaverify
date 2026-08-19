import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { createStreamValidator } from "../src/index.js";
import { SpineValidator } from "../src/spine/spine.js";
import type { JsonEventHandler } from "../src/tokenizer/index.js";
import { JsonTokenizer } from "../src/tokenizer/index.js";

/**
 * `minLength` and `maxLength` count one string (#852).
 *
 * The eager `maxLength` check measured each decoded slice as it arrived.
 * The tokenizer emits every `\uXXXX` escape as its own slice, so a
 * surrogate pair arrived as two slices of one lone surrogate each and
 * counted 2, while the escape-aware count `onStringEnd` reports (which
 * `checkScalar` uses for `minLength`) collapses the pair to 1.
 *
 * A one-code-point string therefore failed `maxLength: 1` and passed
 * `minLength: 1`. Both now read the tokenizer's counter.
 *
 * The literal spelling of the same character was always correct, which
 * is why a test written with `"\u{1f600}"` in the source would not have
 * caught this: the defect is specific to the escaped spelling.
 */

const enc = new TextEncoder();

async function verdict(schema: SchemaOrBoolean, text: string, chunkSize = 0): Promise<boolean> {
  const bytes = enc.encode(text);
  const size = chunkSize > 0 ? chunkSize : bytes.length;
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(Buffer.from(bytes.subarray(i, Math.min(i + size, bytes.length))));
  }
  const validator = createStreamValidator(schema);
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  try {
    await pipeline(Readable.from(chunks), validator, sink);
  } catch {
    // An invalid document rejects the pipeline; the verdict is on `result`.
  }
  return (await validator.result).valid;
}

/** Accumulates a string's text and the count the tokenizer reports for it. */
class CountingHandler implements JsonEventHandler {
  text = "";
  reported = -1;
  onStartObject(): void {}
  onEndObject(): void {}
  onStartArray(): void {}
  onEndArray(): void {}
  onKey(): void {}
  onStringStart(): void {}
  onStringChunk(chunk: string): void {
    this.text += chunk;
  }
  onStringEnd(codePoints: number): void {
    this.reported = codePoints;
  }
  onNumber(): void {}
  onBoolean(): void {}
  onNull(): void {}
}

function countOf(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

async function verdictBytes(schema: SchemaOrBoolean, bytes: Uint8Array): Promise<boolean> {
  const validator = createStreamValidator(schema);
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  try {
    await pipeline(Readable.from([Buffer.from(bytes)]), validator, sink);
  } catch {
    // An invalid document rejects the pipeline; the verdict is on `result`.
  }
  return (await validator.result).valid;
}

/** The escaped and the literal spelling of one astral character. */
const ESCAPED = '"\\ud83d\\ude00"';
const LITERAL = '"\u{1f600}"';

describe("minLength and maxLength count the same string", () => {
  it("counts an escaped surrogate pair as one code point", async () => {
    expect(await verdict({ type: "string", maxLength: 1 }, ESCAPED)).toBe(true);
    expect(await verdict({ type: "string", minLength: 1 }, ESCAPED)).toBe(true);
  });

  it("agrees with the literal spelling of the same character", async () => {
    for (const text of [ESCAPED, LITERAL]) {
      expect(await verdict({ type: "string", maxLength: 1 }, text), text).toBe(true);
      expect(await verdict({ type: "string", maxLength: 0 }, text), text).toBe(false);
    }
  });

  it("counts a mixed string once", async () => {
    // "a" + one astral character + "b" is three code points.
    const mixed = '"a\\ud83d\\ude00b"';
    expect(await verdict({ type: "string", maxLength: 3 }, mixed)).toBe(true);
    expect(await verdict({ type: "string", maxLength: 2 }, mixed)).toBe(false);
    expect(await verdict({ type: "string", minLength: 3 }, mixed)).toBe(true);
    expect(await verdict({ type: "string", minLength: 4 }, mixed)).toBe(false);
  });

  it("fails at the offending character, not at the closing quote", () => {
    // The eager check is a resource bound, so where it fires matters as
    // much as the verdict. The existing spine cases cover the literal
    // path; this covers the escaped one, which is what this change moved.
    const json = '"\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00"';
    const spine = new SpineValidator({ type: "string", maxLength: 1 });
    const tok = new JsonTokenizer(spine);
    tok.write(enc.encode(json));
    tok.end();
    const first = spine.verdict().violations[0];
    expect(first?.code).toBe("maxLength");
    // The closing quote is the last byte; failing before it proves the
    // rest of the string did not have to stream first.
    expect(first?.byteOffset).toBeLessThan(json.length - 1);
  });

  it("counts what the decoder produced, not the bytes that went in", async () => {
    // A stray continuation byte is no lead byte and one U+FFFD. Counting
    // lead bytes read 1000 of them as an empty string, so `minLength`
    // rejected 1000 characters as too short and `maxLength` did not bound
    // them at all once it shared the counter (#852).
    const bytes = new Uint8Array(1002);
    bytes[0] = 0x22;
    bytes.fill(0x80, 1, 1001);
    bytes[1001] = 0x22;
    expect(await verdictBytes({ type: "string", maxLength: 1 }, bytes)).toBe(false);
    expect(await verdictBytes({ type: "string", minLength: 1 }, bytes)).toBe(true);
    expect(await verdictBytes({ type: "string", maxLength: 1000 }, bytes)).toBe(true);
    expect(await verdictBytes({ type: "string", maxLength: 999 }, bytes)).toBe(false);
  });

  it("counts a code point the decoder holds across a write boundary", () => {
    // A write ending mid sequence, then one starting with the closing
    // quote, leaves the literal-run branch skipped: the held bytes become
    // U+FFFD at the tail flush. Counting only in that branch left the
    // string one code point short (#852).
    const bytes = Uint8Array.from([0x22, 0xe2, 0x82, 0xe2, 0x22]);
    const cap = new CountingHandler();
    const tok = new JsonTokenizer(cap);
    tok.write(bytes.subarray(0, 4));
    tok.write(bytes.subarray(4));
    tok.end();
    expect(cap.reported).toBe(countOf(cap.text));
    expect(cap.reported).toBe(2);
  });

  it("does not pair surrogate escapes separated by literal text", () => {
    // A stray continuation byte is literal text (one U+FFFD), so it
    // separates the pair. The per-byte reset never ran for it.
    const cap = new CountingHandler();
    const tok = new JsonTokenizer(cap);
    tok.write(
      Uint8Array.from([0x22, ...enc.encode("\\ud83d"), 0x80, ...enc.encode("\\ude00"), 0x22]),
    );
    tok.end();
    expect(cap.reported).toBe(countOf(cap.text));
    expect(cap.reported).toBe(3);
  });

  it("reports the same count the value has, over randomized inputs", () => {
    // The counter and the string are one thing, so a differential is the
    // honest check. Deterministic seed; every mismatch on main is a real
    // divergence between what was counted and what was delivered.
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    // The alphabet has to include escapes and truncated sequences, not
    // just random bytes: the split-sensitive cases live in the
    // interaction between them.
    const pieces: number[][] = [
      [0x41],
      [0xc3, 0xa9],
      [0xe2, 0x82, 0xac],
      [0xf0, 0x9f, 0x98, 0x80],
      [0xc3],
      [0xf0, 0x9f],
      [0x80],
      [0xef, 0xbb, 0xbf],
      [...enc.encode("\\n")],
      [...enc.encode("\\ud83d")],
      [...enc.encode("\\ude00")],
    ];
    let mismatches = 0;
    let valueMismatches = 0;
    let checked = 0;
    for (let t = 0; t < 4000; t++) {
      const body: number[] = [];
      for (let k = 0, len = 1 + rnd(5); k < len; k++) {
        body.push(...(pieces[rnd(pieces.length)] as number[]));
      }
      const bytes = Uint8Array.from([0x22, ...body, 0x22]);
      const split = rnd(bytes.length + 1);
      const cap = new CountingHandler();
      const tok = new JsonTokenizer(cap);
      try {
        tok.write(bytes.subarray(0, split));
        tok.write(bytes.subarray(split));
        tok.end();
      } catch {
        continue; // a malformed document is not this test's subject
      }
      checked++;
      if (cap.reported !== countOf(cap.text)) mismatches++;
      // The count agreeing with the delivered text says nothing about
      // whether that text is right. Malformed input makes the two
      // separate questions, and #886 was wrong on the second while
      // staying consistent on the first, so the oracle a caller
      // buffering the whole body would get is checked too.
      if (cap.text !== JSON.parse(Buffer.from(bytes).toString("utf8"))) valueMismatches++;
    }
    expect({ checked, mismatches, valueMismatches }).toEqual({
      checked,
      mismatches: 0,
      valueMismatches: 0,
    });
    expect(checked).toBeGreaterThan(3000);
  });

  it("agrees with the delivered string where a truncated sequence precedes an escape", () => {
    // A truncated sequence between two `\uXXXX` escapes. The decoder used
    // to hold the partial past the escape, so the two surrogate halves
    // landed adjacent and paired into one astral character the sender
    // never sent, while the counter treated the held bytes as text
    // between them: the value was wrong and the count led it by one
    // (#886). The flush before an escape separates them, and the result
    // is what a caller buffering the whole body would parse.
    const bytes = Uint8Array.from([
      0x22,
      ...enc.encode("\\ud83d"),
      0xf0,
      0x9f,
      ...enc.encode("\\ude00"),
      0x22,
    ]);
    const cap = new CountingHandler();
    const tok = new JsonTokenizer(cap);
    // The split has to leave the partial held when the escape arrives.
    tok.write(bytes.subarray(0, 9));
    tok.write(bytes.subarray(9));
    tok.end();
    // U+D83D, one U+FFFD for the truncated pair, U+DE00: the halves stay
    // unpaired, and `Buffer#toString` replaces `f0 9f` with a single
    // U+FFFD rather than one per byte.
    expect(cap.text).toBe(JSON.parse(Buffer.from(bytes).toString("utf8")));
    expect(countOf(cap.text)).toBe(3);
    expect(cap.reported).toBe(countOf(cap.text));
  });

  it("still rejects a string over the cap, at every chunk size", async () => {
    for (const size of [0, 1, 2, 3, 5]) {
      expect(await verdict({ type: "string", maxLength: 1 }, '"ab"', size), `size=${size}`).toBe(
        false,
      );
      expect(await verdict({ type: "string", maxLength: 1 }, ESCAPED, size), `size=${size}`).toBe(
        true,
      );
    }
  });

  it("counts a two-character escape as one code point", async () => {
    expect(await verdict({ type: "string", maxLength: 2 }, '"\\n\\t"')).toBe(true);
    expect(await verdict({ type: "string", maxLength: 1 }, '"\\n\\t"')).toBe(false);
  });

  it("counts a lone surrogate escape as one code point", async () => {
    // Accepted, matching JSON.parse, and it is one code point either way.
    expect(await verdict({ type: "string", maxLength: 1 }, '"\\ud800"')).toBe(true);
    expect(await verdict({ type: "string", maxLength: 0 }, '"\\ud800"')).toBe(false);
  });
});
