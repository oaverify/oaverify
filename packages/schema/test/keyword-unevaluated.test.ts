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

describe("dependencies (draft-07) and unevaluated* siblings", () => {
  // `dependencies` is the draft-07 spelling of `dependentSchemas` (plus
  // the array form of `dependentRequired`). Its object-valued entries
  // apply to the same instance, so they must take part in
  // evaluated-key tracking exactly as `dependentSchemas` does.
  // Each case is asserted against both spellings, because the two
  // agreeing is the contract; pinning `dependencies` alone would not
  // notice the pair drifting apart again.
  const cases = ["dependentSchemas", "dependencies"] as const;

  it.each(cases)("%s: a dependent schema's properties count as evaluated", (kw) => {
    const v = compile({
      type: "object",
      properties: { x: {} },
      [kw]: { x: { properties: { b: {} } } },
      unevaluatedProperties: false,
    });
    // `b` is evaluated by the dependent schema that `x` triggered.
    expect(v.validate({ x: 1, b: 2 }).valid).toBe(true);
    // An unrelated property is still unevaluated.
    expect(v.validate({ x: 1, b: 2, other: 3 }).valid).toBe(false);
  });

  it.each(cases)("%s: unevaluatedProperties inside the dependent schema is enforced", (kw) => {
    // The tracking gate walks the schema looking for `unevaluated*`. It
    // has to see through this position, or tracking never switches on
    // and the inner keyword silently accepts everything.
    //
    // The dependent schema names both properties itself: annotations
    // flow up from an in-place applicator, not down into one, so the
    // parent's `properties` does not make `x` evaluated in here.
    const v = compile(
      {
        type: "object",
        properties: { x: {} },
        [kw]: { x: { properties: { x: {}, b: {} }, unevaluatedProperties: false } },
      },
      { output: "flat" },
    );
    expect(v.validate({ x: 1, b: 2 }).valid).toBe(true);
    const r = v.validate({ x: 1, b: 2, zzz: 3 });
    expect(r.valid).toBe(false);
    expect(failure(r).errors.map((e) => e.code)).toContain("unevaluatedProperties");
  });

  it("keeps the array form, which names properties rather than holding a schema", () => {
    const v = compile({ type: "object", dependencies: { x: ["b"] } }, { output: "flat" });
    expect(v.validate({ x: 1, b: 2 }).valid).toBe(true);
    const r = v.validate({ x: 1 });
    expect(r.valid).toBe(false);
    expect(failure(r).errors.map((e) => e.code)).toContain("dependencies");
  });

  it("handles a map holding one entry of each kind", () => {
    const v = compile({
      type: "object",
      properties: { x: {}, y: {} },
      dependencies: { x: ["b"], y: { properties: { c: {} } } },
      unevaluatedProperties: false,
    });
    // `c` is evaluated by y's dependent schema; `b` is only required by
    // x's array entry, and nothing evaluates it.
    expect(v.validate({ y: 1, c: 2 }).valid).toBe(true);
    expect(v.validate({ x: 1, b: 2 }).valid).toBe(false);
  });
});

describe("dependencies as a route to the dynamic-scope machinery", () => {
  // The $dynamicRef gate is a second walk with the same three-loop shape
  // as the unevaluated one. Missing the mixed position there leaves
  // `ref` false, the machinery switched off, and the reference bound
  // statically, which changes the verdict rather than the diagnostics.
  const build = (kw: "dependentSchemas" | "dependencies") =>
    compile({
      $id: "https://ex/strict-tree",
      $dynamicAnchor: "node",
      $ref: "https://ex/tree",
      unevaluatedProperties: false,
      $defs: {
        tree: {
          $id: "https://ex/tree",
          $dynamicAnchor: "node",
          type: "object",
          properties: { data: true },
          [kw]: {
            data: { properties: { children: { type: "array", items: { $dynamicRef: "#node" } } } },
          },
        },
      },
    });

  it.each(["dependentSchemas", "dependencies"] as const)(
    "%s: a $dynamicRef reached only through the position still rebinds",
    (kw) => {
      // `extra` is unevaluated at the strict-tree resource, and is only
      // rejected if the reference rebinds there.
      expect(build(kw).validate({ data: 1, children: [{ data: 1, extra: 2 }] }).valid).toBe(false);
      expect(build(kw).validate({ data: 1, children: [{ data: 1 }] }).valid).toBe(true);
    },
  );
});
