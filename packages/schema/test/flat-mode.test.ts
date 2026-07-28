/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import {
  collectLeaves,
  createBranchError,
  formatError,
  type ValidationError,
} from "@oaverify/internal-core";
import { compileSchema, type CompiledTreeSchema } from "../src/compiler/compiler.js";
import { appendErrors } from "../src/compiler/runtime.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";
import { failure } from "./helpers.js";

type Opts = { maxErrors?: number };

function tree(schema: unknown, opts: Opts = {}): CompiledTreeSchema {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  });
}
function flat(schema: unknown, opts: Opts = {}) {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    output: "flat",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  });
}

// Full-fidelity multiset key: a flat record and its tree-leaf counterpart
// must agree on code, path, message, AND params (they go through the
// identical leaf-emission path; only wrapping differs).
const fullKey = (e: ValidationError): string =>
  `${e.code}@${JSON.stringify(e.path)}|${e.message}|${JSON.stringify(e.params)}`;
const bag = (es: ValidationError[]): string[] => es.map(fullKey).sort();
const codesOf = (es: ValidationError[]): string[] => es.map((e) => e.code);

// Schemas with NO anyOf/oneOf: flat output must equal the tree's leaf
// set exactly (allOf / if / not wrap or mark identically across modes).
const LEAF_CASES: Array<{ name: string; schema: unknown; data: unknown }> = [
  { name: "type mismatch", schema: { type: "string" }, data: 42 },
  { name: "multiple required", schema: { type: "object", required: ["a", "b", "c"] }, data: {} },
  {
    name: "nested object properties",
    schema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "object", properties: { c: { type: "string" } } },
      },
    },
    data: { a: "x", b: { c: 1 } },
  },
  {
    name: "array items",
    schema: { type: "array", items: { type: "number" } },
    data: [1, "x", 2, "y"],
  },
  { name: "numeric bounds", schema: { type: "number", minimum: 0, maximum: 10 }, data: 20 },
  {
    name: "string length + pattern",
    schema: { type: "string", minLength: 5, pattern: "^a" },
    data: "bb",
  },
  {
    name: "allOf (branch wrapper, no marker)",
    schema: { allOf: [{ required: ["a"] }, { required: ["b"] }] },
    data: {},
  },
  { name: "not (leaf marker)", schema: { not: { type: "string" } }, data: "hi" },
  {
    name: "if/then/else (then branch)",
    schema: {
      if: { type: "object", required: ["kind"] },
      then: { required: ["x"] },
      else: { required: ["y"] },
    },
    data: { kind: "a" },
  },
  { name: "dependentRequired", schema: { dependentRequired: { a: ["b", "c"] } }, data: { a: 1 } },
  {
    name: "additionalProperties",
    schema: { type: "object", properties: { a: true }, additionalProperties: { type: "number" } },
    data: { a: 1, b: "x", c: "y" },
  },
  {
    name: "deep nesting, multiple leaves under one subschema",
    schema: { type: "object", properties: { x: { type: "object", required: ["a", "b"] } } },
    data: { x: {} },
  },
];

describe("flat mode: configuration guards", () => {
  it("accepts flat + maxErrors", () => {
    expect(() =>
      compileSchema({ type: "string" } as never, {
        dialect: jsonSchemaDialect,
        output: "flat",
        maxErrors: 3,
      }),
    ).not.toThrow();
  });
});

describe("flat mode: valid data", () => {
  it("returns { valid: true } with no errors array", () => {
    const r = flat({ type: "object", required: ["a"] }).validate({ a: 1 });
    expect(r.valid).toBe(true);
    expect("errors" in r).toBe(false);
  });
});

describe("flat mode: leaf-set parity with the tree (non-composition schemas)", () => {
  for (const { name, schema, data } of LEAF_CASES) {
    it(`${name}: flat list equals collectLeaves(tree)`, () => {
      const t = tree(schema).validate(data);
      const f = flat(schema).validate(data);
      expect(t.valid).toBe(false);
      expect(f.valid).toBe(false);
      // Same set of leaf errors, ignoring tree nesting and order.
      expect(bag(failure(f).errors!)).toEqual(bag(collectLeaves(failure(t).error!)));
      // And flat genuinely carries no branch wrappers.
      for (const e of failure(f).errors!) expect(e.children).toEqual([]);
    });
  }
});

