import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("array validation keywords", () => {
  it("maxItems / minItems enforce bounds", () => {
    const v = compile({ maxItems: 2, minItems: 1 });
    expect(v.validate([1]).valid).toBe(true);
    expect(v.validate([1, 2]).valid).toBe(true);
    expect(v.validate([1, 2, 3]).valid).toBe(false);
    expect(failure(v.validate([1, 2, 3])).error?.code).toBe("maxItems");
    expect(v.validate([]).valid).toBe(false);
    expect(failure(v.validate([])).error?.code).toBe("minItems");
  });

  it("uniqueItems rejects duplicates by deep equality", () => {
    const v = compile({ uniqueItems: true });
    expect(v.validate([1, 2, 3]).valid).toBe(true);
    expect(v.validate([{ a: 1 }, { a: 1 }]).valid).toBe(false);
    const r = v.validate([1, 2, 1]);
    expect(r.valid).toBe(false);
    expect(failure(r).error?.code).toBe("uniqueItems");
    expect(failure(r).error?.params).toMatchObject({ duplicates: [0, 2] });
  });

  it("uniqueItems: false is a no-op", () => {
    const v = compile({ uniqueItems: false });
    expect(v.validate([1, 1, 1]).valid).toBe(true);
  });

  it("uniqueItems spots mixed-type collisions via the primitive fast path", () => {
    // Regression for #142: the Map-backed lookup must treat each
    // primitive identity (number, string, boolean, null) correctly.
    const v = compile({ uniqueItems: true });
    expect(v.validate([1, "1"]).valid).toBe(true); // different types, not equal
    expect(v.validate([null, null]).valid).toBe(false);
    expect(failure(v.validate([true, false, true])).error?.params).toMatchObject({
      duplicates: [0, 2],
    });
  });

  it("uniqueItems mixes primitives and objects without false matches", () => {
    const v = compile({ uniqueItems: true });
    // Primitives go through the Map; objects fall back to deepEqual.
    // This shape stresses both paths in one call.
    expect(v.validate([1, { a: 1 }, 2, { a: 2 }, "x"]).valid).toBe(true);
    expect(failure(v.validate([1, { a: 1 }, 2, { a: 1 }])).error?.params).toMatchObject({
      duplicates: [1, 3],
    });
  });

  it("leaves non-arrays alone", () => {
    const v = compile({ maxItems: 1, minItems: 1, uniqueItems: true });
    expect(v.validate({ length: 5 }).valid).toBe(true);
  });
});
