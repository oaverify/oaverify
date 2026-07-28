/**
 * Well-formedness pre-pass: a value in a schema-valued slot that is not
 * a schema is rejected before compilation descends into it.
 *
 * Two failure modes motivated this, and they look nothing alike from
 * the outside. An array-valued `items` used to compile as a
 * keyword-free schema, so the array's elements went unvalidated and no
 * strict mode said a word -- unsound, and invisible. A null slot used
 * to throw a raw TypeError from inside codegen, naming no schema and no
 * path. Same defect underneath: a non-schema in a schema slot.
 *
 * The assertions here are about *diagnosis* as much as rejection. An
 * error that does not carry the path is barely better than the
 * TypeError it replaced, so every case pins the location.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { assertWellFormedSchema } from "../src/compiler/well-formed.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

const compileWith = (schema: unknown, overrides: Record<string, unknown> = {}) =>
  compileSchema(
    schema as SchemaOrBoolean,
    {
      dialect: openapi31Dialect,
      ...overrides,
    } as never,
  );

describe("well-formedness: unsound shapes", () => {
  it("rejects array-valued items instead of dropping the constraint", () => {
    // The regression that matters most: this used to compile clean and
    // return valid for { events: [123] }.
    expect(() =>
      compileWith({
        type: "object",
        properties: { events: { type: "array", items: [{ type: "string" }] } },
      }),
    ).toThrow(/"items" at "properties\.events" must be an object or boolean; got an array/);
  });

  it("names prefixItems as the fix for an array-valued items", () => {
    expect(() => compileWith({ type: "array", items: [{ type: "string" }] })).toThrow(
      /prefixItems/,
    );
  });

  it("still accepts the correct spellings", () => {
    const single = compileWith({ type: "array", items: { type: "string" } });
    expect(single.validate([123]).valid).toBe(false);
    expect(single.validate(["a"]).valid).toBe(true);

    const tuple = compileWith({ type: "array", prefixItems: [{ type: "string" }] });
    expect(tuple.validate([123]).valid).toBe(false);
    expect(tuple.validate(["a"]).valid).toBe(true);
  });
});

describe("well-formedness: located errors", () => {
  it("reports a null slot with its path instead of a raw TypeError", () => {
    let err: unknown;
    try {
      compileWith({ type: "object", properties: { a: null } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    // The pre-fix failure was `TypeError: Cannot read properties of null
    // (reading '$id')`, which is what makes the negative assertions here
    // worth keeping.
    expect((err as Error).constructor.name).toBe("Error");
    expect((err as Error).message).toContain("properties.a");
    expect((err as Error).message).toContain("null");
    expect((err as Error).message).not.toContain("$id");
  });

  it("reports the deep path, not just the nearest parent", () => {
    expect(() =>
      compileWith({
        $defs: { Amounts: { allOf: [{ type: "object" }, { if: null }] } },
      }),
    ).toThrow(/"if" at "\$defs\.Amounts\.allOf\[1\]"/);
  });

  it("uses <root> for the schema itself", () => {
    expect(() => compileWith(null)).toThrow(
      /schema at <root> must be an object or boolean; got null/,
    );
    expect(() => compileWith("nope")).toThrow(/schema at <root>.*got a string \("nope"\)/);
  });
});

describe("well-formedness: every schema-valued position", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "single (not)",
      { not: 3 },
      /"not" at <root> must be an object or boolean; got a number \(3\)/,
    ],
    [
      "single (additionalProperties)",
      { additionalProperties: "x" },
      /"additionalProperties" at <root>/,
    ],
    [
      "array holder (allOf)",
      { allOf: "x" },
      /"allOf" at <root> must be an array of schemas; got a string/,
    ],
    ["array element (oneOf\\[1\\])", { oneOf: [{}, null] }, /schema at "oneOf\[1\]".*got null/],
    [
      "map holder (properties)",
      { properties: [] },
      /"properties" at <root> must be an object mapping names to schemas; got an array/,
    ],
    ["map value ($defs)", { $defs: { A: 7 } }, /schema at "\$defs\.A".*got a number/],
  ];
  for (const [label, schema, expected] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => compileWith(schema)).toThrow(expected);
    });
  }

  it("accepts boolean schemas wherever a schema is legal", () => {
    const c = compileWith({
      type: "object",
      properties: { a: true, b: false },
      additionalProperties: false,
    });
    expect(c.validate({ a: 1 }).valid).toBe(true);
    expect(c.validate({ b: 1 }).valid).toBe(false);
  });
});

describe("well-formedness: precondition, not a lint level", () => {
  it("throws in every strict mode including off", () => {
    for (const strict of ["off", "warn-partial", "strict"] as const) {
      expect(
        () => compileWith({ type: "object", properties: { a: null } }, { strict }),
        strict,
      ).toThrow(/properties\.a/);
    }
  });

  it("applies across dialects", () => {
    for (const dialect of [jsonSchemaDialect, openapi31Dialect, oas30Dialect]) {
      expect(() =>
        compileWith({ type: "array", items: [{ type: "string" }] }, { dialect }),
      ).toThrow(/"items" at <root>/);
    }
  });

  it("checks external schemas too, and says which one", () => {
    expect(() =>
      compileWith(
        { $ref: "urn:a" },
        { external: new Map([["urn:a", { properties: { bad: null } }]]) },
      ),
    ).toThrow(/external schema "urn:a": schema at "properties\.bad".*got null/);
  });
});

describe("well-formedness: does not reject legal schemas", () => {
  it("terminates on a self-referential object graph", () => {
    // Cycles normally survive as `$ref` strings, which are never
    // descended. A hand-built schema can still cycle directly, and the
    // pre-pass must not hang on one.
    //
    // Asserted against the pass itself, not `compileSchema`: codegen
    // recurses such a graph until the stack gives out (RangeError), and
    // an object cycle is not expressible in JSON, so that is not a
    // shape this pass is meant to rescue. It only must not be the thing
    // that hangs.
    const node: Record<string, unknown> = { type: "object" };
    node.properties = { self: node };
    expect(() => assertWellFormedSchema(node as SchemaOrBoolean)).not.toThrow();
  });

  it("shares a subschema without re-walking it", () => {
    const shared = { type: "string" };
    expect(() => compileWith({ properties: { a: shared, b: shared } })).not.toThrow();
  });

  it("leaves non-schema keywords alone", () => {
    // `enum`, `const`, `default`, `examples` hold arbitrary user data,
    // including nulls and arrays. Walking into them would be wrong.
    const c = compileWith({
      type: "object",
      properties: {
        a: { enum: [null, [1, 2], { x: 1 }], default: null, examples: [null] },
        b: { const: null },
      },
    });
    expect(c.validate({ a: null, b: null }).valid).toBe(true);
    expect(c.validate({ a: "nope", b: null }).valid).toBe(false);
  });

  it("accepts a genuinely absent slot", () => {
    expect(() => compileWith({ type: "object" })).not.toThrow();
  });

  it("rejects a present key holding undefined, and says to remove it", () => {
    // Not a hypothetical: `{ items: maybeSchema }` where `maybeSchema`
    // is undefined is an easy shape to build in JS. Keyword dispatch
    // walks Object.keys, which reports the key, so this used to reach
    // codegen and die with "Cannot read properties of undefined
    // (reading 'length')". JSON cannot express it, so it only ever
    // arrives from a hand-built schema.
    expect(() => compileWith({ type: "array", items: undefined })).toThrow(
      /"items" at <root> must be an object or boolean; got undefined\. Remove the key/,
    );
  });
});
