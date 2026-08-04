import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { openapi31Dialect } from "@oaverify/internal-schema";
import { createStreamValidator } from "../src/index.js";

const enc = new TextEncoder();

/** Run a document through the stream validator and collect error codes. */
async function codes(
  schema: SchemaOrBoolean,
  json: string,
  formats?: Record<string, unknown>,
): Promise<string[]> {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    dialect: openapi31Dialect,
    ...(formats === undefined ? {} : { formats: formats as never }),
  });
  const seen: string[] = [];
  validator.on("violation", (v: { code: string }) => seen.push(v.code));
  validator.on("error", () => {});
  await pipeline(
    Readable.from([Buffer.from(enc.encode(json))]),
    validator,
    new Writable({ write: (_c, _e, cb) => cb() }),
  );
  return seen;
}

// A BUFFER island: the delegate compiles the subtree in memory, which
// is the only place this engine asserts `format`. The forward STREAM
// path treats `format` as an annotation and never runs a validator.
const island: SchemaOrBoolean = {
  type: "object",
  properties: {
    n: { type: "integer", format: "int32", enum: [1, 2, 3000000000] },
  },
} as SchemaOrBoolean;

describe("numeric formats on the stream engine", () => {
  it("asserts int32 inside a BUFFER island", async () => {
    expect(await codes(island, '{"n":3000000000}')).toContain("format");
    expect(await codes(island, '{"n":1}')).toEqual([]);
  });

  it("honours the per-format escape hatch", async () => {
    expect(await codes(island, '{"n":3000000000}', { int32: false })).toEqual([]);
  });

  it("asserts a plain scalar leaf too, exactly where a string format does", async () => {
    // A scalar leaf is materialized before it is checked, so `format`
    // runs on it. Numeric formats therefore reach the same positions
    // string formats already did; there is no numeric-specific gap.
    const plain = { type: "object", properties: { n: { type: "integer", format: "int32" } } };
    expect(await codes(plain as SchemaOrBoolean, '{"n":3000000000}')).toEqual(["format"]);
    expect(await codes(plain as SchemaOrBoolean, '{"n":1}')).toEqual([]);

    const plainString = {
      type: "object",
      properties: { when: { type: "string", format: "date-time" } },
    };
    expect(await codes(plainString as SchemaOrBoolean, '{"when":"not-a-date"}')).toEqual([
      "format",
    ]);
  });
});
