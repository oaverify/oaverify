import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("properties keyword", () => {
  it("validates each named property", () => {
    const v = compile({
      properties: { name: { type: "string" }, age: { type: "number" } },
    });
    expect(v.validate({ name: "Ada", age: 30 }).valid).toBe(true);
    const r = v.validate({ name: 1, age: "x" });
    expect(r.valid).toBe(false);
    const codes = (failure(r).error.children ?? [failure(r).error]).map((c) => c.code);
    expect(codes.sort()).toEqual(["type", "type"]);
  });

  it("skips missing properties (required is a separate keyword)", () => {
    const v = compile({ properties: { a: { type: "string" } } });
    expect(v.validate({}).valid).toBe(true);
  });

  it("children include path pointing at the offending property", () => {
    const v = compile({ properties: { email: { type: "string" } } });
    const r = v.validate({ email: 42 });
    expect(failure(r).error.path).toEqual(["email"]);
  });

  it("property names and pattern sources with JS-hostile chars don't break codegen", () => {
    // Property names and regex patterns end up embedded in generated
    // JavaScript; quoteString + escapeMessage must escape every code
    // point that could terminate a literal or inject new source.
    const evilName = 'bad"name\nwith`backticks`${1+1}';
    const evilPattern = "^hi\\${injected}$";
    const v = compile({
      type: "object",
      required: [evilName],
      properties: { [evilName]: { type: "string", pattern: evilPattern } },
    });
    // Valid: property present, matches pattern verbatim.
    expect(v.validate({ [evilName]: "hi${injected}" }).valid).toBe(true);
    // Missing property → required error with the hostile name intact.
    const missing = v.validate({});
    expect(failure(missing).error.code).toBe("required");
    expect(failure(missing).error.params?.missing).toBe(evilName);
    // Present but failing the pattern → pattern error, no source injection.
    const bad = v.validate({ [evilName]: "nope" });
    expect(failure(bad).error.code).toBe("pattern");
  });
});

describe("patternProperties keyword", () => {
  it("validates properties whose name matches the pattern", () => {
    const v = compile({ patternProperties: { "^foo": { type: "number" } } });
    expect(v.validate({ foo1: 1, foo2: 2, bar: "x" }).valid).toBe(true);
    const r = v.validate({ foo1: "not a number" });
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("type");
  });
});

describe("additionalProperties keyword", () => {
  it("rejects extra properties when set to `false`", () => {
    const v = compile({
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect(v.validate({ a: "x" }).valid).toBe(true);
    const r = v.validate({ a: "x", b: 1 });
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("additionalProperties");
    expect(failure(r).error.path).toEqual(["b"]);
  });

  it("validates extras against the given schema", () => {
    const v = compile({
      properties: { a: { type: "string" } },
      additionalProperties: { type: "number" },
    });
    expect(v.validate({ a: "x", b: 1, c: 2 }).valid).toBe(true);
    expect(v.validate({ a: "x", b: "not num" }).valid).toBe(false);
  });

  it("honors patternProperties as a coverage source", () => {
    const v = compile({
      patternProperties: { "^x-": true },
      additionalProperties: false,
    });
    expect(v.validate({ "x-foo": 1, "x-bar": 2 }).valid).toBe(true);
    expect(v.validate({ "x-foo": 1, bad: 1 }).valid).toBe(false);
  });
});

describe("propertyNames keyword", () => {
  it("validates each key as a string", () => {
    const v = compile({ propertyNames: { pattern: "^[a-z]+$" } });
    expect(v.validate({ foo: 1 }).valid).toBe(true);
    expect(v.validate({ Foo: 1 }).valid).toBe(false);
  });
});
