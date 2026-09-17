/**
 * Malformed UTF-8 in the input bytes (`utf8`).
 *
 * The default (`"reject"`) fails the stream at the offending byte. The
 * opt-out (`"replace"`) keeps the replacing decode, whose chunk-boundary
 * invariants `tokenizer.test.ts` and `string-length-counter.test.ts`
 * pin.
 *
 * What makes the check sound is that it reads the encoding rather than
 * the decoded text: a sender's own U+FFFD is well-formed UTF-8 and is
 * accepted, where a "the value contains U+FFFD" test would reject it.
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { ValidationFailedError, createStreamValidator } from "../src/index.js";
import type { StreamValidatorOptions } from "../src/options.js";
import { JsonParseError } from "../src/tokenizer/index.js";

type Outcome =
  | { kind: "accept"; echoed: Buffer }
  | { kind: "reject"; codes: string[] }
  | { kind: "parseError"; message: string; byteOffset: number };

async function feed(
  schema: SchemaOrBoolean,
  chunks: Uint8Array[],
  options: StreamValidatorOptions = {},
): Promise<Outcome> {
  const validator = createStreamValidator(schema, {
    maxErrors: Number.POSITIVE_INFINITY,
    ...options,
  });
  validator.on("error", () => {});
  const echoed: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      echoed.push(Buffer.from(chunk));
      cb();
    },
  });
  try {
    await pipeline(Readable.from(chunks.map((c) => Buffer.from(c))), validator, sink);
  } catch (err) {
    if (err instanceof JsonParseError) {
      return { kind: "parseError", message: err.message, byteOffset: err.byteOffset };
    }
    // A violation under the default `policy: "terminate"` rejects the
    // pipeline as well; the verdict below carries it.
    if (!(err instanceof ValidationFailedError)) throw err;
  }
  const verdict = await validator.result;
  return verdict.valid
    ? { kind: "accept", echoed: Buffer.concat(echoed) }
    : { kind: "reject", codes: verdict.violations.map((v) => v.code) };
}

/** `{"s":"<bad>"}`, with the malformed bytes at offset 6. */
function inValue(bad: number[]): Uint8Array[] {
  return [Uint8Array.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, ...bad, 0x22, 0x7d])];
}

const STRING = { type: "object", properties: { s: { type: "string" } } } as const;

// Every shape RFC 3629 excludes, with the offset of its first byte in
// `inValue`'s document.
const ILL_FORMED: Array<[string, number[]]> = [
  ["a surrogate (ED A0 80)", [0xed, 0xa0, 0x80]],
  ["an overlong NUL (C0 80)", [0xc0, 0x80]],
  ["an overlong solidus (C0 AF)", [0xc0, 0xaf]],
  ["a bare continuation byte (80)", [0x80]],
  ["a truncated sequence (E2 82)", [0xe2, 0x82]],
  ["a lead past U+10FFFF (F5 80 80 80)", [0xf5, 0x80, 0x80, 0x80]],
];

describe("utf8: reject (the default)", () => {
  for (const [label, bad] of ILL_FORMED) {
    it(`fails the stream on ${label}`, async () => {
      const out = await feed(STRING, inValue(bad));
      expect(out.kind).toBe("parseError");
      if (out.kind !== "parseError") return;
      expect(out.byteOffset).toBe(6);
    });
  }

  it("fails on ill-formed bytes in a key, not only a value", async () => {
    // `{"k<80>":1}`: the run reaches `keyBuf` rather than the handler.
    const out = await feed({ type: "object" }, [
      Uint8Array.from([0x7b, 0x22, 0x6b, 0x80, 0x22, 0x3a, 0x31, 0x7d]),
    ]);
    expect(out.kind).toBe("parseError");
    if (out.kind !== "parseError") return;
    expect(out.byteOffset).toBe(3);
  });

  it("names the offending byte, not the run's first byte", async () => {
    // Nine well-formed bytes precede the bad one inside the string.
    const out = await feed(STRING, inValue([...Buffer.from("aaaaaaaaa"), 0x80]));
    expect(out.kind).toBe("parseError");
    if (out.kind !== "parseError") return;
    expect(out.byteOffset).toBe(6 + 9);
  });

  it("reports a truncated sequence at the byte that ends the string", async () => {
    const out = await feed(STRING, inValue([0xe2, 0x82]));
    expect(out.kind).toBe("parseError");
    if (out.kind !== "parseError") return;
    expect(out.message).toContain("UTF-8");
  });

  it("fails where the schema routes the string to a buffered island", async () => {
    // `oneOf` delegates to the in-memory engine, which is fed the
    // tokenizer's decoded text, so one decode covers both paths.
    const out = await feed(
      { type: "object", properties: { s: { oneOf: [{ type: "string" }, { type: "number" }] } } },
      inValue([0x80]),
    );
    expect(out.kind).toBe("parseError");
  });

  it("fails under an asserting OpenAPI dialect too", async () => {
    const out = await feed(
      { type: "object", properties: { s: { type: "string", format: "date-time" } } },
      inValue([0x80]),
      { openApiVersion: "3.0" },
    );
    expect(out.kind).toBe("parseError");
  });
});

