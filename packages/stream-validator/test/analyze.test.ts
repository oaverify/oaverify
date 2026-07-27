import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import {
  analyzeStreamability,
  createStreamValidator,
  ValidationFailedError,
} from "../src/index.js";
import { ClassifierError } from "../src/classifier/index.js";

// Byte model (mirrors analyze.ts, kept here so the expectations are
// self-documenting): string = maxLength*4 + 2 quotes; number = 24;
// array = 2 brackets + n*(item + comma); object = 2 braces + sum of members.
const str = (maxLength: number): number => maxLength * 4 + 2;
const uniqueArray = (n: number, item: number): number => 2 + n * (item + 1);

function analyze(schema: SchemaOrBoolean, options = {}) {
  return analyzeStreamability(schema, options);
}

describe("analyzeStreamability", () => {
  it("reports a fully-streamable schema with no buffering", () => {
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", maxLength: 10 }, age: { type: "integer" } },
    } as SchemaObject);
    expect(r.classification).toBe("streamable");
    expect(r.peakBytes).toBe(0);
    expect(r.effectivePeakBytes).toBe(0);
    expect(r.positions).toEqual([]);
  });

  it("sizes a bounded uniqueItems array as a buffer island", () => {
    const r = analyze({
      type: "array",
      uniqueItems: true,
      maxItems: 3,
      items: { type: "string", maxLength: 5 },
    } as SchemaObject);
    expect(r.classification).toBe("buffer");
    expect(r.peakBytes).toBe(uniqueArray(3, str(5))); // 2 + 3*(22+1) = 71
    expect(r.positions).toEqual([
      { path: "", classification: "buffer", keyword: "uniqueItems", maxBytes: 71 },
    ]);
  });

  it("flags an unbounded uniqueItems array (no maxItems) with the missing keyword", () => {
    const r = analyze({
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    } as SchemaObject);
    expect(r.peakBytes).toBe("unbounded");
    expect(r.positions[0]).toMatchObject({
      classification: "buffer",
      keyword: "uniqueItems",
      maxBytes: "unbounded",
      unboundedBy: "maxItems",
    });
  });

  it("sizes a complex const as a buffer island from its serialized form", () => {
    const value = { a: 1, b: "two" };
    const r = analyze({ const: value } as SchemaObject);
    expect(r.classification).toBe("buffer");
    expect(r.peakBytes).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    expect(r.positions[0]).toMatchObject({ keyword: "const", classification: "buffer" });
  });

  it("treats pattern as a forced-buffer scalar bounded by maxLength", () => {
    const bounded = analyze({ type: "string", pattern: "^x", maxLength: 10 } as SchemaObject);
    expect(bounded.classification).toBe("buffer");
    expect(bounded.peakBytes).toBe(str(10));
    expect(bounded.positions[0]).toMatchObject({ keyword: "pattern", maxBytes: 42 });

    const unbounded = analyze({ type: "string", pattern: "^x" } as SchemaObject);
    expect(unbounded.peakBytes).toBe("unbounded");
    expect(unbounded.positions[0]).toMatchObject({ keyword: "pattern", unboundedBy: "maxLength" });
  });

  it("buffers format only under an asserting (OpenAPI) dialect", () => {
    const schema = { type: "string", format: "date-time", maxLength: 30 } as SchemaObject;
    // Plain JSON Schema: format is an annotation, not asserted -> streams.
    expect(analyze(schema).classification).toBe("streamable");
    // OpenAPI dialect asserts format -> the spine buffers the string.
    const oas = analyze(schema, { openApiVersion: "3.1" });
    expect(oas.classification).toBe("buffer");
    expect(oas.peakBytes).toBe(str(30));
    expect(oas.positions[0]).toMatchObject({ keyword: "format", maxBytes: 122 });
  });

  it("takes a max (not a sum) across sequential buffering siblings", () => {
    const island = {
      type: "array",
      uniqueItems: true,
      maxItems: 2,
      items: { type: "string", maxLength: 3 },
    };
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: { a: island, b: island },
    } as unknown as SchemaObject);
    // One island at a time: peak is the single island's size, not 2x.
    expect(r.peakBytes).toBe(uniqueArray(2, str(3))); // 2 + 2*(14+1) = 32
    expect(r.positions).toHaveLength(2);
  });

  it("takes a sum across concurrent tee branches", () => {
    const island = {
      type: "array",
      uniqueItems: true,
      maxItems: 2,
      items: { type: "string", maxLength: 3 },
    };
    const r = analyze({ oneOf: [island, { type: "integer" }] } as unknown as SchemaObject);
    expect(r.classification).toBe("buffer"); // a branch buffers
    // The tee fans events to concurrent sub-spines: branch islands sum.
    expect(r.peakBytes).toBe(uniqueArray(2, str(3))); // 32 + 0
    const tee = r.positions.find((p) => p.classification === "tee");
    expect(tee).toMatchObject({ keyword: "oneOf", maxBytes: 32 });
  });

  it("reports a scalar tee with zero buffer", () => {
    const r = analyze({
      oneOf: [{ type: "string", maxLength: 5 }, { type: "integer" }],
    } as SchemaObject);
    expect(r.classification).toBe("tee");
    expect(r.peakBytes).toBe(0);
    expect(r.positions).toEqual([
      { path: "", classification: "tee", keyword: "oneOf", maxBytes: 0 },
    ]);
  });

  it("clamps effectivePeakBytes by maxBufferedBytes; peakBytes stays intrinsic", () => {
    const bounded = analyze(
      {
        type: "array",
        uniqueItems: true,
        maxItems: 3,
        items: { type: "string", maxLength: 5 },
      } as SchemaObject,
      { maxBufferedBytes: 50 },
    );
    expect(bounded.peakBytes).toBe(71);
    expect(bounded.effectivePeakBytes).toBe(50); // min(71, 50)

    const unbounded = analyze(
      { type: "array", uniqueItems: true, items: { type: "string" } } as SchemaObject,
      { maxBufferedBytes: 1000 },
    );
    expect(unbounded.peakBytes).toBe("unbounded");
    expect(unbounded.effectivePeakBytes).toBe(1000); // unbounded island clamps to the cap
  });

  it("reports paths for nested buffering positions", () => {
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: {
        tags: {
          type: "array",
          uniqueItems: true,
          maxItems: 4,
          items: { type: "string", maxLength: 8 },
        },
      },
    } as unknown as SchemaObject);
    expect(r.positions[0]).toMatchObject({ path: "tags", keyword: "uniqueItems" });
  });

  it("formats an array-item position path with no dot before the bracket", () => {
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: {
        tags: { type: "array", items: { type: "string", pattern: "^.+$" } },
      },
    } as unknown as SchemaObject);
    // The pattern string inside the array items is at `tags[]`, not `tags.[]`.
    expect(r.positions.map((p) => p.path)).toContain("tags[]");
  });

  it("renders composition-branch path segments with a dot, not brackets", () => {
    // A oneOf whose first branch is an array and second is a scalar: the
    // unbounded leaves are at `documents.oneOf.0[]` (array item of branch 0)
    // and `documents.oneOf.1` (branch 1), not `oneOf[0][]` / `oneOf[1]`.
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: {
        documents: {
          oneOf: [
            { type: "array", items: { type: "string", pattern: "^.+$" } },
            { type: "string", pattern: "^.+$" },
          ],
        },
      },
    } as unknown as SchemaObject);
    const paths = r.positions.filter((p) => p.classification === "buffer").map((p) => p.path);
    expect(paths).toContain("documents.oneOf.0[]");
    expect(paths).toContain("documents.oneOf.1");
  });

  it("counts a composition node's own forced-buffer scalar (the stripComposition sub-spine)", () => {
    // `{ type: string, pattern, allOf: [{ maxLength }] }` tees: the runtime
    // validates the own (non-composition) keywords as a required sub-spine, so
    // the `pattern` string still buffers. The allOf `maxLength` bounds it.
    const r = analyze({
      type: "string",
      pattern: "^a",
      allOf: [{ maxLength: 100 }],
    } as unknown as SchemaObject);
    expect(r.peakBytes).toBe(str(100)); // 100*4 + 2 = 402, not 0
    expect(r.positions).toContainEqual(
      expect.objectContaining({ keyword: "pattern", maxBytes: str(100) }),
    );
  });

  it("sums a tee node's own member island with its branch islands (concurrent sub-spines)", () => {
    const island = (max: number) => ({
      type: "array",
      uniqueItems: true,
      maxItems: 2,
      items: { type: "string", maxLength: max },
    });
    // The object has a buffering property AND a oneOf with a buffering branch.
    // Both run as concurrent sub-spines, so the peak is their sum, not a max.
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: { a: island(3) },
      oneOf: [island(4), { type: "integer" }],
    } as unknown as SchemaObject);
    const ownIsland = uniqueArray(2, str(3)); // property a: 2 + 2*(14+1) = 32
    const branchIsland = uniqueArray(2, str(4)); // oneOf branch: 2 + 2*(18+1) = 40
    expect(r.peakBytes).toBe(ownIsland + branchIsland); // summed, not max
  });

  it("throws on an unbounded schema under enforceBounds (parity with construction)", () => {
    const schema = { type: "string", pattern: "^.+$" } as SchemaObject; // no maxLength
    // Default: reports the unbounded position.
    expect(analyze(schema).peakBytes).toBe("unbounded");
    // enforceBounds: throws like createStreamValidator would.
    expect(() => analyze(schema, { enforceBounds: true })).toThrow(ClassifierError);
  });

  it("throws ClassifierError on an unstreamable schema (same as construction)", () => {
    expect(() => analyze({ type: "object", unevaluatedProperties: false } as SchemaObject)).toThrow(
      ClassifierError,
    );
  });

  it("classifies a boolean schema as streamable", () => {
    expect(analyze(true).classification).toBe("streamable");
    expect(analyze(true).peakBytes).toBe(0);
  });
});

