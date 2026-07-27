import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { SpineUnsupportedError, SpineValidator } from "../src/spine/index.js";
import { JsonTokenizer } from "../src/tokenizer/index.js";

const enc = new TextEncoder();

function validate(schema: SchemaOrBoolean, json: string): { valid: boolean; codes: string[] } {
  const spine = new SpineValidator(schema);
  const tok = new JsonTokenizer(spine);
  tok.write(enc.encode(json));
  tok.end();
  const v = spine.verdict();
  return { valid: v.valid, codes: v.violations.map((x) => x.code) };
}

describe("SpineValidator violation paths", () => {
  it("reports the JSON path of a nested violation", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { n: { type: "integer" } } } },
      },
    };
    const spine = new SpineValidator(schema);
    const tok = new JsonTokenizer(spine);
    tok.write(enc.encode('{"items":[{"n":1},{"n":"bad"}]}'));
    tok.end();
    const v = spine.verdict();
    expect(v.valid).toBe(false);
    expect(v.violations[0]?.path).toEqual(["items", 1, "n"]);
  });
});

describe("SpineValidator throws on constructs outside the STREAM set", () => {
  // Without a delegate, a BUFFER-requiring construct can't be validated.
  // (Forward composition does NOT throw: it is TEE'd via forward
  // sub-spines, which need no delegate.)
  const unsupported: Array<[string, SchemaOrBoolean, string]> = [
    ["contains", { type: "array", contains: { type: "string" } }, '["x"]'],
    ["object enum", { enum: [{ a: 1 }] }, '{"a":1}'],
    ["uniqueItems over objects", { type: "array", uniqueItems: true }, "[{}]"],
  ];
  for (const [name, schema, json] of unsupported) {
    it(`throws SpineUnsupportedError for ${name}`, () => {
      const spine = new SpineValidator(schema);
      const tok = new JsonTokenizer(spine);
      expect(() => {
        tok.write(enc.encode(json));
        tok.end();
      }).toThrow(SpineUnsupportedError);
    });
  }

  it("TEEs forward composition without a delegate (no throw)", () => {
    for (const [schema, json, valid] of [
      [{ anyOf: [{ type: "string" }, { type: "integer" }] }, '"x"', true],
      [{ oneOf: [{ type: "integer" }, { minimum: 5 }] }, "7", false],
      [{ not: { type: "null" } }, "null", false],
      [{ allOf: [{ type: "integer" }, { minimum: 0 }] }, "3", true],
    ] as Array<[SchemaOrBoolean, string, boolean]>) {
      const spine = new SpineValidator(schema);
      const tok = new JsonTokenizer(spine);
      tok.write(enc.encode(json));
      tok.end();
      expect(spine.verdict().valid).toBe(valid);
    }
  });
});

describe("SpineValidator recursion is bounded by the heap, not the native stack", () => {
  it("validates a deeply nested value without a RangeError", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { next: { $ref: "#" } },
    };
    // ~20k deep: would blow a recursive-descent native stack, fine on the
    // heap scope stack.
    const depth = 20000;
    const json = `${'{"next":'.repeat(depth)}{}${"}".repeat(depth)}`;
    const result = validate(schema, json);
    expect(result.valid).toBe(true);
  });

  it("still finds a deep violation", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { next: { $ref: "#" }, leaf: { type: "integer" } },
    };
    const json = `{"next":{"next":{"leaf":"notint"}}}`;
    expect(validate(schema, json).valid).toBe(false);
  });
});

describe("SpineValidator enforces over-limits eagerly, under-limits at close", () => {
  // The byte offset of the first violation; proves a count/length limit is
  // reported at the offending token, not at the scope's closing delimiter.
  function firstViolation(
    schema: SchemaOrBoolean,
    json: string,
  ): { code: string; path: (string | number)[]; byteOffset: number } {
    const spine = new SpineValidator(schema);
    const tok = new JsonTokenizer(spine);
    tok.write(enc.encode(json));
    tok.end();
    const v = spine.verdict();
    const first = v.violations[0];
    if (first === undefined) throw new Error("expected a violation");
    return {
      code: first.code,
      path: first.path as (string | number)[],
      byteOffset: first.byteOffset,
    };
  }

  it("fails maxItems at the (max+1)th element's start, not the closing bracket", () => {
    //            0123456789
    const json = "[1,2,3,4]"; // maxItems 2: the 3rd element ('3') is at offset 5
    const codes = validate({ type: "array", maxItems: 2 }, json);
    expect(codes.codes.filter((c) => c === "maxItems")).toHaveLength(1);
    const v = firstViolation({ type: "array", maxItems: 2 }, json);
    expect(v.code).toBe("maxItems");
    expect(v.byteOffset).toBe(5); // '3', not the ']' at offset 8
  });

  it("fails maxProperties at the (max+1)th key, not the closing brace", () => {
    //            0         1
    //            0123456789012345678
    const json = '{"a":1,"b":2,"c":3}'; // maxProperties 2: key "c" opens at offset 13
    const v = firstViolation({ type: "object", maxProperties: 2 }, json);
    expect(v.code).toBe("maxProperties");
    expect(v.byteOffset).toBe(13); // the '"c"' key, not the '}' at offset 18
  });

  it("fails maxLength while the string streams, not at its closing quote", () => {
    //            0    5
    const json = '{"s":"abcdef"}'; // maxLength 3: content 'abcdef' starts at offset 6
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { s: { type: "string", maxLength: 3 } },
    };
    const v = firstViolation(schema, json);
    expect(v.code).toBe("maxLength");
    expect(v.path).toEqual(["s"]);
    expect(v.byteOffset).toBeLessThan(12); // before the closing quote at offset 12
  });

  it("reports minItems / minProperties / minLength at close (the under-limit cannot be eager)", () => {
    expect(validate({ type: "array", minItems: 3 }, "[1,2]").codes).toContain("minItems");
    expect(validate({ type: "object", minProperties: 2 }, '{"a":1}').codes).toContain(
      "minProperties",
    );
    expect(
      validate(
        { type: "object", properties: { s: { type: "string", minLength: 5 } } },
        '{"s":"ab"}',
      ).codes,
    ).toContain("minLength");
  });

  it("keeps the verdict identical to the close-time check (valid stays valid)", () => {
    expect(validate({ type: "array", maxItems: 3 }, "[1,2,3]").valid).toBe(true);
    expect(validate({ type: "object", maxProperties: 2 }, '{"a":1,"b":2}').valid).toBe(true);
    expect(
      validate(
        { type: "object", properties: { s: { type: "string", maxLength: 3 } } },
        '{"s":"abc"}',
      ).valid,
    ).toBe(true);
  });
});
