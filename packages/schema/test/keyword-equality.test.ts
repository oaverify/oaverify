import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("enum keyword", () => {
  it("accepts any deep-equal value from the allowed set", () => {
    const v = compile({ enum: [1, "x", { a: 1 }, [1, 2]] });
    expect(v.validate(1).valid).toBe(true);
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate({ a: 1 }).valid).toBe(true);
    expect(v.validate([1, 2]).valid).toBe(true);
  });

  it("rejects values not in the set with code 'enum'", () => {
    const v = compile({ enum: [1, 2, 3] });
    const r = v.validate(4);
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("enum");
    expect(failure(r).error.params).toMatchObject({ allowed: [1, 2, 3], actual: 4 });
  });

  it("accepts object equality regardless of key order", () => {
    const v = compile({ enum: [{ a: 1, b: 2 }] });
    expect(v.validate({ b: 2, a: 1 }).valid).toBe(true);
  });
});

describe("const keyword", () => {
  it("accepts only the exact constant", () => {
    const v = compile({ const: "Cat" });
    expect(v.validate("Cat").valid).toBe(true);
    expect(v.validate("Dog").valid).toBe(false);
  });

  it("uses deep equality for objects and arrays", () => {
    const v = compile({ const: { kind: "Cat", purrs: true } });
    expect(v.validate({ purrs: true, kind: "Cat" }).valid).toBe(true);
  });

  it("emits code 'const' with expected/actual params", () => {
    const v = compile({ const: 42 });
    const r = v.validate(7);
    expect(failure(r).error.code).toBe("const");
    expect(failure(r).error.params).toEqual({ expected: 42, actual: 7 });
  });
});
