/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { ValidationError } from "@oaverify/internal-core";
import { openapi31Dialect } from "../src/keywords/vocabulary.js";
import { compile, failure } from "./helpers.js";

/**
 * A nested `unevaluatedProperties` / `unevaluatedItems` whose value is a
 * schema annotates for the enclosing keyword, exactly as the boolean `true`
 * form does (#1038). The annotation is the set of keys the subschema
 * validated (2020-12 section 11.3), so a key whose subschema failed is not
 * in it.
 *
 * Both dialects that carry the vocabulary are asserted, because a dialect
 * difference here would be a defect and nothing else in the suite would
 * catch it.
 */

const DIALECTS = [
  ["2020-12", undefined],
  ["OAS 3.1", openapi31Dialect],
] as const;

function leafCodes(err: ValidationError | undefined): string[] {
  if (err === undefined) return [];
  if (err.children === undefined || err.children.length === 0) return [err.code];
  return err.children.flatMap((c) => leafCodes(c));
}

function leaves(err: ValidationError | undefined): string[] {
  if (err === undefined) return [];
  if (err.children === undefined || err.children.length === 0) {
    return [`${err.code}@${(err.path ?? []).join("/")}`];
  }
  return err.children.flatMap((c) => leaves(c));
}

describe.each(DIALECTS)("nested unevaluated annotations (%s)", (_label, dialect) => {
  const opts = dialect === undefined ? {} : { dialect };
  const c = (schema: Record<string, unknown>) => compile(schema, opts);

  describe("unevaluatedProperties", () => {
    it("annotates for the parent when the inner value is the empty schema", () => {
      const v = c({ allOf: [{ unevaluatedProperties: {} }], unevaluatedProperties: false });
      expect(v.validate({ x: 1 }).valid).toBe(true);
      expect(v.validate({}).valid).toBe(true);
    });

    it("annotates for the parent when the inner value is a typed schema", () => {
      const v = c({
        allOf: [{ properties: { a: {} }, unevaluatedProperties: { type: "string" } }],
        unevaluatedProperties: false,
      });
      expect(v.validate({ a: 1, x: "str" }).valid).toBe(true);
      expect(v.validate({ a: 1 }).valid).toBe(true);
    });

    it("discards the branch annotation when the inner subschema rejects the value", () => {
      const v = c({
        allOf: [{ properties: { a: {} }, unevaluatedProperties: { type: "string" } }],
        unevaluatedProperties: false,
      });
      const r = v.validate({ a: 1, x: 2 });
      expect(r.valid).toBe(false);
      // The allOf branch fails, so both its `properties` and its
      // `unevaluatedProperties` annotations go, and the outer keyword sees
      // `a` as well as `x`.
      expect(leaves(failure(r).error).sort()).toEqual([
        "type@x",
        "unevaluatedProperties@a",
        "unevaluatedProperties@x",
      ]);
    });

    it("annotates for the parent through a $ref", () => {
      const v = c({
        $defs: { B: { unevaluatedProperties: { type: "string" } } },
        $ref: "#/$defs/B",
        unevaluatedProperties: false,
      });
      expect(v.validate({ x: "str" }).valid).toBe(true);
    });

    it("discards the annotation of a failing $ref target", () => {
      const v = c({
        $defs: { B: { unevaluatedProperties: { type: "string" } } },
        $ref: "#/$defs/B",
        unevaluatedProperties: false,
      });
      const r = v.validate({ x: 2 });
      expect(r.valid).toBe(false);
      // `$ref` hands the caller's own evaluated set to its target rather
      // than a branch-local one, so nothing discards this annotation except
      // the keyword declining to record a key its subschema rejected.
      expect(leaves(failure(r).error).sort()).toEqual(["type@x", "unevaluatedProperties@x"]);
    });

    it("still annotates when the inner value is the boolean true", () => {
      const v = c({ allOf: [{ unevaluatedProperties: true }], unevaluatedProperties: false });
      expect(v.validate({ x: 1, y: [] }).valid).toBe(true);
    });

    it("does not let the parent reopen what an inner false rejected", () => {
      const v = c({
        allOf: [{ properties: { a: {} }, unevaluatedProperties: false }],
        properties: { b: {} },
        unevaluatedProperties: false,
      });
      // The inner keyword cannot see the parent's adjacent `properties`, so
      // it rejects `b`; annotations do not flow downward.
      expect(v.validate({ a: 1, b: 2 }).valid).toBe(false);
      expect(v.validate({ a: 1 }).valid).toBe(true);
    });

    it("annotates through if/then/else", () => {
      const v = c({
        if: { properties: { kind: { const: "wide" } }, required: ["kind"] },
        then: { properties: { kind: {} }, unevaluatedProperties: { type: "number" } },
        unevaluatedProperties: false,
      });
      expect(v.validate({ kind: "wide", span: 3 }).valid).toBe(true);
      const r = v.validate({ kind: "wide", span: "no" });
      expect(r.valid).toBe(false);
      expect(leafCodes(failure(r).error)).toContain("unevaluatedProperties");
    });

    it("annotates through dependentSchemas", () => {
      const v = c({
        properties: { trigger: {} },
        dependentSchemas: { trigger: { unevaluatedProperties: { type: "number" } } },
        unevaluatedProperties: false,
      });
      expect(v.validate({ trigger: 1, extra: 2 }).valid).toBe(true);
      expect(v.validate({ extra: 2 }).valid).toBe(false);
    });

    it("annotates through a recursive self-$ref", () => {
      const v = c({
        $id: "https://example.test/recursive",
        properties: { child: { $ref: "#" } },
        unevaluatedProperties: { type: "integer" },
      });
      expect(v.validate({ child: { child: {}, n: 1 }, n: 2 }).valid).toBe(true);
      expect(v.validate({ child: { n: "no" } }).valid).toBe(false);
    });

    it("annotates across two nesting levels", () => {
      const v = c({
        allOf: [{ allOf: [{ unevaluatedProperties: { type: "string" } }] }],
        unevaluatedProperties: false,
      });
      expect(v.validate({ x: "str" }).valid).toBe(true);
      expect(v.validate({ x: 1 }).valid).toBe(false);
    });
  });

  describe("unevaluatedItems", () => {
    it("annotates for the parent when the inner value is a typed schema", () => {
      const v = c({ allOf: [{ unevaluatedItems: { type: "string" } }], unevaluatedItems: false });
      expect(v.validate(["s"]).valid).toBe(true);
      expect(v.validate([]).valid).toBe(true);
    });

    it("annotates for the parent when the inner value is the empty schema", () => {
      const v = c({ allOf: [{ unevaluatedItems: {} }], unevaluatedItems: false });
      expect(v.validate([1, "two"]).valid).toBe(true);
    });

    it("discards the branch annotation when the inner subschema rejects an item", () => {
      const v = c({
        allOf: [{ prefixItems: [{ type: "integer" }], unevaluatedItems: { type: "string" } }],
        unevaluatedItems: false,
      });
      const r = v.validate([1, 2]);
      expect(r.valid).toBe(false);
      expect(leaves(failure(r).error).sort()).toEqual([
        "type@1",
        "unevaluatedItems@0",
        "unevaluatedItems@1",
      ]);
    });

    it("discards the annotation of a failing $ref target", () => {
      const v = c({
        $defs: { B: { unevaluatedItems: { type: "string" } } },
        $ref: "#/$defs/B",
        unevaluatedItems: false,
      });
      expect(v.validate(["s"]).valid).toBe(true);
      const r = v.validate([2]);
      expect(r.valid).toBe(false);
      expect(leaves(failure(r).error).sort()).toEqual(["type@0", "unevaluatedItems@0"]);
    });

    it("still annotates when the inner value is the boolean true", () => {
      const v = c({ allOf: [{ unevaluatedItems: true }], unevaluatedItems: false });
      expect(v.validate([1, 2]).valid).toBe(true);
    });
  });
});

