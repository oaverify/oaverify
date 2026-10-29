import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import {
  analyzeStreamability,
  BufferLimitError,
  createStreamValidator,
  type SchemaViolation,
  type ValueEvent,
} from "../src/index.js";

const enc = new TextEncoder();

interface Run {
  valid?: boolean;
  peak?: number;
  codes: string[];
  values: ValueEvent[];
  error?: unknown;
}

/**
 * Stream `json` through the engine. `chunkSize > 0` writes it in slices of
 * that many bytes, which splits strings across chunks.
 */
async function run(
  schema: SchemaOrBoolean,
  json: string,
  opts: Record<string, unknown> = {},
  chunkSize = 0,
): Promise<Run> {
  const v = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  } as never);
  const codes: string[] = [];
  const values: ValueEvent[] = [];
  v.on("violation", (e: SchemaViolation) => codes.push(e.code));
  v.on("value", (e: ValueEvent) => values.push(e));
  v.on("error", () => {});
  v.resume();
  const result = v.result;
  const bytes = Buffer.from(enc.encode(json));
  if (chunkSize > 0) {
    for (let i = 0; i < bytes.length; i += chunkSize) v.write(bytes.subarray(i, i + chunkSize));
    v.end();
  } else {
    v.end(bytes);
  }
  try {
    const r = await result;
    return { valid: r.valid, peak: r.peakBufferedBytes, codes, values };
  } catch (error) {
    return { codes, values, error };
  }
}

const big = "x".repeat(100_000);

