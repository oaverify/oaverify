import { describe, expect, it } from "vitest";
import type { SchemaObject } from "@oaverify/internal-core";
import {
  analyzeStreamability,
  createStreamValidator,
  type StreamValidatorOptions,
} from "../src/index.js";

// The analyzer's figures bound the source span of any accepted spelling:
// a valid input never buffers more than `peakBytes`, nor more than
// `effectivePeakBytes` under the same options.
async function observedPeak(
  schema: SchemaObject,
  input: string,
  options: StreamValidatorOptions = {},
): Promise<number> {
  const v = createStreamValidator(schema, { ...options, maxErrors: Number.POSITIVE_INFINITY });
  v.on("error", () => {});
  v.resume();
  v.end(Buffer.from(input));
  const r = await v.result;
  expect(r.violations).toEqual([]);
  return r.peakBufferedBytes;
}

const oas = { openApiVersion: "3.1" } as const;
const patterned = (maxLength: number) => ({ type: "string", maxLength, pattern: "^.*$" });

describe("analyzer byte figures are upper bounds (#1228)", () => {
  it.each([
    [
      "an escaped surrogate pair per code point",
      { type: "string", maxLength: 2, pattern: "^.*$" },
      '"\\ud83d\\ude00\\ud83d\\ude00"',
      {},
    ],
    [
      "a raw supplementary character",
      { type: "string", maxLength: 2, pattern: "^.*$" },
      '"\u{1F600}\u{1F600}"',
      {},
    ],
    [
      "an escaped format string",
      { type: "string", maxLength: 10, format: "date" },
      '"\\u0032020-01-01"',
      oas,
    ],
    ["an escaped string enum", { enum: ["ab", "c"] }, '"\\u0061\\u0062"', {}],
    ["an escaped string const", { const: "\u{1F600}" }, '"\\ud83d\\ude00"', {}],
    [
      "an escaped string enum member",
      { type: "object", properties: { k: { enum: ["on"] } } },
      '{"k":"\\u006f\\u006e"}',
      {},
    ],
  ] as const)("bounds %s by peakBytes", async (_name, schema, input, options) => {
    const report = analyzeStreamability(schema as SchemaObject, options);
    expect(typeof report.peakBytes).toBe("number");
    const peak = await observedPeak(schema as SchemaObject, input, options);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(report.peakBytes as number);
  });

  it.each([
    [
      "whitespace inside a closed object",
      {
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "boolean" } },
        dependentSchemas: { a: {} },
      },
      `{"a"${" ".repeat(200)}:true}`,
      {},
    ],
    [
      "whitespace inside a bounded array",
      { type: "array", maxItems: 1, uniqueItems: true, items: { type: "boolean" } },
      `[${" ".repeat(200)}true]`,
      {},
    ],
    [
      "a long number spelling in an array",
      { type: "array", maxItems: 1, uniqueItems: true, items: { type: "number" } },
      `[1.${"0".repeat(200)}]`,
      {},
    ],
    ["a respelled object const", { const: { a: 1 } }, `{ "a" : 1.${"0".repeat(50)} }`, {}],
  ] as const)("reports %s as unbounded", async (_name, schema, input, options) => {
    expect(analyzeStreamability(schema as SchemaObject, options).peakBytes).toBe("unbounded");
    // The spelling really does exceed the old finite figures.
    expect(await observedPeak(schema as SchemaObject, input, options)).toBeGreaterThan(50);
  });

  it("bounds overlapping property and pattern obligations", async () => {
    const two = { allOf: [patterned(1), patterned(1)] };
    const schema = {
      type: "object",
      properties: { x: two },
      patternProperties: { "^x$": two },
    } as unknown as SchemaObject;
    const peak = await observedPeak(schema, '{"x":"\\ud83d\\ude00"}');
    expect(peak).toBe(56);
    expect(peak).toBeLessThanOrEqual(analyzeStreamability(schema).peakBytes as number);
  });

  it("bounds a branch that fails while another accepts", async () => {
    const schema = { anyOf: [patterned(1), {}] } as unknown as SchemaObject;
    const options = { maxBufferedBytes: 200 };
    const peak = await observedPeak(schema, JSON.stringify("a".repeat(100)), options);
    expect(peak).toBeGreaterThan(100);
    expect(peak).toBeLessThanOrEqual(
      analyzeStreamability(schema, options).effectivePeakBytes as number,
    );
  });

  describe("recursion", () => {
    const nest = (inner: string, depth: number, key: string): string => {
      let out = inner;
      for (let i = 0; i < depth; i++) out = `{"${key}":${out}}`;
      return out;
    };

    it("reports a cycle through a TEE whose levels each buffer as unbounded under any cap", async () => {
      // Each anyOf level keeps its branch peaks, and both object branches
      // recurse, so the measured peak doubles per level.
      const n = {
        anyOf: [
          { type: "string", const: "abc" },
          { type: "object", properties: { c: { $ref: "#/$defs/n" } } },
          { type: "object", properties: { c: { $ref: "#/$defs/n" } } },
        ],
      };
      const schema = { $ref: "#/$defs/n", $defs: { n } } as unknown as SchemaObject;
      const options = { maxBufferedBytes: 64 };
      expect(await observedPeak(schema, nest('"abc"', 8, "c"), options)).toBeGreaterThan(1000);
      expect(analyzeStreamability(schema, options)).toMatchObject({
        peakBytes: "unbounded",
        effectivePeakBytes: "unbounded",
      });
    });

    it("reports a cycle through allOf branches that buffer as unbounded", async () => {
      const m = {
        type: "object",
        properties: { c: { $ref: "#/$defs/m" }, s: patterned(2) },
        allOf: [
          { properties: { c: { $ref: "#/$defs/m" } } },
          { properties: { c: { $ref: "#/$defs/m" } } },
        ],
      };
      const schema = { $ref: "#/$defs/m", $defs: { m } } as unknown as SchemaObject;
      expect(await observedPeak(schema, nest('{"s":"aa"}', 6, "c"))).toBeGreaterThan(1000);
      expect(analyzeStreamability(schema).peakBytes).toBe("unbounded");
    });

    it("does not bound a schema re-entered through a branch it may fail", async () => {
      const schema = {
        type: "object",
        properties: { s: patterned(2), alt: { anyOf: [{ $ref: "#" }, { type: "object" }] } },
      } as unknown as SchemaObject;
      const input = `{"alt":{"s":"${"a".repeat(1000)}"}}`;
      expect(await observedPeak(schema, input)).toBeGreaterThan(1000);
      expect(analyzeStreamability(schema, { maxBufferedBytes: 4096 }).effectivePeakBytes).toBe(
        "unbounded",
      );
    });

    it("keeps a recursive TEE that buffers nothing at zero", () => {
      const expr = {
        oneOf: [
          { type: "number" },
          { type: "object", properties: { l: { $ref: "#/$defs/e" }, r: { $ref: "#/$defs/e" } } },
        ],
      };
      const r = analyzeStreamability({ $ref: "#/$defs/e", $defs: { e: expr } } as SchemaObject);
      expect(r.classification).toBe("tee");
      expect(r.peakBytes).toBe(0);
    });

    it("keeps a recursion without a TEE at its single-level bound", async () => {
      const schema = {
        type: "object",
        properties: { s: patterned(2), c: { $ref: "#" } },
      } as unknown as SchemaObject;
      const peak = analyzeStreamability(schema).peakBytes;
      expect(peak).toBe(2 * 12 + 2);
      const input = nest('{"s":"\\ud83d\\ude00\\ud83d\\ude00"}', 5, "c");
      expect(await observedPeak(schema, input)).toBeLessThanOrEqual(peak as number);
    });
  });

  it("bounds a number checked on its own by its token, outside the model", async () => {
    const schema = { type: "number", format: "float" } as SchemaObject;
    expect(analyzeStreamability(schema, oas).peakBytes).toBe(0);
    expect(await observedPeak(schema, `1.${"0".repeat(50)}e0`, oas)).toBe(0);
  });

  it.each([
    [
      "a container island",
      { type: "array", maxItems: 1, uniqueItems: true, items: { type: "boolean" } },
      `[${" ".repeat(20)}true]`,
      { maxBufferedBytes: 32 },
    ],
    [
      "a string island under a large cap",
      { type: "string", maxLength: 10, format: "date" },
      '"\\u0032020-01-01"',
      { ...oas, maxBufferedBytes: 1000 },
    ],
  ] as const)("bounds %s by effectivePeakBytes", async (_name, schema, input, options) => {
    const report = analyzeStreamability(schema as SchemaObject, options);
    expect(typeof report.effectivePeakBytes).toBe("number");
    const peak = await observedPeak(schema as SchemaObject, input, options);
    expect(peak).toBeLessThanOrEqual(report.effectivePeakBytes as number);
  });
});