describe("nested unevaluated annotations across output modes", () => {
  const accepted = {
    allOf: [{ properties: { a: {} }, unevaluatedProperties: { type: "string" } }],
    unevaluatedProperties: false,
  };
  const rejected = {
    $defs: { B: { unevaluatedProperties: { type: "string" } } },
    $ref: "#/$defs/B",
    unevaluatedProperties: false,
  };

  it("agrees on the verdict in flat mode", () => {
    expect(compile(accepted, { output: "flat" }).validate({ a: 1, x: "str" }).valid).toBe(true);
    expect(compile(rejected, { output: "flat" }).validate({ x: 2 }).valid).toBe(false);
  });

  it("agrees on the verdict in predicate mode", () => {
    // Predicate mode returns from the generated validator on the first
    // failure, so the annotation write is only reachable on success and
    // needs no checkpoint. This pins that the two paths still agree.
    expect(compile(accepted, { output: "predicate" }).validate({ a: 1, x: "str" })).toBe(true);
    expect(compile(rejected, { output: "predicate" }).validate({ x: 2 })).toBe(false);
  });

  it("reports the failing $ref target's key in flat mode", () => {
    const r = compile(rejected, { output: "flat", maxErrors: 100 }).validate({ x: 2 });
    expect(r.valid).toBe(false);
    const codes = (r.valid ? [] : r.errors).map((e) => `${e.code}@${(e.path ?? []).join("/")}`);
    expect(codes.sort()).toEqual(["type@x", "unevaluatedProperties@x"]);
  });

  it("keeps the verdict under a finite maxErrors", () => {
    // Budget gating is disabled whenever evaluated-key tracking is on, so
    // the per-key checkpoint cannot be truncated mid-loop. A finite budget
    // must not change the verdict either way.
    for (const maxErrors of [1, 2, 100]) {
      expect(
        compile(accepted, { output: "flat", maxErrors }).validate({ a: 1, x: "str" }).valid,
      ).toBe(true);
      expect(compile(rejected, { output: "flat", maxErrors }).validate({ x: 2 }).valid).toBe(false);
    }
  });
});