describe("scalar enum/const strings hold at most the longest candidate (#1193)", () => {
  const cases: Array<{
    schema: SchemaObject;
    wrap: (s: string) => string;
    good: string[];
    bad: string[];
  }> = [
    {
      schema: { enum: ["a", "bb"] },
      wrap: (s) => s,
      good: ['"a"', '"bb"'],
      bad: ['"c"', '"bbb"', '"abc"', JSON.stringify(big)],
    },
    {
      schema: { const: "abc" },
      wrap: (s) => s,
      good: ['"abc"'],
      bad: ['"ab"', '"abcd"', JSON.stringify(big)],
    },
    {
      schema: { type: "object", properties: { k: { enum: ["a", "bb"] } } },
      wrap: (s) => `{"k":${s}}`,
      good: ['"a"', '"bb"'],
      bad: ['"bbb"', JSON.stringify(big)],
    },
    {
      // Unicode: candidates and input compare in UTF-16 units, raw or escaped.
      schema: { enum: ["é\u{1F600}"] },
      wrap: (s) => s,
      good: ['"é\u{1F600}"', '"\\u00e9\\ud83d\\ude00"'],
      bad: ['"é\u{1F600}x"', '"\\u00e9\\ud83d\\ude00\\u00e9"'],
    },
  ];

  for (const c of cases) {
    for (const chunkSize of [0, 1, 3]) {
      it(`${JSON.stringify(c.schema)} keeps its verdicts (chunk ${chunkSize})`, async () => {
        for (const g of c.good) {
          const r = await run(c.schema, c.wrap(g), {}, chunkSize);
          expect(r.valid, g).toBe(true);
        }
        for (const b of c.bad) {
          const r = await run(c.schema, c.wrap(b), {}, chunkSize);
          expect(r.valid, b.slice(0, 20)).toBe(false);
          expect(r.codes, b.slice(0, 20)).toEqual([
            "enum" in c.schema || "properties" in c.schema ? "enum" : "const",
          ]);
        }
      });
    }
  }

  it("holds a long mismatch only up to the longest candidate, under any cap", async () => {
    for (const chunkSize of [0, 1000]) {
      const r = await run(
        { enum: ["a", "bb"] },
        JSON.stringify(big),
        { maxBufferedBytes: 1000 },
        chunkSize,
      );
      expect(r.error).toBeUndefined();
      expect(r.valid).toBe(false);
      expect(r.codes).toEqual(["enum"]);
      expect(r.peak).toBeLessThanOrEqual(1000);
    }
  });

  it("holds nothing for a string against an enum with no string candidate", async () => {
    const r = await run({ enum: [1, 2] }, JSON.stringify(big), { maxBufferedBytes: 10 });
    expect(r.error).toBeUndefined();
    expect(r.valid).toBe(false);
    expect(r.codes).toEqual(["enum"]);
    expect(r.peak).toBe(0);
  });

  it("still caps a candidate longer than maxBufferedBytes", async () => {
    const long = "y".repeat(2000);
    const r = await run({ enum: [long] }, JSON.stringify(long), { maxBufferedBytes: 1000 });
    expect(r.error).toBeInstanceOf(BufferLimitError);
  });

  it("keeps full retention when a pattern needs the text", async () => {
    const r = await run({ enum: ["aa"], pattern: "^x+$" }, JSON.stringify(big), {
      maxBufferedBytes: 1000,
    });
    expect(r.error).toBeInstanceOf(BufferLimitError);
    const ok = await run({ enum: ["aa"], pattern: "^x+$" }, JSON.stringify("x".repeat(500)));
    expect(ok.codes).toEqual(["enum"]);
    expect(ok.peak).toBe(502);
  });

  it("reports each schema's equality failure as before", async () => {
    // Two applicable schemas through a co-located $ref: "aaaa" fails only
    // the shorter set; a longer string fails both.
    const schema = { $ref: "#/$defs/A", enum: ["aaaa"], $defs: { A: { enum: ["a"] } } };
    expect((await run(schema, '"aaaa"', {}, 1)).codes).toEqual(["enum"]);
    expect((await run(schema, '"aaaaa"', {}, 1)).codes).toEqual(["enum", "enum"]);
    expect((await run(schema, '"a"', {}, 1)).codes).toEqual(["enum"]);
  });

  it("keeps the exact failure set when co-located candidates differ in length", async () => {
    // The node's const is longer than the referenced enum's candidate, so
    // "abcd" fails only the enum, and anything longer fails both.
    const schema = { $ref: "#/$defs/A", const: "abcd", $defs: { A: { enum: ["a"] } } };
    for (const chunkSize of [0, 1]) {
      expect((await run(schema, '"abcd"', {}, chunkSize)).codes).toEqual(["enum"]);
      expect((await run(schema, '"abcde"', {}, chunkSize)).codes.sort()).toEqual(["const", "enum"]);
    }
  });

  it("keeps type and length checks on a string past the bound", async () => {
    const long = JSON.stringify("z".repeat(100));
    const codes = async (schema: SchemaObject) => (await run(schema, long, {}, 7)).codes.sort();
    expect(await codes({ type: "string", minLength: 200, enum: ["a"] })).toEqual([
      "enum",
      "minLength",
    ]);
    expect(await codes({ type: "string", maxLength: 5, enum: ["a"] })).toEqual([
      "enum",
      "maxLength",
    ]);
    expect(await codes({ type: "integer", enum: ["a"] })).toEqual(["enum", "type"]);
    expect(await codes({ type: "string", minLength: 50, enum: ["a"] })).toEqual(["enum"]);
  });

  it("counts and caps the prefix held before an overshooting chunk", async () => {
    const schema = { enum: ["a".repeat(10)] };
    const json = JSON.stringify("a".repeat(20)); // 22 source bytes
    const r = await run(schema, json, {}, 4);
    expect(r.valid).toBe(false);
    expect(r.peak).toBeGreaterThan(0);
    expect(r.peak).toBeLessThan(22);
    expect(r.peak).toBeLessThanOrEqual(analyzeStreamability(schema).peakBytes as number);
    // The held prefix still answers to maxBufferedBytes.
    expect((await run(schema, json, { maxBufferedBytes: 3 }, 1)).error).toBeInstanceOf(
      BufferLimitError,
    );
  });

  it("caps a candidate-sized prefix whose span is known only at the overshoot", async () => {
    // The first write is the opening quote plus a full candidate; the
    // overshoot arrives in the next one, which reveals the held span.
    const schema = { enum: ["abcdefghij"] };
    const json = '"abcdefghijx"';
    expect((await run(schema, json, { maxBufferedBytes: 3 }, 11)).error).toBeInstanceOf(
      BufferLimitError,
    );
    const r = await run(schema, json, {}, 11);
    expect(r.codes).toEqual(["enum"]);
    expect(r.peak).toBe(11);
    expect(r.peak).toBeLessThanOrEqual(analyzeStreamability(schema).peakBytes as number);
  });

  it("counts only the held prefix when an escape overshoots", async () => {
    // "ab" spelled raw and with an escaped b: at most `"a` (2 bytes) is held,
    // and nothing when one slice carries the whole overshoot.
    const schema = { enum: ["a"] };
    for (const json of ['"ab"', '"a\\u0062"', '"a\\u0062\\u0063"']) {
      for (const chunkSize of [0, 1, 2]) {
        const capped = await run(schema, json, { maxBufferedBytes: 3 }, chunkSize);
        expect(capped.error, `${json} chunk ${chunkSize}`).toBeUndefined();
        expect(capped.codes).toEqual(["enum"]);
        const r = await run(schema, json, {}, chunkSize);
        expect(r.peak, `${json} chunk ${chunkSize}`).toBeLessThanOrEqual(2);
        expect(r.peak).toBeLessThanOrEqual(analyzeStreamability(schema).peakBytes as number);
      }
    }
  });

  it("counts only the held prefix when a write ends inside a character", async () => {
    const schema = { enum: ["a"] };
    const v = createStreamValidator(schema, {
      policy: "detach",
      maxErrors: Number.POSITIVE_INFINITY,
      maxBufferedBytes: 3,
    });
    const codes: string[] = [];
    v.on("violation", (e: SchemaViolation) => codes.push(e.code));
    v.on("error", () => {});
    v.resume();
    const result = v.result;
    const bytes = Buffer.from(enc.encode('"a\u{1F600}"'));
    v.write(bytes.subarray(0, 4));
    v.write(bytes.subarray(4));
    v.end();
    const r = await result;
    expect(codes).toEqual(["enum"]);
    expect(r.peakBufferedBytes).toBe(2);
  });

  it("holds nothing for an empty string when no candidate is a string", async () => {
    const cases: Array<[SchemaObject, string]> = [
      [{ enum: [1, 2] }, "enum"],
      [{ const: 1 }, "const"],
    ];
    for (const [schema, code] of cases) {
      const r = await run(schema, '""', { maxBufferedBytes: 1 });
      expect(r.error).toBeUndefined();
      expect(r.codes).toEqual([code]);
      expect(r.peak).toBe(0);
      expect(analyzeStreamability(schema).peakBytes).toBe(0);
    }
    const captured = await run({ type: "object", properties: { k: { enum: [1] } } }, '{"k":""}', {
      valueEvents: { at: ["k"], capture: true },
    });
    expect(captured.codes).toEqual(["enum"]);
    expect(captured.values.map((e) => e.value)).toEqual([""]);
  });

  it("still delivers a captured value past the equality bound", async () => {
    const schema = { type: "object", properties: { k: { enum: ["a"] } } };
    const r = await run(
      schema,
      '{"k":"hello world"}',
      { valueEvents: { at: ["k"], capture: true } },
      2,
    );
    expect(r.valid).toBe(false);
    expect(r.values.map((e) => e.value)).toEqual(["hello world"]);
  });
});

