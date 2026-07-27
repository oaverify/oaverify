import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  createStreamValidator,
  type StreamValidator,
  ValidationFailedError,
} from "../src/index.js";
import { JsonParseError } from "../src/tokenizer/index.js";

const enc = new TextEncoder();

function chunkedSource(text: string, chunkSize: number): Readable {
  const bytes = enc.encode(text);
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(Buffer.from(bytes.subarray(i, Math.min(i + chunkSize, bytes.length))));
  }
  return Readable.from(chunks);
}

function collector(): { sink: Writable; bytes: () => Buffer } {
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(Buffer.from(chunk));
      cb();
    },
  });
  return { sink, bytes: () => Buffer.concat(out) };
}

async function runValid(
  schema: SchemaOrBoolean,
  text: string,
  chunkSize = 4,
): Promise<{ echoed: Buffer; validator: StreamValidator }> {
  const validator = createStreamValidator(schema);
  const { sink, bytes } = collector();
  await pipeline(chunkedSource(text, chunkSize), validator, sink);
  return { echoed: bytes(), validator };
}

describe("createStreamValidator: byte-exact echo", () => {
  it("echoes the input verbatim for valid data, across chunk boundaries", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      required: ["name"],
    };
    const text = '{"name":"héllo","tags":["a","b"],"x":42}';
    for (const chunkSize of [1, 3, 7, 1000]) {
      const validator = createStreamValidator(schema);
      const { sink, bytes } = collector();
      await pipeline(chunkedSource(text, chunkSize), validator, sink);
      expect(bytes().toString("utf8")).toBe(text);
      await expect(validator.result).resolves.toMatchObject({ valid: true });
    }
  });

  it("emits a verdict event and resolves the result for valid data", async () => {
    const { validator } = await runValid({ type: "integer" }, "42");
    const verdict = await validator.result;
    expect(verdict.valid).toBe(true);
  });
});