describe("a nested annotation from a oneOf that matched more than once", () => {
  // The two corrections meet here: branch 1 now produces an annotation at
  // all, and `oneOf` must not export it because matching twice is a
  // failure. Predicate mode always buffered; flat and tree now agree.
  const schema = {
    oneOf: [{ unevaluatedProperties: {} }, { type: "object" }],
    unevaluatedProperties: false,
  };

  it("rejects under every output mode", () => {
    expect(compile(schema, { output: "flat" }).validate({ a: 1 }).valid).toBe(false);
    expect(compile(schema, { output: "predicate" }).validate({ a: 1 })).toBe(false);
    expect(compile(schema).validate({ a: 1 }).valid).toBe(false);
  });

  it("still reports the key as unevaluated alongside the oneOf failure", () => {
    const r = compile(schema, { output: "flat", maxErrors: 100 }).validate({ a: 1 });
    expect(r.valid).toBe(false);
    const codes = (r.valid ? [] : r.errors).map((e) => e.code);
    expect(codes).toContain("oneOf");
    expect(codes).toContain("unevaluatedProperties");
  });

  it("keeps the annotation when exactly one branch matches", () => {
    const one = {
      oneOf: [{ unevaluatedProperties: {} }, { type: "array" }],
      unevaluatedProperties: false,
    };
    expect(compile(one, { output: "flat" }).validate({ a: 1 }).valid).toBe(true);
    expect(compile(one, { output: "predicate" }).validate({ a: 1 })).toBe(true);
    expect(compile(one).validate({ a: 1 }).valid).toBe(true);
  });
});
