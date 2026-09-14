import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { oas30Dialect } from "../src/keywords/vocabulary.js";

describe("OAS 3.0 patternProperties leniency", () => {
  it("honors patternProperties while reporting unevaluatedProperties as unknown", () => {
    const schema = {
      properties: { a: {} },
      patternProperties: { "^x-": {} },
      additionalProperties: false,
      unevaluatedProperties: false,
    };
    const compiled = compileSchema(schema, { dialect: oas30Dialect, schemaLint: "strict" });

    expect(compiled.validate({ a: 1, "x-value": 2 }).valid).toBe(true);
    expect(compiled.validate({ a: 1, other: 2 }).valid).toBe(false);
    expect(compiled.stats.schemaLintIssues.map((issue) => issue.code)).toEqual(["unknown-keyword"]);
    expect(compiled.stats.schemaLintIssues[0]?.keyword).toBe("unevaluatedProperties");
  });
});
