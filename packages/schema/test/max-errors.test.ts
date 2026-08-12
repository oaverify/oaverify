import { describe, expect, it } from "vitest";
import { collectLeaves } from "@oaverify/internal-core";
import { compileSchema, type CompiledTreeSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";
import { failure } from "./helpers.js";

// Tree output so the assertions can walk `failure(r).error`; `maxErrors`
// uncapped unless a test pins it. (The zero-config default is
// `maxErrors: 1`, covered in default-output.test.ts.)
function compile(schema: unknown, maxErrors?: number): CompiledTreeSchema {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    output: "tree",
    maxErrors: maxErrors ?? Number.POSITIVE_INFINITY,
  });
}

describe("maxErrors option", () => {
  it("collects every error when uncapped", () => {
    const v = compile({ required: ["a", "b", "c", "d"] });
    const r = v.validate({});
    expect(r.valid).toBe(false);
    expect(collectLeaves(failure(r).error)).toHaveLength(4);
    expect(failure(r).truncated).toBe(false);
  });

  it("caps total leaf errors at the configured maxErrors", () => {
    const v = compile({ required: ["a", "b", "c", "d"] }, 2);
    const r = v.validate({});
    expect(r.valid).toBe(false);
    expect(collectLeaves(failure(r).error)).toHaveLength(2);
    expect(failure(r).truncated).toBe(true);
  });

  it("resets the budget between consecutive validate() calls", () => {
    const v = compile({ required: ["a", "b"] }, 1);
    const r1 = v.validate({});
    expect(collectLeaves(failure(r1).error)).toHaveLength(1);
    expect(failure(r1).truncated).toBe(true);
    const r2 = v.validate({});
    expect(collectLeaves(failure(r2).error)).toHaveLength(1);
    expect(failure(r2).truncated).toBe(true);
    // sanity: validity is unaffected
    const r3 = v.validate({ a: 1, b: 2 });
    expect(r3.valid).toBe(true);
  });

  it("maxErrors: 1 is the fast-fail mode", () => {
    const v = compile(
      {
        type: "object",
        required: ["a", "b", "c"],
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          c: { type: "number" },
        },
      },
      1,
    );
    const r = v.validate({ a: "x", b: "y", c: "z" });
    expect(r.valid).toBe(false);
    expect(collectLeaves(failure(r).error)).toHaveLength(1);
    expect(failure(r).truncated).toBe(true);
  });

  it("short-circuits array-item iteration once the budget is exhausted", () => {
    // A large array where EVERY item fails. Without short-circuit we'd
    // walk all 10k items; with maxErrors=3 we should stop early.
    const v = compile({ type: "array", items: { type: "number" } }, 3);
    const badArray: unknown[] = [];
    for (let i = 0; i < 10_000; i += 1) badArray.push("string instead of number");
    const r = v.validate(badArray);
    expect(r.valid).toBe(false);
    // Leaf count proves the short-circuit: a non-gated impl would collect
    // 10_000 leaves, not 3.
    expect(collectLeaves(failure(r).error)).toHaveLength(3);
    expect(failure(r).truncated).toBe(true);
  });

  it("short-circuits property iteration once the budget is exhausted", () => {
    const v = compile({ type: "object", additionalProperties: false }, 2);
    const bad: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i += 1) bad[`extra${i}`] = 1;
    const r = v.validate(bad);
    expect(r.valid).toBe(false);
    expect(collectLeaves(failure(r).error)).toHaveLength(2);
    expect(failure(r).truncated).toBe(true);
  });

  it("reports truncated: false when everything fit in the budget", () => {
    const v = compile({ required: ["a"] }, 10);
    const r = v.validate({});
    expect(collectLeaves(failure(r).error)).toHaveLength(1);
    expect(failure(r).truncated).toBe(false);
  });

  it("valid input never sets truncated even with a tight cap", () => {
    const v = compile({ type: "number" }, 1);
    const r = v.validate(42);
    expect(r.valid).toBe(true);
    // Discriminated union: the `valid: true` branch has no truncated field.
    expect("truncated" in r).toBe(false);
  });

  it("rejects maxErrors: 0 at compile time", () => {
    // A cap of 0 collects no errors and would silently return
    // `valid: true` for invalid data, a correctness trap. Predicate
    // mode is the explicit way to skip error collection entirely.
    expect(() => compile({ type: "number" }, 0)).toThrow(
      /must be a positive integer.*Use `output: "predicate"`/,
    );
  });

  it("rejects negative and non-integer maxErrors", () => {
    expect(() => compile({ type: "number" }, -1)).toThrow(/must be a positive integer/);
    expect(() => compile({ type: "number" }, 1.5)).toThrow(/must be a positive integer/);
  });

  it("rejects NaN and -Infinity, which are not caps at all", () => {
    // Both are non-finite, so a finite-gated guard waves them through
    // and the budget comparisons silently never fire.
    expect(() => compile({ type: "number" }, Number.NaN)).toThrow(/must be a positive integer/);
    expect(() => compile({ type: "number" }, Number.NEGATIVE_INFINITY)).toThrow(
      /must be a positive integer/,
    );
  });
});

