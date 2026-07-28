import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("type keyword", () => {
  const cases: Array<{ schema: unknown; good: unknown[]; bad: unknown[] }> = [
    { schema: { type: "string" }, good: ["", "x"], bad: [0, null, [], {}, true] },
    { schema: { type: "number" }, good: [0, 1.5, -2], bad: ["x", null, [], {}, true] },
    { schema: { type: "integer" }, good: [0, 1, -2], bad: [1.5, "x", null, [], {}] },
    { schema: { type: "boolean" }, good: [true, false], bad: [0, 1, "true", null] },
    { schema: { type: "null" }, good: [null], bad: [0, "", false, [], {}] },
    { schema: { type: "array" }, good: [[], [1, 2]], bad: [{}, "x", 1, null] },
    { schema: { type: "object" }, good: [{}, { a: 1 }], bad: [[], "x", 1, null] },
  ];

  for (const c of cases) {
    it(`accepts valid ${JSON.stringify(c.schema)}`, () => {
      const v = compile(c.schema as never);
      for (const value of c.good) expect(v.validate(value).valid, JSON.stringify(value)).toBe(true);
    });

    it(`rejects invalid ${JSON.stringify(c.schema)} with code "type"`, () => {
      const v = compile(c.schema as never);
      for (const value of c.bad) {
        const r = v.validate(value);
        expect(r.valid, JSON.stringify(value)).toBe(false);
        expect(failure(r).error.code).toBe("type");
      }
    });
  }

  it("supports an array of allowed types", () => {
    const v = compile({ type: ["string", "null"] });
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate(null).valid).toBe(true);
    expect(v.validate(1).valid).toBe(false);
  });

  it("carries expected and actual in params", () => {
    const v = compile({ type: "number" });
    const r = v.validate("x");
    expect(failure(r).error.params).toMatchObject({ expected: ["number"], actual: "string" });
  });

  it("path is empty at the root", () => {
    const v = compile({ type: "number" });
    expect(failure(v.validate("x")).error.path).toEqual([]);
  });
});
