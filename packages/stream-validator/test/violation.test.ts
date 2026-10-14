import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ERROR_CODES,
  formatSummary,
  formatText,
  toProblemDetails,
} from "@oaverify/internal-core";
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

describe("numeric bound codes (#1199)", () => {
  it("names every bound failure with a documented code", async () => {
    const schema = {
      type: "object",
      properties: {
        lo: { minimum: 5 },
        hi: { maximum: 5 },
        xlo: { exclusiveMinimum: 5 },
        xhi: { exclusiveMaximum: 5 },
      },
    };
    const seen = await violationsOf(schema, { lo: 4, hi: 6, xlo: 5, xhi: 5 });
    expect(seen.map((v) => [v.path, v.code])).toEqual([
      [["lo"], "minimum"],
      [["hi"], "maximum"],
      [["xlo"], "exclusiveMinimum"],
      [["xhi"], "exclusiveMaximum"],
    ]);
    for (const v of seen) expect(BUILT_IN_ERROR_CODES).toContain(v.code);
  });
});

describe("own __proto__ keys on the buffered equality path (#1201)", () => {
  const schema = JSON.parse(
    '{"properties":{' +
      '"c":{"const":{"__proto__":{"a":1}}},' +
      '"n":{"const":{"k":[{"__proto__":"x"}]}},' +
      '"m":{"enum":[1,"x",{"__proto__":"x"},[{"__proto__":{"b":null}}]]}}}',
  ) as SchemaOrBoolean;
  const bytes = (text: string) => enc.encode(text);

  async function verdict(text: string): Promise<boolean> {
    const validator = createStreamValidator(schema, {
      policy: "detach",
      maxErrors: Number.POSITIVE_INFINITY,
    });
    validator.on("error", () => {});
    validator.resume();
    const result = validator.result;
    validator.end(Buffer.from(bytes(text)));
    return (await result).valid;
  }

  it("accepts equal values, nested and among mixed enum candidates, and rejects others", async () => {
    expect(
      await verdict(
        '{"c":{"__proto__":{"a":1}},"n":{"k":[{"__proto__":"x"}]},"m":{"__proto__":"x"}}',
      ),
    ).toBe(true);
    expect(await verdict('{"m":[{"__proto__":{"b":null}}]}')).toBe(true);
    expect(await verdict('{"m":"x"}')).toBe(true);
    for (const bad of [
      '{"c":{}}',
      '{"c":{"__proto__":{"a":2}}}',
      '{"n":{"k":[{}]}}',
      '{"n":{"k":[{"__proto__":"y"}]}}',
      '{"m":{}}',
      '{"m":[{}]}',
    ]) {
      expect(await verdict(bad), bad).toBe(false);
    }
  });
});
