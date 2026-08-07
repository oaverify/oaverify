import type { ParameterObject } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import {
  assembleDeepObject,
  assembleFormExplodedObject,
  assembleObjectQueryParam,
  coerceQueryScalar,
} from "../src/query-assembly.js";

describe("coerceQueryScalar", () => {
  it("returns undefined for missing values", () => {
    expect(coerceQueryScalar(undefined, { type: "integer" })).toBeUndefined();
  });

  it("passes strings through for string schemas", () => {
    expect(coerceQueryScalar("abc", { type: "string" })).toBe("abc");
  });

  it("parses integers and numbers", () => {
    expect(coerceQueryScalar("42", { type: "integer" })).toBe(42);
    expect(coerceQueryScalar("3.14", { type: "number" })).toBeCloseTo(3.14);
  });

  it("preserves non-numeric strings on numeric schemas so downstream validation can flag them", () => {
    expect(coerceQueryScalar("not a number", { type: "integer" })).toBe("not a number");
  });

  it("parses booleans", () => {
    expect(coerceQueryScalar("true", { type: "boolean" })).toBe(true);
    expect(coerceQueryScalar("false", { type: "boolean" })).toBe(false);
    expect(coerceQueryScalar("maybe", { type: "boolean" })).toBe("maybe");
  });

  it("passes through unrecognised types and boolean schemas", () => {
    expect(coerceQueryScalar("x", true)).toBe("x");
    expect(coerceQueryScalar("x", { type: "object" })).toBe("x");
  });
});

describe("assembleDeepObject", () => {
  it("picks up `name[key]=value` pairs", () => {
    expect(assembleDeepObject("filter", { "filter[id]": "1", "filter[tag]": "x" })).toEqual({
      id: "1",
      tag: "x",
    });
  });

  it("returns undefined when no matching keys are present", () => {
    expect(assembleDeepObject("filter", { other: "x" })).toBeUndefined();
    expect(assembleDeepObject("filter", {})).toBeUndefined();
    expect(assembleDeepObject("filter", undefined)).toBeUndefined();
  });

  it("uses the first element when a value is array-typed", () => {
    expect(assembleDeepObject("f", { "f[x]": ["a", "b"] })).toEqual({ x: "a" });
  });

  it("ignores keys whose bracket syntax is malformed", () => {
    expect(assembleDeepObject("f", { "f[missing": "x", "fmissing]": "y" })).toBeUndefined();
  });

  it("coerces values with the matching property schema", () => {
    // #707: parity with assembleFormExplodedObject, which already did this.
    const schema = {
      type: "object",
      properties: { id: { type: "integer" }, active: { type: "boolean" }, tag: { type: "string" } },
    } as const;
    expect(
      assembleDeepObject(
        "filter",
        { "filter[id]": "1", "filter[active]": "true", "filter[tag]": "x" },
        schema,
      ),
    ).toEqual({ id: 1, active: true, tag: "x" });
  });

  it("leaves undeclared properties as strings", () => {
    const schema = { type: "object", properties: { id: { type: "integer" } } } as const;
    expect(assembleDeepObject("f", { "f[id]": "1", "f[other]": "2" }, schema)).toEqual({
      id: 1,
      other: "2",
    });
    // No schema at all: unchanged from the pre-#707 behavior.
    expect(assembleDeepObject("f", { "f[id]": "1" })).toEqual({ id: "1" });
  });
});

describe("assembleFormExplodedObject", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
  } as const;

  it("collects declared properties by top-level key + coerces via the property schema", () => {
    expect(assembleFormExplodedObject(schema, { id: "1", name: "dot", extra: "ignored" })).toEqual({
      id: 1,
      name: "dot",
    });
  });

  it("returns undefined when no declared properties appear", () => {
    expect(assembleFormExplodedObject(schema, { other: "x" })).toBeUndefined();
    expect(assembleFormExplodedObject(schema, undefined)).toBeUndefined();
  });

  it("returns undefined for non-object schemas (caller falls through)", () => {
    expect(assembleFormExplodedObject({ type: "string" }, { a: "b" })).toBeUndefined();
    expect(assembleFormExplodedObject(true, { a: "b" })).toBeUndefined();
    expect(assembleFormExplodedObject(undefined, { a: "b" })).toBeUndefined();
  });
});

describe("assembleObjectQueryParam", () => {
  it("returns undefined for non-query params (caller falls through to standard path)", () => {
    const p: ParameterObject = {
      name: "id",
      in: "path",
      schema: { type: "object", properties: { x: { type: "string" } } },
    };
    expect(assembleObjectQueryParam(p, { "id[x]": "a" })).toBeUndefined();
  });

  it("returns undefined for non-object schemas (caller falls through)", () => {
    const p: ParameterObject = { name: "q", in: "query", schema: { type: "string" } };
    expect(assembleObjectQueryParam(p, { q: "a" })).toBeUndefined();
  });

  it("dispatches style:deepObject", () => {
    const p: ParameterObject = {
      name: "filter",
      in: "query",
      style: "deepObject",
      schema: { type: "object", properties: { id: { type: "integer" } } },
    };
    // #707: `id` is coerced by its property schema; `name` is undeclared
    // and stays a string.
    expect(assembleObjectQueryParam(p, { "filter[id]": "1", "filter[name]": "dot" })).toEqual({
      value: { id: 1, name: "dot" },
    });
  });

  it("dispatches the default form+explode for object-typed query params", () => {
    const p: ParameterObject = {
      name: "filter",
      in: "query",
      schema: { type: "object", properties: { id: { type: "integer" } } },
    };
    expect(assembleObjectQueryParam(p, { id: "1" })).toEqual({ value: { id: 1 } });
  });

  it("reports {value: undefined} when object-typed but no pieces are present", () => {
    const p: ParameterObject = {
      name: "filter",
      in: "query",
      style: "deepObject",
      schema: { type: "object", properties: { id: { type: "integer" } } },
    };
    expect(assembleObjectQueryParam(p, {})).toEqual({ value: undefined });
  });
});