describe("flat mode: finite-maxErrors leaf-set parity with the tree (non-composition)", () => {
  // The budget short-circuit stops collection mid-evaluation. Flat codegen and
  // tree codegen run the identical keyword dispatch under the identical gated
  // counter, so a finite cap must keep the SAME leading leaves in both modes:
  // the flat list and collectLeaves(tree) stay equal. Nothing else forces
  // these two flat-list producers equal under a budget (the Infinity block
  // above only exercises the un-gated path).
  //
  // `truncated` semantics differ by mode: flat returns the moment the cap is
  // reached (truncated means "cap reached; list may be incomplete", so it is
  // exactly `errors.length === maxErrors`), while tree keeps walking and
  // reports truncated only when it observably dropped or skipped something.
  // Tree truncation therefore implies flat truncation, never the reverse.
  for (const { name, schema, data } of LEAF_CASES) {
    for (const maxErrors of [1, 2, 3]) {
      it(`${name} @ maxErrors=${maxErrors}`, () => {
        const t = tree(schema, { maxErrors }).validate(data);
        const f = flat(schema, { maxErrors }).validate(data);
        expect(t.valid).toBe(false);
        expect(f.valid).toBe(false);
        expect(bag(failure(f).errors!)).toEqual(bag(collectLeaves(failure(t).error!)));
        expect(failure(f).errors!.length).toBeLessThanOrEqual(maxErrors);
        expect(failure(f).truncated).toBe(failure(f).errors!.length === maxErrors);
        if (failure(t).truncated) expect(failure(f).truncated).toBe(true);
        for (const e of failure(f).errors!) expect(e.children).toEqual([]);
      });
    }
  }
});