describe("analyzer reports the scalar equality bound (#1193)", () => {
  it("sizes string enum and const candidates", () => {
    expect(analyzeStreamability({ enum: ["a", "bb"] })).toEqual({
      classification: "buffer",
      peakBytes: 2 * 6 + 2,
      effectivePeakBytes: 2 * 6 + 2,
      positions: [{ path: "", classification: "buffer", keyword: "enum", maxBytes: 14 }],
    });
    expect(analyzeStreamability({ const: "abc" }).peakBytes).toBe(3 * 6 + 2);
    expect(
      analyzeStreamability({ type: "object", properties: { k: { enum: ["a"] } } }).positions,
    ).toEqual([{ path: "k", classification: "buffer", keyword: "enum", maxBytes: 8 }]);
  });

  it("reports nothing when no candidate is a string", () => {
    expect(analyzeStreamability({ enum: [1, 2] })).toMatchObject({
      classification: "streamable",
      peakBytes: 0,
      positions: [],
    });
  });

  it("bounds what the engine holds, matching or not", async () => {
    const schema = { enum: ["é\u{1F600}", "bb"] };
    const bound = analyzeStreamability(schema).peakBytes as number;
    for (const json of ['"é\u{1F600}"', '"bb"', JSON.stringify(big)]) {
      for (const chunkSize of [0, 1]) {
        const r = await run(schema, json, {}, chunkSize);
        expect(r.peak, json.slice(0, 10)).toBeLessThanOrEqual(bound);
      }
    }
  });
});
