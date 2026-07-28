import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("items keyword", () => {
  it("validates every element", () => {
    const v = compile({ items: { type: "number" } });
    expect(v.validate([1, 2, 3]).valid).toBe(true);
    const r = v.validate([1, "two", 3]);
    expect(r.valid).toBe(false);
    expect(failure(r).error?.path).toEqual([1]);
  });

  it("applies only after prefixItems when both are present", () => {
    const v = compile({
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "boolean" },
    });
    expect(v.validate(["x", 1, true, false]).valid).toBe(true);
    expect(v.validate(["x", 1, "not bool"]).valid).toBe(false);
  });

  it("items: false rejects any element past prefixItems", () => {
    const v = compile({ prefixItems: [{ type: "string" }], items: false });
    expect(v.validate(["x"]).valid).toBe(true);
    expect(v.validate(["x", 1]).valid).toBe(false);
  });
});

describe("prefixItems keyword", () => {
  it("validates each position against its own schema", () => {
    const v = compile({ prefixItems: [{ type: "string" }, { type: "number" }] });
    expect(v.validate(["x", 1, true]).valid).toBe(true);
    expect(v.validate([1, 1]).valid).toBe(false);
  });
});

describe("contains keyword", () => {
  it("requires at least one matching element by default", () => {
    const v = compile({ contains: { type: "number" } });
    expect(v.validate([1, "x"]).valid).toBe(true);
    expect(v.validate(["a", "b"]).valid).toBe(false);
    expect(failure(v.validate(["a", "b"])).error?.code).toBe("contains");
  });

  it("respects minContains / maxContains", () => {
    const v = compile({ contains: { type: "number" }, minContains: 2, maxContains: 3 });
    expect(v.validate([1, 2]).valid).toBe(true);
    expect(v.validate([1]).valid).toBe(false);
    expect(v.validate([1, 2, 3, 4]).valid).toBe(false);
    expect(failure(v.validate([1, 2, 3, 4])).error?.code).toBe("maxContains");
  });

  it("minContains: 0 makes contains optional", () => {
    const v = compile({ contains: { type: "number" }, minContains: 0 });
    expect(v.validate([]).valid).toBe(true);
  });
});
