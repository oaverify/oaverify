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
// self-documenting): a string is at most 12 bytes per code point (an
// escaped surrogate pair) plus 2 quotes. A materialized container or
// number has no finite span: whitespace and number spellings are unlimited.
const str = (maxLength: number): number => maxLength * 12 + 2;
// A finite island: a string the spine holds whole to test its pattern.
const patterned = (maxLength: number) => ({ type: "string", maxLength, pattern: "^a*$" });

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

  it("reports a structurally bounded uniqueItems array as needing the buffer cap", () => {
    const r = analyze({
      type: "array",
      uniqueItems: true,
      maxItems: 3,
      items: { type: "string", maxLength: 5 },
    } as SchemaObject);
    expect(r.classification).toBe("buffer");
    // Whitespace between items is unlimited, so only the cap bounds the span.
    expect(r.peakBytes).toBe("unbounded");
    expect(r.positions).toEqual([
      {
        path: "",
        classification: "buffer",
        keyword: "uniqueItems",
        maxBytes: "unbounded",
        unboundedBy: "maxBufferedBytes",
      },
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

  it("reports a complex const as needing the buffer cap", () => {
    // Equality is by value, so `{ "a" : 1.0 }` matches as well as `{"a":1}`.
    const r = analyze({ const: { a: 1, b: "two" } } as SchemaObject);
    expect(r.classification).toBe("buffer");
    expect(r.peakBytes).toBe("unbounded");
    expect(r.positions[0]).toMatchObject({
      keyword: "const",
      classification: "buffer",
      unboundedBy: "maxBufferedBytes",
    });
  });

  it("adds nothing for a number checked on its own, which is held as a token", () => {
    const r = analyze({ type: "integer", format: "int32" } as SchemaObject, {
      openApiVersion: "3.1",
    });
    expect(r.classification).toBe("buffer");
    expect(r.positions).toEqual([
      { path: "", classification: "buffer", keyword: "format", maxBytes: 0 },
    ]);
    // A number-or-string region is bounded by its string.
    const union = analyze(
      { type: ["integer", "string"], format: "int32", maxLength: 5 } as SchemaObject,
      { openApiVersion: "3.1" },
    );
    expect(union.peakBytes).toBe(str(5));
  });

  it("treats pattern as a forced-buffer scalar bounded by maxLength", () => {
    const bounded = analyze({ type: "string", pattern: "^x", maxLength: 10 } as SchemaObject);
    expect(bounded.classification).toBe("buffer");
    expect(bounded.peakBytes).toBe(str(10));
    expect(bounded.positions[0]).toMatchObject({ keyword: "pattern", maxBytes: str(10) });

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
    expect(oas.positions[0]).toMatchObject({ keyword: "format", maxBytes: str(30) });
  });

  it("takes a max (not a sum) across sequential buffering siblings", () => {
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: { a: patterned(3), b: patterned(2) },
    } as unknown as SchemaObject);
    // One island at a time: peak is the larger island's size, not the sum.
    expect(r.peakBytes).toBe(str(3));
    expect(r.positions).toHaveLength(2);
  });

  it("takes a sum across concurrent tee branches", () => {
    const r = analyze(
      { allOf: [patterned(3), { type: "string", maxLength: 2, format: "date" }] } as SchemaObject,
      { openApiVersion: "3.1" },
    );
    expect(r.classification).toBe("buffer"); // a branch buffers
    // The tee fans events to concurrent sub-spines: branch islands sum.
    expect(r.peakBytes).toBe(str(3) + str(2));
    const tee = r.positions.find((p) => p.classification === "tee");
    expect(tee).toMatchObject({ keyword: "allOf", maxBytes: str(3) + str(2) });
  });

  it("does not bound a branch an accepted input may fail by that branch's own keywords", () => {
    // A long string passes through `{}` while the first branch, failing
    // maxLength, still holds the whole string for its pattern.
    const r = analyze({ anyOf: [patterned(1), {}] } as SchemaObject, { maxBufferedBytes: 100 });
    expect(r.peakBytes).toBe("unbounded");
    expect(r.positions).toContainEqual({
      path: "anyOf.0",
      classification: "buffer",
      keyword: "pattern",
      maxBytes: "unbounded",
      unboundedBy: "maxBufferedBytes",
    });
    expect(r.effectivePeakBytes).toBe(100);
    // The spine itself stops holding a string past its longest candidate.
    expect(analyze({ not: { enum: ["ab"] } } as SchemaObject).peakBytes).toBe(2 * 6 + 2);
  });

  it("sums a properties entry with the patternProperties matching the same key", () => {
    const r = analyze({
      type: "object",
      properties: { x: patterned(1) },
      patternProperties: { "^x": patterned(2), x$: patterned(3) },
      additionalProperties: patterned(4),
    } as unknown as SchemaObject);
    expect(r.peakBytes).toBe(str(1) + str(2) + str(3));
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
    const bounded = analyze(patterned(5) as SchemaObject, { maxBufferedBytes: 50 });
    expect(bounded.peakBytes).toBe(str(5));
    expect(bounded.effectivePeakBytes).toBe(50); // min(62, 50)
    expect(
      analyze(patterned(5) as SchemaObject, { maxBufferedBytes: 100 }).effectivePeakBytes,
    ).toBe(str(5));

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
    expect(r.peakBytes).toBe(str(100)); // not 0
    expect(r.positions).toContainEqual(
      expect.objectContaining({ keyword: "pattern", maxBytes: str(100) }),
    );
  });

  it("sums a tee node's own member island with its branch islands (concurrent sub-spines)", () => {
    // The object has a buffering property AND a oneOf with a buffering branch.
    // Both run as concurrent sub-spines, so the peak is their sum, not a max.
    const r = analyze({
      type: "object",
      additionalProperties: false,
      properties: { a: patterned(3) },
      allOf: [{ type: "object", properties: { a: patterned(4) } }],
    } as unknown as SchemaObject);
    expect(r.peakBytes).toBe(str(3) + str(4)); // summed, not max
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

  it("a uniqueItems island validates at the effective cap, fails below the real span", async () => {
    const schema = {
      type: "array",
      uniqueItems: true,
      maxItems: 3,
      items: { type: "string", maxLength: 5 },
    } as SchemaObject;
    const value = ["abcde", "fghij", "klmno"]; // valid: 3 unique, each length 5
    const peak = analyze(schema, { maxBufferedBytes: 64 }).effectivePeakBytes as number;
    expect(peak).toBe(64);

    // At the predicted upper bound: no buffer-limit error (real span <= peak).
    expect(await runWithCap(schema, value, peak)).toBeUndefined();
    // The raw array spans ~25 bytes; a cap well below it must trip the limit.
    const err = await runWithCap(schema, value, 10);
    expect(err?.message).toMatch(/maxBufferedBytes/);
  });

  it("a pattern scalar validates at the predicted cap, fails below the real span", async () => {
    const schema = { type: "string", pattern: "^a+$", maxLength: 10 } as SchemaObject;
    const value = "aaaa"; // 6 raw bytes including quotes
    const peak = analyze(schema).peakBytes as number;

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
    const peak = analyze(schema).peakBytes as number; // not 0
    expect(peak).toBeGreaterThan(0);

    const value = "aaaa"; // valid: matches pattern, length 4 <= 100
    expect(await runWithCap(schema, value, peak)).toBeUndefined();
    // A cap below the real ~6-byte span trips the limit, proving it buffers.
    expect((await runWithCap(schema, value, 4))?.message).toMatch(/maxBufferedBytes/);
  });
});

describe("analyzeStreamability follows $dynamicRef as the engine does (#1123)", () => {
  const B = { $dynamicAnchor: "B", type: "string", pattern: "^a+$" };
  const viaRef = (schema: object) => analyze({ ...schema, $defs: { B } } as SchemaObject);

  it("reports a dynamic reference's buffering exactly as the static one", () => {
    const dynamic = viaRef({ $dynamicRef: "#B" });
    expect(dynamic).toEqual(viaRef({ $ref: "#/$defs/B" }));
    expect(dynamic.classification).toBe("buffer");
    expect(dynamic.peakBytes).toBe("unbounded");
    expect(dynamic.positions).toEqual([
      {
        path: "",
        classification: "buffer",
        keyword: "pattern",
        maxBytes: "unbounded",
        unboundedBy: "maxLength",
      },
    ]);
  });

  it("sizes a finite target and a nested member island", () => {
    const finite = { $dynamicAnchor: "F", type: "string", maxLength: 10, pattern: "^a+$" };
    const r = analyze({
      type: "object",
      properties: { k: { $dynamicRef: "#F" } },
      $defs: { F: finite },
    } as SchemaObject);
    expect(r.peakBytes).toBe(str(10));
    expect(r.positions).toEqual([
      { path: "k", classification: "buffer", keyword: "pattern", maxBytes: str(10) },
    ]);
  });

  it("applies a co-located $ref and $dynamicRef together", () => {
    const r = analyze({
      $ref: "#/$defs/Short",
      $dynamicRef: "#B",
      $defs: { Short: { maxLength: 5 }, B },
    } as SchemaObject);
    expect(r.peakBytes).toBe(str(5));
  });

  it("reaches a target through composition and caps an unbounded estimate", () => {
    const r = analyze(
      { anyOf: [{ $dynamicRef: "#B" }, { type: "integer" }], $defs: { B } } as SchemaObject,
      { maxBufferedBytes: 100 },
    );
    expect(r.positions.map((p) => [p.path, p.classification])).toEqual([
      ["", "tee"],
      ["anyOf.0", "buffer"],
    ]);
    expect(r.peakBytes).toBe("unbounded");
    expect(r.effectivePeakBytes).toBe(100);
  });

  it("terminates on a recursive dynamic reference", () => {
    const tree = {
      $dynamicAnchor: "T",
      type: "object",
      properties: {
        v: { type: "string", pattern: "^x$" },
        kids: { type: "array", items: { $dynamicRef: "#T" } },
      },
    };
    const r = analyze({ $ref: "#/$defs/T", $defs: { T: tree } } as SchemaObject);
    expect(r.positions.map((p) => p.path)).toContain("v");
  });

  async function runtimePeak(schema: SchemaObject, value: unknown): Promise<number> {
    const validator = createStreamValidator(schema, { maxErrors: Number.POSITIVE_INFINITY });
    validator.on("error", () => {});
    validator.resume();
    const result = validator.result;
    validator.end(Buffer.from(new TextEncoder().encode(JSON.stringify(value))));
    const { valid, peakBufferedBytes } = await result;
    expect(valid).toBe(true);
    return peakBufferedBytes;
  }

  // A reference cycle back to the node collects it twice, as the spine's
  // expand does, and the tee then runs both copies concurrently.
  it.each(["$dynamicRef", "$ref"] as const)(
    "bounds a %s cycle back to the node by what the engine buffers",
    async (keyword) => {
      const schema = {
        $dynamicAnchor: "R",
        [keyword]: keyword === "$ref" ? "#" : "#R",
        type: "object",
        properties: { v: { type: "string", maxLength: 10, pattern: ".*" } },
        allOf: [true],
      } as SchemaObject;
      const peak = analyze(schema).peakBytes;
      expect(peak).toBe(2 * str(10));
      expect(await runtimePeak(schema, { v: "\u{1F600}".repeat(10) })).toBeLessThanOrEqual(
        peak as number,
      );
    },
  );

  it("bounds a uniqueItems island reached through $dynamicRef by the cap", async () => {
    const schema = {
      $dynamicRef: "#U",
      $defs: {
        U: {
          $dynamicAnchor: "U",
          type: "array",
          uniqueItems: true,
          maxItems: 3,
          items: { type: "string", maxLength: 5 },
        },
      },
    } as SchemaObject;
    expect(analyze(schema).positions[0]).toMatchObject({ unboundedBy: "maxBufferedBytes" });
    const peak = analyze(schema, { maxBufferedBytes: 64 }).effectivePeakBytes;
    expect(peak).toBe(64);
    expect(await runtimePeak(schema, ["abcde", "fghij", "klmno"])).toBeLessThanOrEqual(
      peak as number,
    );
  });

  it("matches what the engine buffers for the same input", async () => {
    const schema = { $dynamicRef: "#B", $defs: { B } } as SchemaObject;
    const validator = createStreamValidator(schema, { maxErrors: Number.POSITIVE_INFINITY });
    validator.on("error", () => {});
    validator.resume();
    const result = validator.result;
    validator.end(Buffer.from(new TextEncoder().encode(JSON.stringify("a".repeat(1000)))));
    const { peakBufferedBytes } = await result;
    expect(peakBufferedBytes).toBeGreaterThan(1000);
    expect(analyze(schema).peakBytes).toBe("unbounded");
  });
});
