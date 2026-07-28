import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  analyzeStreamability,
  createStreamValidator,
  type MemberEdit,
  type StreamValidator,
} from "../src/index.js";

const enc = new TextEncoder();

/**
 * Stream `json` through the engine and return the verdict's
 * `peakBufferedBytes`. `chunkSize > 0` feeds the input in fixed-size chunks
 * (needed to observe edit-retention, which only persists across `_transform`
 * calls); `0` writes it in one shot.
 */
async function streamPeak(
  schema: SchemaOrBoolean,
  json: string,
  setup: (v: StreamValidator) => void = () => {},
  opts: Record<string, unknown> = {},
  chunkSize = 0,
): Promise<number> {
  const v = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  } as never);
  setup(v);
  v.on("error", () => {});
  v.resume(); // drain (and discard) the echoed bytes
  const result = v.result;
  const bytes = Buffer.from(enc.encode(json));
  if (chunkSize > 0) {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      v.write(bytes.subarray(i, i + chunkSize));
    }
    v.end();
  } else {
    v.end(bytes);
  }
  return (await result).peakBufferedBytes;
}

const rename = (key: string) => (): MemberEdit => ({ action: "rename", key });
const drop = (): MemberEdit => ({ action: "drop" });

describe("peakBufferedBytes: fully-streamable paths report 0", () => {
  it("a streamable object buffers nothing", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", maxLength: 10 }, age: { type: "integer" } },
    };
    expect(await streamPeak(schema, '{"name":"ada","age":36}')).toBe(0);
  });

  it("a streamed array of scalars buffers nothing", async () => {
    const schema = { type: "object", properties: { ids: { type: "array" } } };
    expect(await streamPeak(schema, '{"ids":[1,2,3,4,5,6,7,8,9,10]}')).toBe(0);
  });
});

describe("peakBufferedBytes: a BUFFER island reports its span", () => {
  it("a uniqueItems array reports a non-zero peak within the analyzer's bound", async () => {
    const schema = { type: "array", uniqueItems: true, maxItems: 3, items: { type: "integer" } };
    const json = "[1,2,3]";
    const peak = await streamPeak(schema, json);
    // Exact for a single island: the full wire span, both brackets included.
    expect(peak).toBe(Buffer.byteLength(json));
    // Runtime peak is the actual input's span, never above the static
    // worst-case the analyzer predicts for the schema.
    expect(peak).toBeLessThanOrEqual(Number(analyzeStreamability(schema).peakBytes));
  });

  it("a forced-buffer scalar (pattern) reports the string's span", async () => {
    const schema = { type: "string", pattern: "^a+$" };
    const peak = await streamPeak(schema, '"aaaaaaaa"');
    // The whole string is held for the pattern test; its span is ~10 bytes.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual('"aaaaaaaa"'.length);
  });
});

describe("peakBufferedBytes: a TEE sums its branch peaks", () => {
  it("oneOf of two forced-buffer branches reports the sum, not the max", async () => {
    const json = '"aaaa"';
    const single = await streamPeak({ type: "string", pattern: "^a+$" }, json);
    const tee = await streamPeak(
      {
        oneOf: [
          { type: "string", pattern: "^a" },
          { type: "string", pattern: "a$" },
        ],
      },
      json,
    );
    expect(single).toBeGreaterThan(0);
    // Both branches buffer the same string concurrently; the conservative
    // upper bound is the sum of the per-branch peaks, not a single span.
    expect(tee).toBe(2 * single);
  });
});

describe("peakBufferedBytes: edit-retention is bounded and folded in", () => {
  it("rename over a large array stays bounded to the key/prefix, not the array", async () => {
    const schema = { type: "object", properties: { message_ids: { type: "array" } } };
    const big = Array.from({ length: 2000 }, (_, i) => i).join(",");
    const json = `{"message_ids":[${big}],"batch":7}`;
    const peak = await streamPeak(
      schema,
      json,
      (v) => v.editMember(["message_ids"], rename("records")),
      {},
      4, // tiny chunks: the array streams, only the key span is held across a boundary
    );
    expect(peak).toBeGreaterThan(0); // the key span is held across chunk boundaries
    expect(peak).toBeLessThan(200); // ... and is tiny next to the ~7 KB array
    expect(peak).toBeLessThan(json.length / 10);
  });

  it("a fully-streamable schema with no edit hooks still reports 0 under chunking", async () => {
    const schema = { type: "object", properties: { ids: { type: "array" } } };
    expect(await streamPeak(schema, '{"ids":[1,2,3,4,5]}', () => {}, {}, 3)).toBe(0);
  });

  it("dropping a scalar counts the withheld drop span", async () => {
    const schema = { type: "object" };
    const peak = await streamPeak(
      schema,
      '{"keep":1,"deprecated":"some-value-here","tail":2}',
      (v) => v.editMember(["deprecated"], drop),
      {},
      4,
    );
    // The dropped member's span is held until the delete resolves at the next
    // sibling key; it is non-zero and bounded by the member's own size.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(100);
  });

  it("sums a concurrent spine island and edit-retention, not maxes them", async () => {
    // A schema buffer (uniqueItems island) on one member and an edit-hook
    // drop on another are distinct retention sites; the verdict reports their
    // sum (conservative), not the dominant one.
    const islandSchema = {
      type: "object",
      properties: {
        tags: { type: "array", uniqueItems: true, maxItems: 5, items: { type: "integer" } },
      },
    };
    const plainSchema = { type: "object" };
    const json = '{"tags":[1,2,3],"deprecated":"a-removed-value","tail":2}';
    const dropDeprecated = (v: StreamValidator) => v.editMember(["deprecated"], drop);

    const islandAlone = await streamPeak(islandSchema, json, () => {}, {}, 4);
    const dropAlone = await streamPeak(plainSchema, json, dropDeprecated, {}, 4);
    const combined = await streamPeak(islandSchema, json, dropDeprecated, {}, 4);

    expect(islandAlone).toBeGreaterThan(0); // the uniqueItems array islands
    expect(dropAlone).toBeGreaterThan(0); // the dropped member is held
    // Sum, not max: the combined peak is strictly larger than either site
    // alone, and equals their sum.
    expect(combined).toBe(islandAlone + dropAlone);
    expect(combined).toBeGreaterThan(Math.max(islandAlone, dropAlone));
  });

  it("records edit-retention even when the validation budget trips while held", async () => {
    // The budget trips at object close (a `required` miss) while the sole
    // dropped member is still held pending its delete. The retention peak for
    // that final chunk must reach the verdict, not be discarded by the
    // budget-path flush before it is recorded.
    const peak = await streamPeak(
      { type: "object", required: ["missing"] },
      '{"drop_me":"some value"}',
      (v) => v.editMember(["drop_me"], drop),
      { policy: "detach", maxErrors: 1 },
    );
    // The whole held member span is counted; without the fix this is 0.
    expect(peak).toBeGreaterThan(10);
  });
});
