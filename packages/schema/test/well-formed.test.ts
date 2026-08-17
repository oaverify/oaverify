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
import {
  compileSchema,
  type CompiledSchema,
  type CompileOptions,
} from "../src/compiler/compiler.js";
import { assertWellFormedSchema } from "../src/compiler/well-formed.js";
import { buildKeywordMap } from "../src/introspection.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

// No caller overrides `output`, so this is always the flat default.
// Annotated rather than inferred: without it the return type is the
// union of all three shapes and every `.valid` below is a type error.
const compileWith = (schema: unknown, overrides: Partial<CompileOptions> = {}): CompiledSchema =>
  compileSchema(
    schema as SchemaOrBoolean,
    {
      dialect: openapi31Dialect,
      ...overrides,
    } as CompileOptions & { output?: "flat" },
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
    [
      "mixed map holder (dependencies)",
      { dependencies: [] },
      /"dependencies" at <root> must be an object mapping names to schemas or to arrays of property names; got an array/,
    ],
    [
      "mixed map value (dependencies.x)",
      { dependencies: { x: "nope" } },
      /schema at "dependencies\.x".*got a string/,
    ],
    [
      "inside a mixed map value (dependencies.x.items)",
      { dependencies: { x: { items: [] } } },
      /"items" at "dependencies\.x" must be an object or boolean; got an array/,
    ],
  ];
  for (const [label, schema, expected] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => compileWith(schema)).toThrow(expected);
    });
  }

  it("accepts the array form of a dependencies entry, which is not a schema", () => {
    // `{x: ["b"]}` carries dependentRequired semantics and names
    // properties. Checking it as a schema would reject a legal document.
    const c = compileWith({ type: "object", dependencies: { x: ["b"], y: { title: "ok" } } });
    expect(c.validate({ x: 1, b: 2 }).valid).toBe(true);
    expect(c.validate({ x: 1 }).valid).toBe(false);
  });

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
  it("throws in every schemaLint mode including off", () => {
    for (const schemaLint of ["off", "warn", "strict"] as const) {
      expect(
        () => compileWith({ type: "object", properties: { a: null } }, { schemaLint }),
        schemaLint,
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
        {
          external: new Map<string, SchemaOrBoolean>([
            ["urn:a", { properties: { bad: null } } as unknown as SchemaOrBoolean],
          ]),
        },
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
    expect(() =>
      assertWellFormedSchema(
        node as SchemaOrBoolean,
        buildKeywordMap(openapi31Dialect.vocabularies),
      ),
    ).not.toThrow();
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
  it("prefixes the thrown message with the caller's label", () => {
    // A path relative to the compiled schema is unambiguous on its own
    // and useless across a spec with dozens of operations. The label is
    // how the HTTP validator says which one this was.
    expect(() =>
      compileWith(
        { type: "object", properties: { a: { type: "array", items: null } } },
        { label: "POST /things request body (application/json)" },
      ),
    ).toThrow(
      /^POST \/things request body \(application\/json\): "items" at "properties\.a" must be an object/,
    );
  });

  it("keeps the external-schema label distinct from the caller's", () => {
    expect(() =>
      compileWith(
        { $ref: "urn:ext" },
        {
          label: "GET /pets 200 response",
          external: new Map([["urn:ext", { type: "array", items: null } as never]]),
        },
      ),
    ).toThrow(/^GET \/pets 200 response: external schema "urn:ext": /);
  });

  // `$defs` in the same object is walked structurally, so it cannot
  // show whether refs are followed. These supply a resolver whose
  // targets are not reachable from the schema object at all, which is
  // the shape the HTTP pipeline actually has: components arrive through
  // the resolver, not in the compiled schema (#512).
  const withTargets = (targets: Record<string, unknown>) => ({
    resolve(ref: string) {
      const t = targets[ref];
      if (t === undefined) throw new Error(`unresolvable ${ref}`);
      return t as SchemaOrBoolean;
    },
  });

  it("checks schemas reached only through the resolver", () => {
    expect(() =>
      compileWith(
        { type: "object", properties: { email: { $ref: "#/components/schemas/Email" } } },
        {
          refResolver: withTargets({
            "#/components/schemas/Email": {
              type: "object",
              properties: { tags: { items: [{ type: "string" }] } },
            },
          }),
        },
      ),
    ).toThrow(
      /"items" at "components\.schemas\.Email\.properties\.tags" must be an object or boolean/,
    );
  });

  it("names the component in the path, not the route that reached it", () => {
    expect(() =>
      compileWith(
        { properties: { a: { $ref: "#/components/schemas/Bad" } } },
        { refResolver: withTargets({ "#/components/schemas/Bad": { not: [{ type: "string" }] } }) },
      ),
    ).toThrow(/at "components\.schemas\.Bad"/);
  });

  it("leaves an unresolvable $ref to the compiler to report", () => {
    // A dangling ref is its own error with its own message. This pass
    // must not restate it as a well-formedness complaint.
    expect(() =>
      compileWith({ properties: { a: { $ref: "#/nope" } } }, { refResolver: withTargets({}) }),
    ).toThrow(/nope/);
  });

  it("terminates on a component that references itself", () => {
    const self: Record<string, unknown> = { type: "object" };
    self["properties"] = { next: { $ref: "#/components/schemas/Node" } };
    expect(() =>
      compileWith(
        { $ref: "#/components/schemas/Node" },
        { refResolver: withTargets({ "#/components/schemas/Node": self }) },
      ),
    ).not.toThrow();
  });
});