describe("flat mode: composition markers", () => {
  it("anyOf all-fail: branch leaves plus one anyOf marker", () => {
    const r = flat({ anyOf: [{ type: "string" }, { type: "number" }] }).validate(true);
    expect(r.valid).toBe(false);
    expect(codesOf(failure(r).errors!).filter((c) => c === "type")).toHaveLength(2);
    const marker = failure(r).errors!.find((e) => e.code === "anyOf");
    expect(marker).toBeDefined();
    expect(marker!.children).toEqual([]);
    expect(marker!.params).toMatchObject({ total: 2 });
  });

  it("anyOf one-match: valid, no errors", () => {
    const r = flat({ anyOf: [{ type: "string" }, { type: "number" }] }).validate("hi");
    expect(r.valid).toBe(true);
    expect("errors" in r).toBe(false);
  });

  it("oneOf zero-match: branch leaves plus one oneOf marker (matchCount 0)", () => {
    const r = flat({ oneOf: [{ type: "string" }, { type: "boolean" }] }).validate(42);
    expect(r.valid).toBe(false);
    expect(codesOf(failure(r).errors!).filter((c) => c === "type")).toHaveLength(2);
    const marker = failure(r).errors!.find((e) => e.code === "oneOf");
    expect(marker).toBeDefined();
    expect(marker!.params).toMatchObject({ total: 2, matchCount: 0 });
  });

  it("oneOf two-match: only a oneOf marker (matchCount 2), no branch leaves", () => {
    // 4 satisfies both `type: number` and `multipleOf: 1`.
    const r = flat({ oneOf: [{ type: "number" }, { multipleOf: 1 }] }).validate(4);
    expect(r.valid).toBe(false);
    expect(failure(r).errors!.filter((e) => e.code !== "oneOf")).toHaveLength(0);
    const marker = failure(r).errors!.find((e) => e.code === "oneOf");
    expect(marker!.params).toMatchObject({ matchCount: 2 });
  });

  it("nested anyOf inside an object property keeps the leaf paths", () => {
    const schema = {
      type: "object",
      properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    const r = flat(schema).validate({ v: true });
    expect(r.valid).toBe(false);
    // Both branch leaves and the marker sit at path ["v"].
    for (const e of failure(r).errors!) expect(e.path).toEqual(["v"]);
    expect(failure(r).errors!.find((e) => e.code === "anyOf")).toBeDefined();
  });
});

describe("flat mode: validity agreement with the tree", () => {
  // A broad corpus exercising composition, refs, recursion, arrays, and
  // both valid and invalid data. Flat and tree must always agree on
  // valid/invalid (the airtight behavioral guarantee).
  const recursive = {
    $id: "https://example.test/node",
    type: "object",
    properties: { value: { type: "number" }, children: { type: "array", items: { $ref: "#" } } },
    required: ["value"],
    additionalProperties: false,
  };
  const AGREEMENT: Array<{ schema: unknown; data: unknown }> = [
    ...LEAF_CASES.map(({ schema, data }) => ({ schema, data })),
    // valid counterparts
    { schema: { type: "string" }, data: "ok" },
    { schema: { type: "object", required: ["a", "b"] }, data: { a: 1, b: 2 } },
    // composition
    { schema: { anyOf: [{ type: "string" }, { type: "number" }] }, data: "x" },
    { schema: { anyOf: [{ type: "string" }, { type: "number" }] }, data: true },
    { schema: { oneOf: [{ type: "number" }, { multipleOf: 1 }] }, data: 4 },
    { schema: { oneOf: [{ type: "number" }, { type: "string" }] }, data: 4 },
    { schema: { allOf: [{ minimum: 0 }, { maximum: 10 }] }, data: 5 },
    { schema: { allOf: [{ minimum: 0 }, { maximum: 10 }] }, data: 20 },
    { schema: { not: { type: "string" } }, data: 1 },
    { schema: { not: { type: "string" } }, data: "s" },
    // recursion
    { schema: recursive, data: { value: 1, children: [{ value: 2 }, { value: 3, children: [] }] } },
    { schema: recursive, data: { value: 1, children: [{ value: "bad" }, { extra: true }] } },
  ];

  // Run each case un-gated AND under finite budgets. A finite maxErrors must
  // never flip a valid/invalid verdict (it only caps how many errors are
  // reported); pinning flat.valid === tree.valid across caps guards that v3
  // claim at the compiler's public boundary, composition/refs/recursion incl.
  for (const [i, { schema, data }] of AGREEMENT.entries()) {
    for (const maxErrors of [1, 2, Number.POSITIVE_INFINITY]) {
      it(`case ${i} @ maxErrors=${maxErrors}: flat.valid === tree.valid`, () => {
        const t = tree(schema, { maxErrors }).validate(data);
        const f = flat(schema, { maxErrors }).validate(data);
        expect(f.valid).toBe(t.valid);
      });
    }
  }
});

describe("flat mode: maxErrors and startPath", () => {
  it("caps the flat list and sets truncated", () => {
    const r = flat({ type: "object", required: ["a", "b", "c", "d"] }, { maxErrors: 2 }).validate(
      {},
    );
    expect(r.valid).toBe(false);
    expect(failure(r).errors).toHaveLength(2);
    expect(failure(r).truncated).toBe(true);
  });

  it("resets the budget between calls", () => {
    const v = flat({ required: ["a", "b"] }, { maxErrors: 1 });
    expect(failure(v.validate({})).errors).toHaveLength(1);
    expect(failure(v.validate({})).errors).toHaveLength(1);
  });

  it("prefixes leaf paths with startPath", () => {
    const r = flat({ type: "string" }).validate(1, ["body"]);
    expect(failure(r).errors![0]!.path).toEqual(["body"]);
  });
});

describe("flat mode: record shape and renderer interop", () => {
  it("every record is a childless ValidationError", () => {
    const r = flat({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["b"],
    }).validate({ a: "x" });
    for (const e of failure(r).errors!) {
      expect(e.children).toEqual([]);
      expect(typeof e.code).toBe("string");
      expect(Array.isArray(e.path)).toBe(true);
      expect(typeof e.message).toBe("string");
    }
  });

  it("composes with the tree renderers via a synthetic root wrap", () => {
    const r = flat({ type: "object", required: ["a", "b"] }).validate({});
    const wrapped = createBranchError("schema", [], "schema validation failed", failure(r).errors!);
    expect(collectLeaves(wrapped)).toHaveLength(2);
    expect(() => formatError(wrapped, "flat")).not.toThrow();
  });
});

describe("appendErrors runtime helper", () => {
  const leaf = (i: number): ValidationError => ({
    code: "x",
    path: [i],
    message: "",
    params: {},
    children: [],
  });

  it("adopts src when dest is null (no copy)", () => {
    const src = [leaf(0)];
    expect(appendErrors(null, src)).toBe(src);
  });

  it("returns dest unchanged when src is null", () => {
    const dest = [leaf(0)];
    expect(appendErrors(dest, null)).toBe(dest);
  });

  it("appends src onto dest in place", () => {
    const dest = [leaf(0)];
    const out = appendErrors(dest, [leaf(1), leaf(2)]);
    expect(out).toBe(dest);
    expect(out!.map((e) => e.path[0])).toEqual([0, 1, 2]);
  });

  it("does not overflow the call stack on a large src (loop, not spread)", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => leaf(i));
    expect(() => appendErrors([leaf(-1)], big)).not.toThrow();
    expect(appendErrors([leaf(-1)], big)!.length).toBe(200_001);
  });
});
