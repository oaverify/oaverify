/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { ValidationError } from "@oaverify/internal-core";
import { compile, failure } from "./helpers.js";

/**
 * An annotation from a schema that failed is discarded (2020-12 section
 * 7.7.1), and the discard has to hold at every edge the annotation can
 * cross, not only at the branch-local sets an in-place applicator
 * allocates.
 *
 * Each case below is one such edge: a caller that hands its own
 * evaluated-key set to the callee, so the callee's keys are already in the
 * caller's set by the time it fails, or a `oneOf` that matched more than
 * once and so failed while its individual branches passed.
 *
 * Each case below reads the discard through an enclosing
 * `unevaluatedProperties`, which is the only observable it has: a key the
 * failed schema evaluated must still be unevaluated for the parent.
 */

function leaves(err: ValidationError | undefined): string[] {
  if (err === undefined) return [];
  if (err.children === undefined || err.children.length === 0) {
    return [`${err.code}@${(err.path ?? []).join("/")}`];
  }
  return err.children.flatMap((c) => leaves(c));
}

describe("annotations do not escape a schema object that failed", () => {
  it("discards a failing $ref target's properties annotation", () => {
    const v = compile({
      $defs: { B: { properties: { a: {} }, required: ["missing"] } },
      $ref: "#/$defs/B",
      unevaluatedProperties: false,
    });
    const r = v.validate({ a: 1 });
    expect(r.valid).toBe(false);
    expect(leaves(failure(r).error).sort()).toEqual([
      "required@missing",
      "unevaluatedProperties@a",
    ]);
  });

  it("keeps a passing $ref target's annotation", () => {
    const v = compile({
      $defs: { B: { properties: { a: {} } } },
      $ref: "#/$defs/B",
      unevaluatedProperties: false,
    });
    expect(v.validate({ a: 1 }).valid).toBe(true);
  });

  it("discards a failing then's annotation", () => {
    const v = compile({
      if: { type: "object" },
      then: { properties: { a: {} }, required: ["missing"] },
      unevaluatedProperties: false,
    });
    const r = v.validate({ a: 1 });
    expect(r.valid).toBe(false);
    expect(leaves(failure(r).error).sort()).toEqual([
      "required@missing",
      "unevaluatedProperties@a",
    ]);
  });

  it("discards a failing else's annotation", () => {
    const v = compile({
      if: { type: "array" },
      then: {},
      else: { properties: { a: {} }, required: ["missing"] },
      unevaluatedProperties: false,
    });
    expect(v.validate({ a: 1 }).valid).toBe(false);
    expect(leaves(failure(v.validate({ a: 1 })).error)).toContain("unevaluatedProperties@a");
  });

  it("discards a failing dependentSchemas branch's annotation", () => {
    const v = compile({
      properties: { trigger: {} },
      dependentSchemas: { trigger: { properties: { a: {} }, required: ["missing"] } },
      unevaluatedProperties: false,
    });
    const r = v.validate({ trigger: 1, a: 2 });
    expect(r.valid).toBe(false);
    expect(leaves(failure(r).error)).toContain("unevaluatedProperties@a");
  });

  it("discards the annotations of a oneOf that matched more than once", () => {
    const v = compile({
      oneOf: [{ properties: { a: {} } }, { type: "object" }],
      unevaluatedProperties: false,
    });
    const r = v.validate({ a: 1 });
    expect(r.valid).toBe(false);
    // Both branches match, so `oneOf` fails and exports nothing; `a` is
    // therefore unevaluated for the enclosing keyword.
    expect(leaves(failure(r).error)).toContain("unevaluatedProperties@a");
  });

  it("keeps the annotations of a oneOf that matched exactly once", () => {
    const v = compile({
      oneOf: [{ properties: { a: {} }, required: ["a"] }, { type: "array" }],
      unevaluatedProperties: false,
    });
    expect(v.validate({ a: 1 }).valid).toBe(true);
  });

  it("agrees with predicate mode, which already buffered the oneOf sets", () => {
    // Predicate mode has always committed a matching branch's keys only
    // once the count was known. This pins that flat and tree now say the
    // same thing rather than exporting per branch.
    const schema = {
      oneOf: [{ properties: { a: {} } }, { type: "object" }],
      unevaluatedProperties: false,
    };
    expect(compile(schema, { output: "predicate" }).validate({ a: 1 })).toBe(false);
    expect(compile(schema, { output: "flat" }).validate({ a: 1 }).valid).toBe(false);
    expect(compile(schema).validate({ a: 1 }).valid).toBe(false);
  });

  it("agrees across flat and tree for a multiple-match oneOf", () => {
    // `oneOf` has three implementations, one per output mode, and each
    // merges branch annotations separately. A fix applied to one of them
    // reads as correct until the other mode is asked the same question.
    const schema = {
      oneOf: [{ properties: { a: {} } }, { type: "object" }],
      unevaluatedProperties: false,
    };
    const flat = compile(schema, { output: "flat", maxErrors: 100 }).validate({ a: 1 });
    const tree = compile(schema).validate({ a: 1 });
    expect(flat.valid).toBe(false);
    expect(tree.valid).toBe(false);
    const flatCodes = (flat.valid ? [] : flat.errors).map((e) => e.code);
    expect(flatCodes).toContain("unevaluatedProperties");
    expect(leaves(failure(tree).error)).toContain("unevaluatedProperties@a");
  });

  it("discards a failing $ref target's items annotation", () => {
    const v = compile({
      $defs: { B: { prefixItems: [{ type: "integer" }], minItems: 5 } },
      $ref: "#/$defs/B",
      unevaluatedItems: false,
    });
    const r = v.validate([1]);
    expect(r.valid).toBe(false);
    expect(leaves(failure(r).error)).toContain("unevaluatedItems@0");
  });
});
