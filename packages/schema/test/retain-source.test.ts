import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

// A schema with enough shape that the generated source is unmistakably
// non-empty when it is kept.
const schema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["id"],
} as const;

describe("retainSource", () => {
  it("drops the generated source by default", () => {
    const v = compileSchema(schema as never, { dialect: jsonSchemaDialect });
    expect(v.source).toBe("");
  });

  it("keeps the generated source when asked", () => {
    const v = compileSchema(schema as never, {
      dialect: jsonSchemaDialect,
      retainSource: true,
    });
    expect(v.source.length).toBeGreaterThan(0);
    expect(() => new Function(v.source)).not.toThrow();
  });

  it("validates identically either way", () => {
    const kept = compileSchema(schema as never, {
      dialect: jsonSchemaDialect,
      retainSource: true,
    });
    const dropped = compileSchema(schema as never, { dialect: jsonSchemaDialect });

    expect(dropped.stats).toEqual(kept.stats);

    for (const data of [
      { id: "a", tags: ["x"] },
      { id: "", tags: ["x"] },
      { tags: ["x"] },
      { id: "a", tags: [1] },
      42,
    ]) {
      expect(dropped.validate(data)).toEqual(kept.validate(data));
    }
  });

  it("applies to every output mode", () => {
    for (const output of ["flat", "tree", "predicate"] as const) {
      const dropped = compileSchema(schema as never, { dialect: jsonSchemaDialect, output });
      const kept = compileSchema(schema as never, {
        dialect: jsonSchemaDialect,
        output,
        retainSource: true,
      });
      expect(dropped.source).toBe("");
      expect(kept.source.length).toBeGreaterThan(0);
      expect(dropped.validate({ id: "a" })).toEqual(kept.validate({ id: "a" }));
    }
  });
});
