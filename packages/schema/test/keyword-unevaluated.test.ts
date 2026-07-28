import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("unevaluatedProperties keyword", () => {
  it("rejects properties not covered by properties or patternProperties", () => {
    const v = compile({
      properties: { a: { type: "string" } },
      patternProperties: { "^x-": true },
      unevaluatedProperties: false,
    });
    expect(v.validate({ a: "x", "x-extra": 1 }).valid).toBe(true);
    const r = v.validate({ a: "x", unknown: 1 });
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("unevaluatedProperties");
    expect(failure(r).error.path).toEqual(["unknown"]);
  });

  it("validates unevaluated properties against the given schema", () => {
    const v = compile({
      properties: { a: { type: "string" } },
      unevaluatedProperties: { type: "number" },
    });
    expect(v.validate({ a: "x", b: 1, c: 2 }).valid).toBe(true);
    expect(v.validate({ a: "x", b: "not a number" }).valid).toBe(false);
  });

  it("additionalProperties marks everything evaluated, making unevaluatedProperties a no-op", () => {
    const v = compile({
      properties: { a: { type: "string" } },
      additionalProperties: true,
      unevaluatedProperties: false,
    });
    expect(v.validate({ a: "x", extra: 1 }).valid).toBe(true);
  });
});

describe("unevaluatedItems keyword", () => {
  it("rejects items past the evaluated range when set to false", () => {
    const v = compile({
      prefixItems: [{ type: "string" }],
      unevaluatedItems: false,
    });
    expect(v.validate(["x"]).valid).toBe(true);
    expect(v.validate(["x", 1]).valid).toBe(false);
  });

  it("items: <schema> marks every element evaluated", () => {
    const v = compile({
      items: { type: "number" },
      unevaluatedItems: false,
    });
    expect(v.validate([1, 2, 3]).valid).toBe(true);
  });

  it("validates remaining items against the given schema", () => {
    const v = compile({
      prefixItems: [{ type: "string" }],
      unevaluatedItems: { type: "number" },
    });
    expect(v.validate(["x", 1, 2]).valid).toBe(true);
    expect(v.validate(["x", "not num"]).valid).toBe(false);
  });
});

describe("discriminator keyword", () => {
  it("validates only the branch selected by the discriminator property", () => {
    const v = compile({
      $defs: {
        Cat: {
          type: "object",
          required: ["purr"],
          properties: { kind: { const: "Cat" }, purr: { type: "boolean" } },
        },
        Dog: {
          type: "object",
          required: ["bark"],
          properties: { kind: { const: "Dog" }, bark: { type: "string" } },
        },
      },
      discriminator: { propertyName: "kind", mapping: { Cat: "#/$defs/Cat", Dog: "#/$defs/Dog" } },
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
    });
    expect(v.validate({ kind: "Cat", purr: true }).valid).toBe(true);
    expect(v.validate({ kind: "Dog", bark: "woof" }).valid).toBe(true);

    const r = v.validate({ kind: "Cat" });
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("required");
    expect(failure(r).error.path).toEqual(["purr"]);
  });

  it("errors when the discriminator value matches no branch", () => {
    const v = compile({
      $defs: {
        Cat: { type: "object", properties: { kind: { const: "Cat" } } },
      },
      discriminator: { propertyName: "kind", mapping: { Cat: "#/$defs/Cat" } },
      oneOf: [{ $ref: "#/$defs/Cat" }],
    });
    const r = v.validate({ kind: "Mouse" });
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("discriminator");
    expect(failure(r).error.params).toMatchObject({ value: "Mouse" });
  });

  it("errors when the discriminator property is missing or non-string", () => {
    const v = compile({
      $defs: { Cat: { type: "object" } },
      discriminator: { propertyName: "kind", mapping: { Cat: "#/$defs/Cat" } },
      oneOf: [{ $ref: "#/$defs/Cat" }],
    });
    const r = v.validate({});
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("discriminator");
  });

  it("falls back to the schema name when no explicit mapping is declared", () => {
    // Per OAS: with no `mapping`, the discriminator value matches the
    // last path segment of a branch's `$ref`.
    const v = compile({
      $defs: {
        Cat: { type: "object", required: ["purr"], properties: { purr: { type: "boolean" } } },
        Dog: { type: "object", required: ["bark"], properties: { bark: { type: "string" } } },
      },
      discriminator: { propertyName: "kind" },
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
    });
    expect(v.validate({ kind: "Cat", purr: true }).valid).toBe(true);
    expect(v.validate({ kind: "Dog", bark: "woof" }).valid).toBe(true);
    const r = v.validate({ kind: "Mouse" });
    expect(failure(r).error.code).toBe("discriminator");
    expect(failure(r).error.params).toMatchObject({ value: "Mouse" });
  });

  it("accepts multiple mapping keys that point to the same branch", () => {
    // eov #1088: two mapping entries targeting the same schema should
    // not collide; each key routes to the shared branch deterministically.
    const v = compile({
      $defs: {
        Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
      discriminator: {
        propertyName: "kind",
        mapping: { Dog: "#/$defs/Pet", Cat: "#/$defs/Pet" },
      },
      oneOf: [{ $ref: "#/$defs/Pet" }],
    });
    expect(v.validate({ kind: "Dog", name: "Rex" }).valid).toBe(true);
    expect(v.validate({ kind: "Cat", name: "Luna" }).valid).toBe(true);
    expect(v.validate({ kind: "Dog" }).valid).toBe(false);
  });

  it("reports the array index in the error path for discriminator branches inside an array", () => {
    // eov #669: error paths must include the array index so the caller
    // can tell which element failed.
    const v = compile({
      $defs: {
        Cat: {
          type: "object",
          required: ["purr"],
          properties: { kind: { const: "Cat" }, purr: { type: "boolean" } },
        },
        Dog: {
          type: "object",
          required: ["bark"],
          properties: { kind: { const: "Dog" }, bark: { type: "string" } },
        },
      },
      type: "array",
      items: {
        discriminator: { propertyName: "kind" },
        oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
      },
    });
    const r = v.validate([
      { kind: "Cat", purr: true },
      { kind: "Dog", bark: "woof" },
      { kind: "Cat" }, // missing purr
    ]);
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("required");
    expect(failure(r).error.path).toEqual([2, "purr"]);
  });
});
