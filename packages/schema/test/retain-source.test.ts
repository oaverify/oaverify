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
  it("keeps the generated source by default", () => {
    const v = compileSchema(schema as never, { dialect: jsonSchemaDialect });
    expect(v.source.length).toBeGreaterThan(0);
  });

  it("drops the generated source when asked, leaving the validator unchanged", () => {
    const kept = compileSchema(schema as never, { dialect: jsonSchemaDialect });
    const dropped = compileSchema(schema as never, {
      dialect: jsonSchemaDialect,
      retainSource: false,
    });

    expect(dropped.source).toBe("");
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

  it("drops the source in every output mode", () => {
    for (const output of ["flat", "tree", "predicate"] as const) {
      const v = compileSchema(schema as never, {
        dialect: jsonSchemaDialect,
        output,
        retainSource: false,
      });
      expect(v.source).toBe("");
      expect(v.validate({ id: "a" })).toEqual(output === "predicate" ? true : { valid: true });
    }
  });
});
