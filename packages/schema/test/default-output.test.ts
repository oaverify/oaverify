import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

const opts = { dialect: jsonSchemaDialect } as const;

// The v3 zero-config contract: `compileSchema(schema, { dialect })` with
// no other options is flat-shaped and fails fast (maxErrors: 1), matching
// ajv's defaults. The richer tree and all-errors collection are opt-in.
describe("v3 default output", () => {
  it("defaults to the flat shape (errors array, no error tree)", () => {
    const v = compileSchema({ type: "string" }, opts);
    const r = v.validate(42);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(Array.isArray(r.errors)).toBe(true);
    expect(r.errors[0]?.code).toBe("type");
    // The tree field must not be present on a flat result.
    expect("error" in r).toBe(false);
  });

  it("a successful flat result carries no error fields", () => {
    const v = compileSchema({ type: "string" }, opts);
    expect(v.validate("ok")).toEqual({ valid: true });
  });

  it("defaults to maxErrors: 1 (fail-fast)", () => {
    const v = compileSchema({ type: "object", required: ["a", "b", "c"] }, opts);
    const r = v.validate({});
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("reports truncated: false when the cap is not reached", () => {
    // maxErrors above the actual error count -> budget never exhausted.
    const v = compileSchema({ type: "object", required: ["a"] }, { ...opts, maxErrors: 10 });
    const r = v.validate({});
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it('output: "tree" returns the nested tree (and also defaults to maxErrors: 1)', () => {
    const v = compileSchema(
      { type: "object", required: ["a", "b", "c"] },
      {
        ...opts,
        output: "tree",
      },
    );
    const r = v.validate({});
    expect(r.valid).toBe(false);
    if (r.valid) return;
    // output and maxErrors are orthogonal: tree still fails fast by default.
    expect(r.error.code).toBe("required");
    expect(r.truncated).toBe(true);
    expect("errors" in r).toBe(false);
  });

  it('output: "tree" with uncapped maxErrors returns every error nested', () => {
    const v = compileSchema(
      { type: "object", required: ["a", "b", "c"] },
      { ...opts, output: "tree", maxErrors: Number.POSITIVE_INFINITY },
    );
    const r = v.validate({});
    if (r.valid) return;
    expect(r.error.code).toBe("schema");
    expect(r.error.children).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('output: "predicate" returns a bare boolean', () => {
    const v = compileSchema({ type: "string" }, { ...opts, output: "predicate" });
    expect(v.validate("ok")).toBe(true);
    expect(v.validate(42)).toBe(false);
  });

  it("explicit maxErrors overrides the default in flat mode", () => {
    const v = compileSchema(
      { type: "object", required: ["a", "b", "c"] },
      { ...opts, maxErrors: Number.POSITIVE_INFINITY },
    );
    const r = v.validate({});
    if (r.valid) return;
    expect(r.errors).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  // A finite maxErrors must never change a valid/invalid verdict. Schemas
  // that track evaluated keys collect every error (the cap is not enforced
  // there) precisely so the short-circuit can't starve an
  // unevaluatedProperties / unevaluatedItems error. See the gated note in
  // the compiler.
  it("maxErrors does not change the verdict for unevaluatedProperties + oneOf", () => {
    const schema = {
      type: "object",
      oneOf: [
        { properties: { foo: { type: "string" } }, required: ["foo"] },
        { properties: { baz: { type: "integer" } }, required: ["baz"] },
      ],
      unevaluatedProperties: false,
    };
    const data = { foo: "ok", bar: 1 }; // bar is unevaluated -> invalid
    expect(compileSchema(schema, { ...opts, maxErrors: 1 }).validate(data).valid).toBe(false);
    expect(
      compileSchema(schema, { ...opts, maxErrors: Number.POSITIVE_INFINITY }).validate(data).valid,
    ).toBe(false);
  });
});