describe("utf8: reject accepts every well-formed input", () => {
  it("accepts a U+FFFD the sender encoded itself", async () => {
    // The soundness case: replacement output is not a test of the input.
    const out = await feed(STRING, [Buffer.from('{"s":"a�b"}')]);
    expect(out.kind).toBe("accept");
  });

  it("accepts a multibyte character split across writes, at every boundary", async () => {
    const doc = Buffer.from('{"s":"a中\u{1f600}b"}');
    for (let size = 1; size <= doc.length; size++) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < doc.length; i += size) {
        chunks.push(doc.subarray(i, Math.min(i + size, doc.length)));
      }
      const out = await feed(STRING, chunks);
      expect(out.kind, `chunkSize=${size}`).toBe("accept");
    }
  });

  it("still accepts a lone surrogate escape, as JSON.parse does", async () => {
    // The `JSON.parse` anchor is about the grammar and the values it
    // yields. `\uD800` is ASCII on the wire, so the encoding check never
    // sees it.
    const out = await feed(STRING, [Buffer.from('{"s":"\\uD800"}')]);
    expect(out.kind).toBe("accept");
  });

  it("still treats a U+FEFF inside a string as content (#851)", async () => {
    const out = await feed(
      { type: "object", properties: { s: { type: "string", minLength: 3 } } },
      [Buffer.from('{"s":"a﻿b"}')],
    );
    expect(out.kind).toBe("accept");
  });
});

describe('utf8: "replace"', () => {
  it("accepts ill-formed bytes in an unconstrained string and echoes them", async () => {
    const out = await feed(STRING, inValue([0xc0, 0xaf]), { utf8: "replace" });
    expect(out.kind).toBe("accept");
    if (out.kind !== "accept") return;
    expect(out.echoed.includes(Buffer.from([0xc0, 0xaf]))).toBe(true);
  });

  it("rejects them against a printable-ASCII pattern, for U+FFFD's sake", async () => {
    // The pattern rejects the replacement character, not the encoding: a
    // permissive pattern accepts the same bytes, which is why this is no
    // substitute for the check.
    const strict = await feed(
      { type: "object", properties: { s: { type: "string", pattern: "^[\\x20-\\x7E]+$" } } },
      inValue([0xc0, 0xaf]),
      { utf8: "replace" },
    );
    expect(strict).toEqual({ kind: "reject", codes: ["pattern"] });

    const permissive = await feed(
      { type: "object", properties: { s: { type: "string", pattern: "^.+$" } } },
      inValue([0xc0, 0xaf]),
      { utf8: "replace" },
    );
    expect(permissive.kind).toBe("accept");
  });
});

describe("bytes above 0x7F outside a string", () => {
  for (const utf8 of ["reject", "replace"] as const) {
    it(`is a parse error under utf8: "${utf8}"`, async () => {
      // `{"s":<80>1}`: no byte above 0x7F is legal in JSON structure, so
      // this option decides nothing here.
      const out = await feed(
        { type: "object" },
        [Uint8Array.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x80, 0x31, 0x7d])],
        { utf8 },
      );
      expect(out.kind).toBe("parseError");
      if (out.kind !== "parseError") return;
      expect(out.byteOffset).toBe(5);
    });
  }
});
