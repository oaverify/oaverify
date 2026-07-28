import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import type { Dialect, Vocabulary } from "../src/keywords/types.js";
import { failure } from "./helpers.js";

const emptyVocab: Vocabulary = { uri: "test://empty", keywords: [] };
const emptyDialect: Dialect = {
  id: "test-empty",
  vocabularies: [emptyVocab],
  rules: { refSuppressesSiblings: false },
};

describe("compileSchema", () => {
  it("accepts everything when the schema is `true`", () => {
    const v = compileSchema(true, { dialect: emptyDialect });
    expect(v.validate(1)).toEqual({ valid: true });
    expect(v.validate("x")).toEqual({ valid: true });
    expect(v.validate(null)).toEqual({ valid: true });
    expect(v.validate({})).toEqual({ valid: true });
  });

  it("rejects everything when the schema is `false`", () => {
    const v = compileSchema(false, { dialect: emptyDialect, output: "tree" });
    const result = v.validate(1);
    expect(result.valid).toBe(false);
    expect(failure(result).error.code).toBe("false");
    expect(failure(result).error.children).toEqual([]);
    expect(v.validate("x").valid).toBe(false);
  });

  it("accepts everything when the schema is the empty object", () => {
    const v = compileSchema({}, { dialect: emptyDialect });
    expect(v.validate(1)).toEqual({ valid: true });
    expect(v.validate(null)).toEqual({ valid: true });
  });

  it("generates syntactically valid JavaScript", () => {
    const v = compileSchema({}, { dialect: emptyDialect });
    expect(() => new Function(v.source)).not.toThrow();
  });

  it("emits exactly one named helper function for a trivial schema", () => {
    const v = compileSchema({}, { dialect: emptyDialect });
    expect(v.stats.functionCount).toBe(1);
  });

  it("builds a path array at the root", () => {
    const result = compileSchema(false, { dialect: emptyDialect, output: "tree" }).validate(1);
    expect(result.valid).toBe(false);
    expect(failure(result).error.path).toEqual([]);
  });

  it("prepends startPath to every error path", () => {
    const v = compileSchema(false, { dialect: emptyDialect, output: "tree" });
    const result = v.validate(1, ["body"]);
    expect(result.valid).toBe(false);
    expect(failure(result).error.path).toEqual(["body"]);
  });

  it("does not mutate the caller's startPath", () => {
    const v = compileSchema(false, { dialect: emptyDialect, output: "tree" });
    const prefix: (string | number)[] = ["body"];
    v.validate(1, prefix);
    expect(prefix).toEqual(["body"]);
  });
});