// Soundness against the real engine: a validation never buffers more than
// the analyzer's reported peak. Running the actual validator with
// maxBufferedBytes set to peakBytes must succeed; a cap below what the
// engine actually buffers must fail. This ties the static number to runtime
// behavior, the "verified against the spine" claim in #431.
describe("analyzeStreamability: peakBytes is a sound upper bound on real buffering", () => {
  const enc = new TextEncoder();

  async function runWithCap(
    schema: SchemaOrBoolean,
    value: unknown,
    maxBufferedBytes: number,
  ): Promise<Error | undefined> {
    const validator = createStreamValidator(schema, { maxBufferedBytes });
    validator.on("error", () => {});
    void validator.result.catch(() => {}); // swallow the parallel result rejection
    try {
      await pipeline(
        Readable.from(Buffer.from(enc.encode(JSON.stringify(value)))),
        validator,
        new Writable({ write: (_c, _e, cb) => cb() }),
      );
      return undefined;
    } catch (e) {
      // A buffer-limit breach surfaces here; a passing payload does not throw.
      return e instanceof ValidationFailedError ? undefined : (e as Error);
    }
  }

  it("a uniqueItems island validates at the predicted cap, fails below the real span", async () => {
    const schema = {
      type: "array",
      uniqueItems: true,
      maxItems: 3,
      items: { type: "string", maxLength: 5 },
    } as SchemaObject;
    const value = ["abcde", "fghij", "klmno"]; // valid: 3 unique, each length 5
    const peak = analyze(schema).peakBytes as number; // 71 (loose upper bound)

    // At the predicted upper bound: no buffer-limit error (real span <= peak).
    expect(await runWithCap(schema, value, peak)).toBeUndefined();
    // The raw array spans ~25 bytes; a cap well below it must trip the limit.
    const err = await runWithCap(schema, value, 10);
    expect(err?.message).toMatch(/maxBufferedBytes/);
  });

  it("a pattern scalar validates at the predicted cap, fails below the real span", async () => {
    const schema = { type: "string", pattern: "^a+$", maxLength: 10 } as SchemaObject;
    const value = "aaaa"; // 6 raw bytes including quotes
    const peak = analyze(schema).peakBytes as number; // 42

    expect(await runWithCap(schema, value, peak)).toBeUndefined();
    expect((await runWithCap(schema, value, 5))?.message).toMatch(/maxBufferedBytes/);
  });

  it("a composition node's own pattern buffers at runtime (own sub-spine), bounded by the predicted cap", async () => {
    // The Codex scenario: pattern on the node, maxLength in an allOf branch.
    // The engine buffers the string in the stripComposition sub-spine; the
    // analyzer must predict that (peak > 0), and the real buffer stays under it.
    const schema = {
      type: "string",
      pattern: "^a+$",
      allOf: [{ maxLength: 100 }],
    } as unknown as SchemaObject;
    const peak = analyze(schema).peakBytes as number; // 402, not 0
    expect(peak).toBeGreaterThan(0);

    const value = "aaaa"; // valid: matches pattern, length 4 <= 100
    expect(await runWithCap(schema, value, peak)).toBeUndefined();
    // A cap below the real ~6-byte span trips the limit, proving it buffers.
    expect((await runWithCap(schema, value, 4))?.message).toMatch(/maxBufferedBytes/);
  });
});
