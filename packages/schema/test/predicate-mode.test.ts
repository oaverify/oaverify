/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, openapi31Dialect } from "../src/keywords/vocabulary.js";
import { builtInFormats } from "@oaverify/internal-formats";

const predicate = (schema: SchemaOrBoolean) =>
  compileSchema(schema, { dialect: jsonSchemaDialect, predicate: true, formats: builtInFormats });

const tree = (schema: SchemaOrBoolean) =>
  compileSchema(schema, { dialect: jsonSchemaDialect, formats: builtInFormats });

/**
 * Every test in this file checks two things:
 *   1. predicate-mode returns the right boolean.
 *   2. predicate's boolean matches tree-mode's `valid` on the same input.
 * That parity check is the main safety net: if the two modes disagree
 * on any fixture, we broke something.
 */
function parity(schema: SchemaOrBoolean, samples: { valid: unknown[]; invalid: unknown[] }) {
  const p = predicate(schema);
  const t = tree(schema);
  for (const v of samples.valid) {
    expect(p.validate(v)).toBe(true);
    expect(t.validate(v).valid).toBe(true);
  }
  for (const v of samples.invalid) {
    expect(p.validate(v)).toBe(false);
    expect(t.validate(v).valid).toBe(false);
  }
}

describe("predicate mode: return type", () => {
  it("returns raw boolean, not a ValidationResult", () => {
    const v = predicate({ type: "number" });
    expect(v.validate(1)).toBe(true);
    expect(v.validate("x")).toBe(false);
  });

  it("boolean schema `true` → always passes", () => {
    const v = predicate(true);
    expect(v.validate(1)).toBe(true);
    expect(v.validate(null)).toBe(true);
  });

  it("boolean schema `false` → always fails", () => {
    const v = predicate(false);
    expect(v.validate(1)).toBe(false);
    expect(v.validate(null)).toBe(false);
  });
});

