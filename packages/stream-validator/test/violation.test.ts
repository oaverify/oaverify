import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { formatSummary, formatText, toProblemDetails } from "@oaverify/internal-core";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { createStreamValidator, type SchemaViolation, toValidationError } from "../src/index.js";

const enc = new TextEncoder();

/** Collect every violation from a detached, unbounded run. */
async function violationsOf(schema: SchemaOrBoolean, value: unknown): Promise<SchemaViolation[]> {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
  });
  const seen: SchemaViolation[] = [];
  validator.on("violation", (v: SchemaViolation) => seen.push(v));
  validator.on("error", () => {});
  await pipeline(
    Readable.from(Buffer.from(enc.encode(JSON.stringify(value)))),
    validator,
    new Writable({ write: (_c, _e, cb) => cb() }),
  );
  return seen;
}

describe("toValidationError", () => {
  it("fills a coarse message and carries byteOffset on a STREAM-path violation", () => {
    const v: SchemaViolation = { code: "type", path: ["age"], byteOffset: 42 };
    const e = toValidationError(v);
    expect(e.code).toBe("type");
    expect(e.path).toEqual(["age"]);
    expect(e.message).toBe("value has the wrong type");
    expect(e.params).toEqual({ byteOffset: 42 });
    expect(e.children).toEqual([]);
  });

  it("falls back to a generic message for an unknown code", () => {
    expect(toValidationError({ code: "mystery", path: [], byteOffset: 0 }).message).toBe(
      'value does not satisfy "mystery"',
    );
  });

  it("preserves the BUFFER-path message/params/children and merges byteOffset", () => {
    const v: SchemaViolation = {
      code: "enum",
      path: ["kind"],
      byteOffset: 7,
      message: "value must be one of x, y",
      params: { allowed: ["x", "y"] },
      children: [{ code: "const", path: ["kind"], byteOffset: 7 }],
    };
    const e = toValidationError(v);
    expect(e.message).toBe("value must be one of x, y");
    expect(e.params).toEqual({ allowed: ["x", "y"], byteOffset: 7 });
    expect(e.children).toHaveLength(1);
    expect(e.children[0]!.message).toBe("value is not the allowed constant");
    expect(e.children[0]!.params).toEqual({ byteOffset: 7 });
  });

  it("maps a list to a list (mirrors toJsonObject)", () => {
    const errors = toValidationError([
      { code: "required", path: [], byteOffset: 0 },
      { code: "type", path: ["id"], byteOffset: 5 },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.code)).toEqual(["required", "type"]);
  });

  it("renders through core's formatters (STREAM path)", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" } },
    };
    const violations = await violationsOf(schema, { id: "nope" });
    const errors = toValidationError(violations);

    expect(violations.length).toBeGreaterThan(0);
    expect(formatText(errors)).toContain("[type]");
    expect(formatSummary(errors)).toContain("wrong type");

    const pd = toProblemDetails(errors);
    expect(pd.status).toBe(400);
    expect(pd.issues[0]!.code).toBe("type");
    expect(pd.issues[0]!.params).toMatchObject({ byteOffset: expect.any(Number) });
  });
});
