/**
 * Behavioral tests for the subschema-inlining optimization. We assert
 * on `v.stats.functionCount` (the compiler's own tally of
 * `validate_N` helper functions emitted), so the shape of the
 * generated source can change without breaking these tests.
 */

import { describe, expect, it } from "vitest";
import { compileSchema, type CompiledTreeSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";
import { failure } from "./helpers.js";

function compile(schema: unknown): CompiledTreeSchema {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
  });
}

describe("subschema inlining", () => {
  it("inlines a single-keyword items subschema (no extra function generated)", () => {
    const v = compile({ type: "array", items: { type: "number" } });
    // Only the root validator; items subschema lives inline.
    expect(v.stats.functionCount).toBe(1);
  });

  it("inlines a single-keyword properties subschema", () => {
    const v = compile({ type: "object", properties: { name: { type: "string" } } });
    expect(v.stats.functionCount).toBe(1);
  });

  it("inlines a pure-leaf multi-keyword subschema", () => {
    const v = compile({
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 100 },
    });
    // Only the root validator; items' schema has three leaf keywords
    // (no applicators), so it inlines.
    expect(v.stats.functionCount).toBe(1);
  });

  it("compiles an applicator-containing subschema as a function (hot-loop friendly)", () => {
    const v = compile({
      type: "array",
      items: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
    });
    // items' schema has `properties` (applicator), so it stays a
    // function; V8 monomorphizes the hot-loop call better that way
    // than inlining would.
    expect(v.stats.functionCount).toBe(2);
  });

  it("falls back to a named function when the subschema contains $ref", () => {
    const v = compile({
      $defs: {
        Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
      type: "array",
      items: { $ref: "#/$defs/Pet" },
    });
    // The Pet schema is compiled to a function so recursion would
    // work if it referenced itself.
    expect(v.stats.functionCount).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a named function past the inline-depth ceiling", () => {
    // 8 levels of nesting; exceeds MAX_INLINE_DEPTH=6.
    let inner: unknown = { type: "number" };
    for (let i = 0; i < 8; i += 1) {
      inner = { type: "object", properties: { nested: inner } };
    }
    const v = compile(inner);
    // At least one subschema had to be compiled as a function at some
    // depth.
    expect(v.stats.functionCount).toBeGreaterThanOrEqual(2);
  });

  it("inlining preserves validation behavior: tree form", () => {
    const v = compile({ type: "array", items: { type: "number" } });
    expect(v.validate([1, 2, 3]).valid).toBe(true);
    const r = v.validate([1, "two", 3]);
    expect(r.valid).toBe(false);
    expect(failure(r).error?.code).toBe("type");
    expect(failure(r).error?.path).toEqual([1]);
  });

  it("inlining preserves validation behavior: property form", () => {
    const v = compile({ type: "object", properties: { age: { type: "integer" } } });
    expect(v.validate({ age: 5 }).valid).toBe(true);
    const r = v.validate({ age: "x" });
    expect(r.valid).toBe(false);
    expect(failure(r).error?.path).toEqual(["age"]);
  });

  it("inlining respects maxErrors: allocated paths still wear the budget cap", () => {
    const v = compileSchema(
      { type: "array", items: { type: "number" } },
      { dialect: jsonSchemaDialect, output: "tree", maxErrors: 3 },
    );
    const r = v.validate(["a", "b", "c", "d", "e"]);
    expect(r.valid).toBe(false);
    expect(failure(r).truncated).toBe(true);
    // Collect leaves under the (possibly "schema"-wrapped) root
    const collect = (e: unknown, out: unknown[] = []): unknown[] => {
      if (e === null || typeof e !== "object") return out;
      const node = e as { children?: unknown[] };
      if (!Array.isArray(node.children) || node.children.length === 0) {
        out.push(e);
        return out;
      }
      for (const c of node.children) collect(c, out);
      return out;
    };
    expect(collect(failure(r).error)).toHaveLength(3);
  });

  it("inlining does not break recursive $ref schemas (those stay as functions)", () => {
    const v = compile({
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "number" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
      $ref: "#/$defs/Node",
    });
    // Node has to be a function for recursion. The inline-eligibles
    // (value, children outer) are single-keyword and inline.
    const tree = { value: 1, children: [{ value: 2, children: [{ value: 3 }] }] };
    expect(v.validate(tree).valid).toBe(true);
  });
});