describe("predicate mode: leaf keywords (bucket A, via emitError)", () => {
  it("type", () => {
    parity({ type: "number" }, { valid: [1, 1.5, -0], invalid: ["x", null, [], {}] });
  });

  it("const / enum", () => {
    parity({ const: "hi" }, { valid: ["hi"], invalid: ["bye", 1, null] });
    parity({ enum: [1, 2, 3] }, { valid: [1, 2, 3], invalid: [4, "1", null] });
  });

  it("numeric bounds", () => {
    parity(
      { type: "number", minimum: 0, maximum: 10, multipleOf: 2 },
      { valid: [0, 2, 10], invalid: [-1, 11, 3, "2"] },
    );
    parity(
      { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
      { valid: [1, 9], invalid: [0, 10] },
    );
  });

  it("string bounds + pattern", () => {
    parity(
      { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
      { valid: ["ab", "abcde"], invalid: ["a", "abcdef", "aB1"] },
    );
  });

  it("format (asserted under openapi31Dialect)", () => {
    const p = compileSchema(
      { format: "email" },
      { dialect: openapi31Dialect, predicate: true, formats: { email: (s) => /@/.test(s) } },
    );
    expect(p.validate("a@b.c")).toBe(true);
    expect(p.validate("nope")).toBe(false);
  });

  it("array bounds + uniqueItems", () => {
    parity(
      { type: "array", minItems: 1, maxItems: 3, uniqueItems: true },
      { valid: [[1], [1, 2, 3]], invalid: [[], [1, 1], [1, 2, 3, 4]] },
    );
  });

  it("object bounds + required", () => {
    parity(
      { type: "object", minProperties: 1, required: ["a"] },
      { valid: [{ a: 1 }, { a: 1, b: 2 }], invalid: [{}, { b: 2 }] },
    );
  });
});

describe("predicate mode: applicator keywords", () => {
  it("properties + additionalProperties:false", () => {
    parity(
      {
        type: "object",
        properties: { a: { type: "number" } },
        additionalProperties: false,
      },
      { valid: [{ a: 1 }, {}], invalid: [{ a: "x" }, { a: 1, b: 2 }] },
    );
  });

  it("items + prefixItems", () => {
    parity(
      {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
        items: { type: "boolean" },
      },
      {
        valid: [
          [1, "x"],
          [1, "x", true, false],
        ],
        invalid: [
          ["x", "x"],
          [1, 2],
          [1, "x", "no"],
        ],
      },
    );
  });

  it("patternProperties + propertyNames", () => {
    parity(
      {
        type: "object",
        // Pattern admits lowercase letters, digits, and underscore,
        // so `x_1` / `y` are valid keys.
        propertyNames: { pattern: "^[a-z_0-9]+$" },
        patternProperties: { "^x_": { type: "number" } },
      },
      {
        valid: [{ x_1: 1 }, { y: "anything" }],
        invalid: [{ X: 1 }, { x_1: "not-a-number" }],
      },
    );
  });
});

describe("predicate mode: composition (bucket B, rewritten)", () => {
  it("allOf", () => {
    parity(
      { allOf: [{ type: "number" }, { minimum: 0 }, { maximum: 10 }] },
      { valid: [0, 5, 10], invalid: [-1, 11, "x"] },
    );
  });

  it("anyOf", () => {
    parity(
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { valid: ["x", 1], invalid: [true, null, []] },
    );
  });

  it("oneOf: exactly-one semantics", () => {
    parity({ oneOf: [{ type: "number" }, { minimum: 5 }] }, { valid: ["x", 3], invalid: [7] });
    // 7 matches both branches ({type: number} AND {minimum: 5}), so oneOf fails.
    // 3 matches only {type: number}.
    // "x" matches neither (well, minimum: 5 is vacuously true for non-numbers).
    // Wait: minimum: 5 with non-number data is vacuously valid. So "x"
    // passes {minimum: 5} but not {type: number}; single match → oneOf valid.
  });

  it("not", () => {
    parity({ not: { type: "string" } }, { valid: [1, null, {}], invalid: ["x"] });
  });

  it("if/then/else", () => {
    parity(
      {
        if: { type: "string" },
        then: { minLength: 2 },
        else: { type: "number", minimum: 0 },
      },
      { valid: ["ok", 0, 5], invalid: ["x", -1, true] },
    );
  });

  it("if alone (no then/else) is always valid", () => {
    parity({ if: { type: "string" } }, { valid: ["x", 1, null], invalid: [] });
  });

  it("dependentSchemas", () => {
    parity(
      {
        type: "object",
        dependentSchemas: { a: { required: ["b"] } },
      },
      {
        valid: [{}, { b: 1 }, { a: 1, b: 2 }],
        invalid: [{ a: 1 }],
      },
    );
  });

  it("legacy dependencies (schema form)", () => {
    parity(
      {
        type: "object",
        dependencies: { a: { required: ["b"] } },
      },
      {
        valid: [{}, { a: 1, b: 2 }],
        invalid: [{ a: 1 }],
      },
    );
  });

  it("legacy dependencies (array form)", () => {
    parity(
      {
        type: "object",
        dependencies: { a: ["b", "c"] },
      },
      {
        valid: [{}, { a: 1, b: 2, c: 3 }],
        invalid: [{ a: 1 }, { a: 1, b: 2 }],
      },
    );
  });
});

describe("predicate mode: contains keyword", () => {
  it("default minContains: 1", () => {
    parity(
      { type: "array", contains: { type: "number" } },
      { valid: [[1], ["x", 2]], invalid: [[], ["x", "y"]] },
    );
  });

  it("minContains + maxContains", () => {
    parity(
      {
        type: "array",
        contains: { type: "number" },
        minContains: 2,
        maxContains: 3,
      },
      {
        valid: [
          [1, 2],
          [1, 2, 3],
        ],
        invalid: [[1], [1, 2, 3, 4], []],
      },
    );
  });

  it("minContains: 0 allows no matches", () => {
    parity(
      { type: "array", contains: { type: "number" }, minContains: 0 },
      { valid: [[], ["x"]], invalid: [] },
    );
  });
});

describe("predicate mode: $ref recursion", () => {
  it("self-referential tree structure", () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: "number" },
        children: { type: "array", items: { $ref: "#" } },
      },
      required: ["value"],
    } as const;
    parity(schema, {
      valid: [
        { value: 1 },
        { value: 1, children: [{ value: 2 }] },
        { value: 1, children: [{ value: 2, children: [{ value: 3 }] }] },
      ],
      invalid: [
        {}, // missing value
        { value: "nope" },
        { value: 1, children: [{ value: "x" }] },
        { value: 1, children: [{ value: 1, children: [{}] }] },
      ],
    });
  });
});