describe("flat-mode fast-fail (budget exhaustion returns immediately)", () => {
  // Flat is the mode where `truncated` means "the cap was reached; the
  // list may be incomplete": the validator returns the moment the
  // budget drains instead of walking the remaining keywords. Matches
  // the migration guide ("under the default maxErrors: 1, every
  // rejection reports truncated: true") and ajv's allErrors: false.
  function flatCompile(schema: unknown, options?: Record<string, unknown>) {
    return compileSchema(schema as never, { dialect: jsonSchemaDialect, ...options });
  }

  it("default maxErrors: 1 reports truncated: true on every rejection", () => {
    const v = flatCompile({ type: "integer" });
    const r = v.validate("nope");
    expect(r.valid).toBe(false);
    expect(failure(r).errors).toHaveLength(1);
    expect(failure(r).truncated).toBe(true);
  });

  it("stops evaluating keywords once the budget is exhausted", () => {
    // The custom keyword runs after the built-ins on the same schema
    // object. With the budget already drained by the `const` failure,
    // fast-fail must return before ever invoking it.
    let calls = 0;
    const v = flatCompile(
      { const: "expected", tracer: true },
      {
        keywords: {
          tracer: () => {
            calls += 1;
            return true;
          },
        },
      },
    );
    const r = v.validate("something-else");
    expect(r.valid).toBe(false);
    expect(failure(r).errors.map((e) => e.code)).toEqual(["const"]);
    expect(failure(r).truncated).toBe(true);
    expect(calls).toBe(0);

    // Valid data still reaches the custom keyword.
    expect(v.validate("expected").valid).toBe(true);
    expect(calls).toBe(1);
  });

  it("stops descending into later subschemas once the budget is exhausted", () => {
    let calls = 0;
    const v = flatCompile(
      {
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { tracer: true },
        },
      },
      {
        keywords: {
          tracer: () => {
            calls += 1;
            return true;
          },
        },
      },
    );
    const r = v.validate({ a: "bad", b: 1 });
    expect(r.valid).toBe(false);
    expect(failure(r).errors.map((e) => e.code)).toEqual(["type"]);
    expect(failure(r).truncated).toBe(true);
    expect(calls).toBe(0);
  });

  it("a cap larger than the error count completes with truncated: false", () => {
    const v = flatCompile({ required: ["a", "b"] }, { maxErrors: 5 });
    const r = v.validate({});
    expect(r.valid).toBe(false);
    expect(failure(r).errors).toHaveLength(2);
    expect(failure(r).truncated).toBe(false);
  });

  it("landing exactly on the cap reports truncated: true", () => {
    const v = flatCompile({ required: ["a", "b"] }, { maxErrors: 2 });
    const r = v.validate({});
    expect(r.valid).toBe(false);
    expect(failure(r).errors).toHaveLength(2);
    expect(failure(r).truncated).toBe(true);
  });
});
