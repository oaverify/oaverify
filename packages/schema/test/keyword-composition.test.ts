/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("allOf keyword", () => {
  it("passes when every branch validates", () => {
    const v = compile({ allOf: [{ type: "number" }, { minimum: 0 }, { maximum: 10 }] });
    expect(v.validate(5).valid).toBe(true);
    expect(v.validate(-1).valid).toBe(false);
  });

  it("error children are the failing conjuncts only", () => {
    const v = compile({
      allOf: [{ type: "number" }, { minimum: 0 }, { maximum: 10 }],
    });
    const r = v.validate(-1);
    expect(failure(r).error.code).toBe("allOf");
    expect(failure(r).error.children).toHaveLength(1);
    expect(failure(r).error.children[0]?.code).toBe("minimum");
  });

  it("single failing conjunct still wraps in an allOf branch (consistent tree)", () => {
    const v = compile({ allOf: [{ minimum: 0 }] });
    const r = v.validate(-1);
    expect(failure(r).error.code).toBe("allOf");
    expect(failure(r).error.children).toHaveLength(1);
    expect(failure(r).error.children[0]?.code).toBe("minimum");
  });
});

describe("anyOf keyword", () => {
  it("passes as long as one branch matches", () => {
    const v = compile({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate(1).valid).toBe(true);
  });

  it("error has children for every branch when none match", () => {
    const v = compile({ anyOf: [{ type: "string" }, { type: "number" }] });
    const r = v.validate(true);
    expect(failure(r).error.code).toBe("anyOf");
    expect(failure(r).error.children).toHaveLength(2);
    expect(failure(r).error.children.map((c) => c.code)).toEqual(["type", "type"]);
  });
});

describe("oneOf keyword", () => {
  it("passes when exactly one branch matches", () => {
    const v = compile({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate(1).valid).toBe(true);
  });

  it("children include every branch's result when 0 match", () => {
    const v = compile({ oneOf: [{ type: "string" }, { type: "number" }] });
    const r = v.validate(true);
    expect(failure(r).error.code).toBe("oneOf");
    expect(failure(r).error.children).toHaveLength(2);
    expect(failure(r).error.params).toMatchObject({ matchCount: 0 });
  });

  it("errors when multiple branches match", () => {
    const v = compile({ oneOf: [{ type: "number" }, { minimum: 0 }] });
    const r = v.validate(5);
    expect(failure(r).error.code).toBe("oneOf");
    expect(failure(r).error.params).toMatchObject({ matchCount: 2 });
  });
});

describe("not keyword", () => {
  it("is a leaf (no children) when the inner schema matches", () => {
    const v = compile({ not: { type: "string" } });
    expect(v.validate(1).valid).toBe(true);
    const r = v.validate("x");
    expect(failure(r).error.code).toBe("not");
    expect(failure(r).error.children).toEqual([]);
  });
});

describe("if/then/else keyword", () => {
  it("validates `then` when `if` matches", () => {
    const schema = {
      if: { type: "string" },
      then: { minLength: 3 },
      else: { type: "number" },
    } as const;
    const v = compile(schema);
    expect(v.validate("abc").valid).toBe(true);
    expect(v.validate("ab").valid).toBe(false);
    expect(v.validate(1).valid).toBe(true);
    expect(v.validate(true).valid).toBe(false);
  });

  it("omitting then/else is a no-op on that branch", () => {
    const schema = { if: { type: "string" }, then: { minLength: 3 } } as const;
    const v = compile(schema);
    expect(v.validate(1).valid).toBe(true); // else branch omitted
    expect(v.validate("ab").valid).toBe(false);
  });

  it("an `if` whose property is missing is vacuously true (applies `then`)", () => {
    // ajv #2439 / #2299. A `properties` subschema is vacuously satisfied
    // when the named key isn't present in the data, so the `if` passes
    // and `then` fires, distinct from the case where the key IS present
    // but fails the constraint.
    const schema = {
      type: "object",
      if: { properties: { kind: { const: "Pet" } } },
      then: { required: ["name"] },
    } as const;
    const v = compile(schema);
    // Property missing → if passes → then fires → requires `name`.
    expect(v.validate({}).valid).toBe(false);
    expect(failure(v.validate({})).error.code).toBe("required");
    // Property present with matching const → if passes → then fires.
    expect(v.validate({ kind: "Pet" }).valid).toBe(false);
    expect(v.validate({ kind: "Pet", name: "Fido" }).valid).toBe(true);
    // Property present but failing the const → if fails → then skipped.
    expect(v.validate({ kind: "Other" }).valid).toBe(true);
  });
});

describe("dependent keywords", () => {
  it("dependentRequired enforces companion presence", () => {
    const v = compile({ dependentRequired: { creditCard: ["billingAddress"] } });
    expect(v.validate({ creditCard: "x", billingAddress: "y" }).valid).toBe(true);
    expect(v.validate({ creditCard: "x" }).valid).toBe(false);
    expect(v.validate({}).valid).toBe(true);
  });

  it("dependentSchemas validates when the trigger key is present", () => {
    const v = compile({
      dependentSchemas: {
        creditCard: { required: ["billingAddress"] },
      },
    });
    expect(v.validate({ creditCard: "x", billingAddress: "y" }).valid).toBe(true);
    expect(v.validate({ creditCard: "x" }).valid).toBe(false);
    expect(v.validate({ billingAddress: "y" }).valid).toBe(true);
  });

  it("dependencies (draft-07 compat) supports both array and schema forms", () => {
    // Array form behaves like dependentRequired.
    const arrayForm = compile({ dependencies: { creditCard: ["billingAddress"] } });
    expect(arrayForm.validate({ creditCard: "x", billingAddress: "y" }).valid).toBe(true);
    expect(arrayForm.validate({ creditCard: "x" }).valid).toBe(false);
    expect(arrayForm.validate({}).valid).toBe(true);
    // Schema form behaves like dependentSchemas.
    const schemaForm = compile({
      dependencies: { creditCard: { required: ["billingAddress"] } },
    });
    expect(schemaForm.validate({ creditCard: "x", billingAddress: "y" }).valid).toBe(true);
    expect(schemaForm.validate({ creditCard: "x" }).valid).toBe(false);
    // Non-objects are ignored (per spec) regardless of form.
    expect(arrayForm.validate("string").valid).toBe(true);
    expect(schemaForm.validate([1, 2]).valid).toBe(true);
  });
});

describe("nested composition error tree", () => {
  it("allOf containing oneOf produces a two-level tree", () => {
    const v = compile({
      allOf: [{ type: "object" }, { oneOf: [{ type: "string" }, { type: "number" }] }],
    });
    const r = v.validate(true);
    expect(failure(r).error.code).toBe("allOf");
    const inner = failure(r).error.children ?? [];
    expect(inner.length).toBeGreaterThanOrEqual(1);
    const oneOfChild = inner.find((c) => c.code === "oneOf");
    expect(oneOfChild).toBeDefined();
    expect(oneOfChild?.children.length).toBeGreaterThan(0);
  });
});