describe("predicate mode: unevaluatedProperties/unevaluatedItems", () => {
  it("unevaluatedProperties over allOf", () => {
    parity(
      {
        allOf: [
          { type: "object", properties: { a: { type: "number" } } },
          { properties: { b: { type: "string" } } },
        ],
        unevaluatedProperties: false,
      },
      {
        valid: [{}, { a: 1, b: "x" }],
        invalid: [{ a: 1, b: "x", c: true }],
      },
    );
  });

  it("unevaluatedItems over prefixItems", () => {
    parity(
      {
        type: "array",
        prefixItems: [{ type: "number" }],
        unevaluatedItems: false,
      },
      {
        valid: [[1], []],
        invalid: [[1, 2]],
      },
    );
  });

  it("unevaluatedProperties with $ref annotations passing through", () => {
    parity(
      {
        $defs: { named: { properties: { name: { type: "string" } } } },
        allOf: [{ $ref: "#/$defs/named" }],
        unevaluatedProperties: false,
      },
      {
        valid: [{ name: "x" }, {}],
        invalid: [{ name: "x", other: 1 }],
      },
    );
  });
});

describe("predicate mode: discriminator (OAS 3.1)", () => {
  it("routes to the named branch, reporting its result", () => {
    const schema = {
      oneOf: [{ $ref: "#/$defs/cat" }, { $ref: "#/$defs/dog" }],
      discriminator: {
        propertyName: "kind",
        mapping: { cat: "#/$defs/cat", dog: "#/$defs/dog" },
      },
      $defs: {
        cat: {
          type: "object",
          properties: { kind: { const: "cat" }, meow: { type: "boolean" } },
          required: ["kind", "meow"],
        },
        dog: {
          type: "object",
          properties: { kind: { const: "dog" }, bark: { type: "string" } },
          required: ["kind", "bark"],
        },
      },
    } as const;
    const p = compileSchema(schema, { dialect: openapi31Dialect, predicate: true });
    expect(p.validate({ kind: "cat", meow: true })).toBe(true);
    expect(p.validate({ kind: "dog", bark: "woof" })).toBe(true);
    expect(p.validate({ kind: "cat", meow: "not-a-bool" })).toBe(false);
    expect(p.validate({ kind: "fish" })).toBe(false);
    expect(p.validate({ kind: 42 })).toBe(false);
    // Non-object data is vacuously valid; discriminator only activates
    // on objects; the schema has no sibling `type: "object"` constraint,
    // so that matches tree-mode semantics.
  });
});

describe("predicate mode: option interactions", () => {
  it("throws when combined with finite maxErrors", () => {
    expect(() =>
      compileSchema(
        { type: "number" },
        { dialect: jsonSchemaDialect, predicate: true, maxErrors: 1 },
      ),
    ).toThrow(/predicate.*maxErrors|maxErrors.*predicate/i);
  });

  it("accepts maxErrors: Infinity alongside predicate (no-op)", () => {
    const v = compileSchema(
      { type: "number" },
      {
        dialect: jsonSchemaDialect,
        predicate: true,
        maxErrors: Number.POSITIVE_INFINITY,
      },
    );
    expect(v.validate(1)).toBe(true);
    expect(v.validate("x")).toBe(false);
  });
});

describe("predicate mode: generated source sanity", () => {
  it("never emits tree-runtime helpers", () => {
    const v = predicate({
      type: "object",
      properties: {
        a: { type: "number", minimum: 0 },
        b: { type: "string", pattern: "^[a-z]+$" },
      },
      allOf: [{ not: { required: ["c"] } }],
      required: ["a"],
    });
    // The compiler sets `emittedTreeRuntime` iff the source references
    // `createLeafError` / `createBranchError` / `wrapErrors`, all
    // tree-mode only. Asserting on the stat keeps the invariant stable
    // under codegen renames (compare the `functionCount` precedent in
    // inlining.test.ts).
    expect(v.stats.emittedTreeRuntime).toBe(false);
  });

  it("tree mode does emit tree-runtime helpers (control)", () => {
    // Guards the complement: make sure emittedTreeRuntime isn't stuck
    // at false; a non-predicate schema that actually reports errors
    // should flip it.
    const v = compileSchema({ type: "string", minLength: 3 }, { dialect: jsonSchemaDialect });
    expect(v.stats.emittedTreeRuntime).toBe(true);
  });

  it("top-level validate is arity 1", () => {
    const v = predicate({ type: "number" });
    expect(v.validate.length).toBe(1);
  });
});
