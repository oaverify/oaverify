import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("object validation keywords", () => {
  it("maxProperties / minProperties enforce counts", () => {
    const v = compile({ maxProperties: 2, minProperties: 1 });
    expect(v.validate({ a: 1 }).valid).toBe(true);
    expect(v.validate({ a: 1, b: 2 }).valid).toBe(true);
    expect(v.validate({ a: 1, b: 2, c: 3 }).valid).toBe(false);
    expect(v.validate({}).valid).toBe(false);
  });

  it("required lists EVERY missing property (not just the first)", () => {
    const v = compile({ required: ["a", "b", "c"] });
    const r = v.validate({ a: 1 });
    expect(r.valid).toBe(false);
    expect(failure(r).error?.children).toHaveLength(2);
    const codes = (failure(r).error?.children ?? []).map((c) => c.code);
    expect(codes).toEqual(["required", "required"]);
    const missing = (failure(r).error?.children ?? []).map((c) => c.params["missing"]);
    expect(missing).toEqual(["b", "c"]);
  });

  it("required emits path pointing at the missing key", () => {
    const v = compile({ required: ["email"] });
    const r = v.validate({});
    expect(failure(r).error?.path).toEqual(["email"]);
  });

  it("required passes when every key is present", () => {
    const v = compile({ required: ["a", "b"] });
    expect(v.validate({ a: 1, b: 2 }).valid).toBe(true);
  });

  it("leaves non-objects alone", () => {
    const v = compile({ required: ["a"], maxProperties: 1 });
    expect(v.validate("not an object").valid).toBe(true);
  });
});