describe("createStreamValidator: terminate policy (default)", () => {
  it("rejects the pipeline with ValidationFailedError on a violation", async () => {
    const validator = createStreamValidator({
      type: "object",
      properties: { n: { type: "integer" } },
    });
    const violations: unknown[] = [];
    validator.on("violation", (v) => violations.push(v));
    const { sink } = collector();
    await expect(
      pipeline(chunkedSource('{"n":"notint"}', 4), validator, sink),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const verdict = await validator.result;
    expect(verdict.valid).toBe(false);
    expect(violations).toHaveLength(1);
    expect((violations[0] as { byteOffset: number }).byteOffset).toBeGreaterThan(0);
  });
});

describe("createStreamValidator: eager over-limit aborts before echoing the tail", () => {
  it("terminates a maxItems-violating array without echoing the whole over-count body", async () => {
    // 200 elements against maxItems 3. Under `terminate`, the eager
    // violation at the 4th element destroys the stream, so the long tail is
    // never forwarded downstream (to e.g. S3). A close-time check would
    // echo the entire body first.
    const validator = createStreamValidator({ type: "array", maxItems: 3 });
    const violations: { code: string; byteOffset: number }[] = [];
    validator.on("violation", (v) => violations.push(v as { code: string; byteOffset: number }));
    const text = `[${Array.from({ length: 200 }, (_, i) => i).join(",")}]`;
    const { sink, bytes } = collector();
    await expect(pipeline(chunkedSource(text, 8), validator, sink)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("maxItems");
    // The echo stopped well before the closing bracket: the tail is unsent.
    expect(bytes().length).toBeLessThan(text.length);
    expect(bytes().toString("utf8")).not.toContain("]");
  });

  it("counts maxLength code points across chunk boundaries", async () => {
    // A long string fed two bytes at a time: the eager counter accumulates
    // across onStringChunk calls and fires once the cap is exceeded, before
    // the closing quote.
    const validator = createStreamValidator({
      type: "object",
      properties: { s: { type: "string", maxLength: 10 } },
    });
    const violations: { code: string; path: unknown[] }[] = [];
    validator.on("violation", (v) => violations.push(v as { code: string; path: unknown[] }));
    const text = `{"s":"${"x".repeat(500)}"}`;
    const { sink, bytes } = collector();
    await expect(pipeline(chunkedSource(text, 2), validator, sink)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("maxLength");
    expect(violations[0]?.path).toEqual(["s"]);
    // Aborted mid-string: the 500-char body was not echoed in full.
    expect(bytes().length).toBeLessThan(text.length);
  });

  it("counts astral code points, not UTF-16 units, across chunks", async () => {
    // 8 astral chars (each a surrogate pair in UTF-16, 4 UTF-8 bytes) under
    // maxLength 10: 8 code points <= 10, so valid. A UTF-16-unit count would
    // see 16 and wrongly reject. Chunked at 3 bytes to split multibyte runs.
    const validator = createStreamValidator({
      type: "object",
      properties: { s: { type: "string", maxLength: 10 } },
    });
    const violations: unknown[] = [];
    validator.on("violation", (v) => violations.push(v));
    const text = `{"s":"${"\u{1F600}".repeat(8)}"}`;
    const { sink } = collector();
    await pipeline(chunkedSource(text, 3), validator, sink);
    expect(violations).toHaveLength(0);
    expect((await validator.result).valid).toBe(true);
  });
});

describe("createStreamValidator: detach policy", () => {
  it("finishes cleanly, echoes all bytes, and reports an invalid verdict", async () => {
    const validator = createStreamValidator(
      { type: "array", items: { type: "integer" } },
      { policy: "detach", maxErrors: Number.POSITIVE_INFINITY },
    );
    const violations: unknown[] = [];
    validator.on("violation", (v) => violations.push(v));
    const text = '[1,"two",3,"four"]';
    const { sink, bytes } = collector();
    await pipeline(chunkedSource(text, 2), validator, sink);
    expect(bytes().toString("utf8")).toBe(text);
    const verdict = await validator.result;
    expect(verdict.valid).toBe(false);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("createStreamValidator: parse errors are fatal", () => {
  it("rejects the pipeline and the result with JsonParseError", async () => {
    const validator = createStreamValidator(true);
    const { sink } = collector();
    const resultGuard = validator.result.catch((e) => e);
    await expect(pipeline(chunkedSource("{bad json", 3), validator, sink)).rejects.toBeInstanceOf(
      JsonParseError,
    );
    expect(await resultGuard).toBeInstanceOf(JsonParseError);
  });
});

describe("createStreamValidator: TEE/BUFFER schemas (island delegation)", () => {
  it("constructs and validates a composition schema by materializing the island", async () => {
    const schema: SchemaOrBoolean = { oneOf: [{ type: "integer" }, { minimum: 5 }] };
    // Valid: an integer below 5 matches exactly one branch.
    {
      const validator = createStreamValidator(schema);
      const { sink, bytes } = collector();
      await pipeline(chunkedSource("3", 1), validator, sink);
      expect(bytes().toString("utf8")).toBe("3");
      await expect(validator.result).resolves.toMatchObject({ valid: true });
    }
    // Invalid: 7 matches both branches (integer and >=5) -> oneOf fails.
    {
      const validator = createStreamValidator(schema);
      const { sink } = collector();
      await expect(pipeline(chunkedSource("7", 1), validator, sink)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      await expect(validator.result).resolves.toMatchObject({ valid: false });
    }
  });

  it("echoes a buffered island verbatim and streams the rest", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { tag: { oneOf: [{ const: "a" }, { const: "b" }] }, n: { type: "integer" } },
    };
    const text = '{"tag":"a","n":5}';
    const validator = createStreamValidator(schema);
    const { sink, bytes } = collector();
    await pipeline(chunkedSource(text, 3), validator, sink);
    expect(bytes().toString("utf8")).toBe(text);
    await expect(validator.result).resolves.toMatchObject({ valid: true });
  });
});

describe("createStreamValidator: maxBufferedBytes", () => {
  // A complex `const` is a BUFFER island (deep equality); composition of
  // forward branches would TEE instead, so it would not exercise the cap.
  const schema: SchemaOrBoolean = { const: { a: 1 } };

  it("fails fatally when a buffered island exceeds the cap", async () => {
    const validator = createStreamValidator(schema, { maxBufferedBytes: 8 });
    const { sink } = collector();
    const resultGuard = validator.result.catch((e) => e);
    await expect(
      pipeline(chunkedSource('{"a":1,"b":2,"c":3}', 4), validator, sink),
    ).rejects.toThrow(/maxBufferedBytes/);
    expect((await resultGuard).message).toMatch(/maxBufferedBytes/);
  });

  it("accepts an island within the cap", async () => {
    const validator = createStreamValidator(schema, { maxBufferedBytes: 1000 });
    const { sink } = collector();
    await pipeline(chunkedSource('{"a":1}', 4), validator, sink);
    await expect(validator.result).resolves.toMatchObject({ valid: true });
  });
});

describe("createStreamValidator: compile-time fast-fail", () => {
  it("throws at construction for a REJECT (unevaluated*) or unknown keyword", () => {
    expect(() => createStreamValidator({ type: "object", unevaluatedProperties: false })).toThrow();
    expect(() => createStreamValidator({ frobnicate: true } as SchemaOrBoolean)).toThrow();
  });
});
