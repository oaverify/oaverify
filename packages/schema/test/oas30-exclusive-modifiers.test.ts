/**
 * In OAS 3.0 `exclusiveMaximum` / `exclusiveMinimum` are boolean modifiers
 * of a sibling bound, and the 3.0 keywords enforce no numeric bound. Any
 * other value is a malformed schema under every lint level.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

const compileOas30 = (schema: unknown, schemaLint?: "off" | "strict") =>
  compileSchema(schema as SchemaOrBoolean, {
    dialect: oas30Dialect,
    ...(schemaLint === undefined ? {} : { schemaLint }),
  });

describe.each([
  ["exclusiveMaximum", "maximum"],
  ["exclusiveMinimum", "minimum"],
])("OAS 3.0 %s", (modifier, bound) => {
  it.each([[5], [0], ["true"], [null], [[true]], [{}]])("rejects the value %j", (value) => {
    const message = new RegExp(`keyword "${modifier}" requires a boolean`);
    expect(() => compileOas30({ type: "number", [modifier]: value })).toThrow(message);
    expect(() => compileOas30({ type: "number", [bound]: 5, [modifier]: value })).toThrow(message);
  });

  it("rejects under every lint level", () => {
    for (const lint of ["off", "strict"] as const) {
      expect(() => compileOas30({ [modifier]: 5 }, lint), lint).toThrow(/requires a boolean/);
    }
  });

  it("names the numeric spelling's replacement", () => {
    expect(() => compileOas30({ [modifier]: 5 })).toThrow(
      new RegExp(`it modifies "${bound}": write "${bound}" with "${modifier}: true"`),
    );
  });

  it("does not advise promoting the value, which could loosen the author's bound", () => {
    let message = "";
    try {
      compileOas30({ [bound]: 3, [modifier]: 5 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("requires a boolean");
    expect(message).not.toContain(`"${bound}: 5"`);
  });

  it("rejects in a subschema nothing references", () => {
    expect(() => compileOas30({ $defs: { Unused: { [modifier]: 5 } } })).toThrow(
      new RegExp(`\\$defs\\.Unused\\.${modifier}`),
    );
  });

  it("rejects in a schema supplied through external", () => {
    expect(() =>
      compileSchema({ $ref: "base" } as SchemaOrBoolean, {
        dialect: oas30Dialect,
        external: new Map([["base", { [modifier]: 5 } as SchemaOrBoolean]]),
      }),
    ).toThrow(/requires a boolean/);
  });

  it("rejects behind a reference", () => {
    expect(() =>
      compileOas30({
        properties: { a: { $ref: "#/$defs/Target" } },
        $defs: { Target: { [modifier]: 5 } },
      }),
    ).toThrow(/requires a boolean/);
  });

  it("does not judge a sibling a $ref discards", () => {
    const compiled = compileOas30({
      properties: { a: { $ref: "#/$defs/Target", [modifier]: 5 } },
      $defs: { Target: { type: "number" } },
    });
    expect(compiled.validate({ a: 10 }).valid).toBe(true);
  });

  it.each([[true], [false]])("accepts %j with and without a sibling bound", (value) => {
    expect(() => compileOas30({ [modifier]: value })).not.toThrow();
    expect(() => compileOas30({ [bound]: 5, [modifier]: value })).not.toThrow();
  });

  it("keeps the numeric bound in later dialects", () => {
    for (const dialect of [jsonSchemaDialect, openapi31Dialect]) {
      const compiled = compileSchema({ [modifier]: 5 } as SchemaOrBoolean, { dialect });
      expect(compiled.validate(5).valid).toBe(false);
    }
  });
});

describe("OAS 3.0 nullable", () => {
  // Pinned so widening the guard to `nullable` is a decision of its own.
  it("still accepts a non-boolean value", () => {
    expect(() => compileOas30({ type: "string", nullable: "yes" })).not.toThrow();
  });
});
