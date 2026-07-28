/**
 * Keyword *value* guards, as distinct from keyword *name* checking.
 *
 * `strict` mode already catches a misspelled keyword name (`minimumx`).
 * These cover the other half: a keyword that is spelled right holding a
 * value it cannot use. Both failure modes here are silent in their own
 * way.
 *
 * `type: "Boolean"` compiles to a validator nothing satisfies, so the
 * breakage surfaces at runtime on real traffic, and the message blames
 * the payload rather than the spec.
 *
 * `required: "id"` is quieter still. An unchecked cast let the string
 * iterate as its own characters, so the schema demanded properties "i"
 * and "d": the payload the author meant to accept was rejected, and one
 * they never imagined was not. Nothing about the running system looked
 * wrong.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

const compile2020 = (schema: unknown) =>
  compileSchema(schema as SchemaOrBoolean, { dialect: jsonSchemaDialect });
const compileOas30 = (schema: unknown) =>
  compileSchema(schema as SchemaOrBoolean, { dialect: oas30Dialect });

describe("type: legal names", () => {
  it("accepts all seven 2020-12 names, singly and in an array", () => {
    for (const t of ["null", "boolean", "object", "array", "string", "number", "integer"]) {
      expect(() => compile2020({ type: t }), t).not.toThrow();
    }
    expect(() => compile2020({ type: ["string", "null"] })).not.toThrow();
  });

  it("still validates correctly", () => {
    const c = compile2020({ type: ["string", "null"] });
    expect(c.validate("x").valid).toBe(true);
    expect(c.validate(null).valid).toBe(true);
    expect(c.validate(1).valid).toBe(false);
  });
});

describe("type: illegal names", () => {
  it("rejects an unknown name instead of building an unsatisfiable validator", () => {
    expect(() => compile2020({ type: "Boolean" })).toThrow(
      /keyword "type" has unknown type name "Boolean"/,
    );
  });

  it("suggests the intended name for a capitalisation slip", () => {
    // The dominant real-world shape, from Java / C# / TypeScript habits.
    expect(() => compile2020({ type: "Boolean" })).toThrow(/Did you mean "boolean"\?/);
    expect(() => compile2020({ type: "String" })).toThrow(/Did you mean "string"\?/);
    expect(() => compile2020({ type: "Integer" })).toThrow(/Did you mean "integer"\?/);
  });

  it("suggests the intended name for an ordinary misspelling", () => {
    expect(() => compile2020({ type: "stirng" })).toThrow(/Did you mean "string"\?/);
    expect(() => compile2020({ type: "bolean" })).toThrow(/Did you mean "boolean"\?/);
  });

  it("offers no guess when nothing is close", () => {
    let message = "";
    try {
      compile2020({ type: "widget" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/unknown type name "widget"/);
    expect(message).not.toMatch(/Did you mean/);
  });

  it("checks every entry of an array-valued type", () => {
    expect(() => compile2020({ type: ["string", "Boolean"] })).toThrow(
      /unknown type name "Boolean"/,
    );
  });

  it("rejects non-string and empty values", () => {
    expect(() => compile2020({ type: 5 })).toThrow(/requires a type name or array of type names/);
    expect(() => compile2020({ type: null })).toThrow(
      /requires a type name or array of type names/,
    );
    expect(() => compile2020({ type: [] })).toThrow(/requires at least one type name/);
  });

  it("applies under the OpenAPI 3.1 dialect too", () => {
    expect(() =>
      compileSchema({ type: "Boolean" } as SchemaOrBoolean, { dialect: openapi31Dialect }),
    ).toThrow(/unknown type name "Boolean"/);
  });
});

describe("type: OpenAPI 3.0 has a smaller set", () => {
  it("accepts the six 3.0 names", () => {
    for (const t of ["boolean", "object", "array", "string", "number", "integer"]) {
      expect(() => compileOas30({ type: t }), t).not.toThrow();
    }
  });

  it("rejects 'null', which is a 2020-12 name 3.0 does not have", () => {
    // The quiet one: this used to compile to a *working* validator that
    // accepted null, silently enforcing 3.1 semantics in a 3.0 document.
    expect(() => compileOas30({ type: "null" })).toThrow(/unknown type name "null"/);
  });

  it("points at nullable: true rather than guessing a spelling", () => {
    expect(() => compileOas30({ type: "null" })).toThrow(
      /OpenAPI 3\.0 has no 'null' type; use 'nullable: true'/,
    );
    expect(() => compileOas30({ type: "null" })).not.toThrow(/Did you mean/);
  });

  it("still suggests spellings for ordinary typos", () => {
    expect(() => compileOas30({ type: "Boolean" })).toThrow(/Did you mean "boolean"\?/);
  });

  it("keeps the existing array-shape message", () => {
    expect(() => compileOas30({ type: ["string", "null"] })).toThrow(
      /'type' must be a single string.*nullable: true/s,
    );
  });

  it("nullable: true still works", () => {
    const c = compileOas30({ type: "string", nullable: true });
    expect(c.validate(null).valid).toBe(true);
    expect(c.validate("x").valid).toBe(true);
    expect(c.validate(1).valid).toBe(false);
  });
});

describe("required and dependentRequired: array-of-strings", () => {
  it("rejects a bare string instead of iterating its characters", () => {
    // Pre-fix: demanded properties "i" and "d". {id:1} was rejected and
    // {i:1,d:2} accepted.
    expect(() => compile2020({ type: "object", required: "id" })).toThrow(
      /keyword "required" requires an array of strings; got string "id"/,
    );
  });

  it("names the offending element index", () => {
    expect(() => compile2020({ type: "object", required: ["a", 1] })).toThrow(
      /keyword "required" requires an array of strings; element 1 is number 1/,
    );
  });

  it("accepts a well-formed required, including empty", () => {
    expect(() => compile2020({ type: "object", required: [] })).not.toThrow();
    const c = compile2020({ type: "object", required: ["id"] });
    expect(c.validate({ id: 1 }).valid).toBe(true);
    expect(c.validate({}).valid).toBe(false);
    // The shape the old character-iteration bug wrongly accepted.
    expect(c.validate({ i: 1, d: 2 }).valid).toBe(false);
  });

  it("guards dependentRequired the same way, naming the trigger", () => {
    expect(() => compile2020({ type: "object", dependentRequired: { card: "cvv" } })).toThrow(
      /keyword "dependentRequired\.card" requires an array of strings; got string "cvv"/,
    );
  });

  it("accepts a well-formed dependentRequired", () => {
    const c = compile2020({ type: "object", dependentRequired: { card: ["cvv"] } });
    expect(c.validate({ card: "x", cvv: "1" }).valid).toBe(true);
    expect(c.validate({ card: "x" }).valid).toBe(false);
    expect(c.validate({}).valid).toBe(true);
  });
});
