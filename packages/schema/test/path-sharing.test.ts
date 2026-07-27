/**
 * Rigorous tests for the shared-mutable-path calling convention.
 *
 * Generated validators now reuse a single mutable `path` array (push on
 * descent, pop on ascent) instead of allocating `[...path, seg]` per
 * iteration. The runtime error-creation helpers snapshot `path` when
 * committing it to a ValidationError.
 *
 * These tests exist specifically to catch regressions where:
 * 1. A code site forgets to snapshot the path when emitting an error,
 *    so the reported path later mutates (becomes empty as the stack unwinds).
 * 2. An applicator forgets to `pop`, leaving stale segments on the path.
 * 3. An applicator forgets to `push`, emitting errors at the wrong level.
 * 4. Consecutive validate() calls share state across the shared-array.
 */

import type { ValidationError } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

function compile(schema: unknown) {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
  });
}

describe("path sharing: correctness under stress", () => {
  it("reports correct per-item path in a 100-item array where every item fails", () => {
    const v = compile({ type: "array", items: { type: "number" } });
    const data = Array.from({ length: 100 }, (_, i) => `bad-${i}`);
    const r = v.validate(data);
    expect(r.valid).toBe(false);
    const leaves = flattenLeaves(r.error!);
    // One leaf per item (type error)
    expect(leaves).toHaveLength(100);
    // Each leaf's path should be [i] for i in 0..99, in order
    leaves.forEach((leaf, i) => {
      expect(leaf.path).toEqual([i]);
    });
  });

  it("reports correct path for deeply nested errors", () => {
    const v = compile({
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              addresses: {
                type: "array",
                items: {
                  type: "object",
                  properties: { zip: { type: "string" } },
                },
              },
            },
          },
        },
      },
    });
    const r = v.validate({
      users: [{ addresses: [{ zip: "a" }, { zip: 2 }, { zip: "b" }] }, { addresses: [{ zip: 3 }] }],
    });
    expect(r.valid).toBe(false);
    const leaves = flattenLeaves(r.error!);
    const paths = leaves.map((l) => l.path.join("."));
    expect(paths).toContain("users.0.addresses.1.zip");
    expect(paths).toContain("users.1.addresses.0.zip");
  });

  it("does not leak path state across consecutive validate() calls", () => {
    const v = compile({
      type: "object",
      properties: { x: { type: "number" } },
    });
    // First call: error at ["x"]
    const r1 = v.validate({ x: "not a number" });
    expect(r1.error?.path).toEqual(["x"]);
    // Second call: same error, same path, not ["x", "x"] from shared leak
    const r2 = v.validate({ x: "still not a number" });
    expect(r2.error?.path).toEqual(["x"]);
    // Third call, a different shape
    const r3 = v.validate({ x: "bad" });
    expect(r3.error?.path).toEqual(["x"]);
  });

  it("preserves path in errors after the validation frame has exited", () => {
    // This test specifically catches the "forgot to snapshot the path"
    // bug class: if the error's path reference is the live mutable
    // array, it would be empty by the time we inspect it (since the
    // pop unwound it).
    const v = compile({ type: "array", items: { type: "number" } });
    const r = v.validate(["a", "b", "c"]);
    const leaves = flattenLeaves(r.error!);
    // Each leaf must have a CLOSED-OVER path, not a reference to a
    // mutated array.
    expect(leaves[0]?.path).toEqual([0]);
    expect(leaves[1]?.path).toEqual([1]);
    expect(leaves[2]?.path).toEqual([2]);
    // After validation returns, mutating the captured paths in any
    // way must not affect the error's own path.
    leaves.forEach((leaf) => {
      // The path array is our own; freely mutate without affecting others
      leaf.path.push("extra");
    });
    // Re-run: fresh paths must not include the "extra" segments from above
    const r2 = v.validate(["x"]);
    const leaves2 = flattenLeaves(r2.error!);
    expect(leaves2[0]?.path).toEqual([0]);
  });

  it("required error path points at the missing key", () => {
    const v = compile({
      type: "object",
      required: ["a", "b", "c"],
    });
    const r = v.validate({});
    const leaves = flattenLeaves(r.error!);
    const missing = leaves.map((l) => l.path.join("."));
    expect(missing.sort()).toEqual(["a", "b", "c"]);
  });

  it("additionalProperties:false error path points at the offending key", () => {
    const v = compile({
      type: "object",
      properties: { ok: { type: "string" } },
      additionalProperties: false,
    });
    const r = v.validate({ ok: "x", badKey: 1, anotherBad: 2 });
    const leaves = flattenLeaves(r.error!);
    const bad = leaves.map((l) => l.path.join("."));
    expect(bad.sort()).toEqual(["anotherBad", "badKey"]);
  });

  it("patternProperties error path is the matched key", () => {
    const v = compile({
      type: "object",
      patternProperties: { "^_": { type: "number" } },
    });
    const r = v.validate({ _foo: "bad", _bar: "also bad" });
    const leaves = flattenLeaves(r.error!);
    const keys = leaves.map((l) => l.path.join("."));
    expect(keys.sort()).toEqual(["_bar", "_foo"]);
  });

  it("prefixItems puts the index on the path", () => {
    const v = compile({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    });
    const r = v.validate([1, "x", "y"]);
    const leaves = flattenLeaves(r.error!);
    const paths = leaves.map((l) => l.path.join("."));
    expect(paths.sort()).toEqual(["0", "1", "2"]);
  });

  it("unevaluatedProperties:false error path is the unevaluated key", () => {
    const v = compile({
      type: "object",
      properties: { known: { type: "string" } },
      unevaluatedProperties: false,
    });
    const r = v.validate({ known: "x", unknown1: 1, unknown2: 2 });
    const leaves = flattenLeaves(r.error!);
    const keys = leaves.map((l) => l.path.join("."));
    expect(keys.sort()).toEqual(["unknown1", "unknown2"]);
  });

  it("maxErrors + path sharing: the truncated tree's paths are all correct", () => {
    // Even when a loop short-circuits on budget, the paths of errors
    // that DID get pushed must still be correct.
    const v = compileSchema({ type: "array", items: { type: "number" } } as never, {
      dialect: jsonSchemaDialect,
      output: "tree",
      maxErrors: 3,
    });
    const r = v.validate(["a", "b", "c", "d", "e"]);
    expect(r.truncated).toBe(true);
    const leaves = flattenLeaves(r.error!);
    expect(leaves).toHaveLength(3);
    expect(leaves[0]?.path).toEqual([0]);
    expect(leaves[1]?.path).toEqual([1]);
    expect(leaves[2]?.path).toEqual([2]);
  });

  it("sibling applicators don't interfere with each other's path state", () => {
    // required runs, then properties runs. If required forgot to pop
    // its pushed segment, properties' errors would have the wrong path.
    const v = compile({
      type: "object",
      required: ["missing"],
      properties: {
        a: { type: "number" },
      },
    });
    const r = v.validate({ a: "bad" });
    const leaves = flattenLeaves(r.error!);
    const paths = leaves.map((l) => l.path.join(":"));
    // Must see a "missing" required error at path ["missing"]
    // AND an "a" type error at path ["a"]. No leak: no "missing:a" path.
    expect(paths).toContain("missing");
    expect(paths).toContain("a");
    expect(paths.some((p) => p.includes(":"))).toBe(false);
  });
});

// Helper: walk the tree and collect leaves (nodes with empty children)
// in pre-order traversal, preserving tree structure.
function flattenLeaves(root: ValidationError): ValidationError[] {
  const out: ValidationError[] = [];
  const visit = (node: ValidationError): void => {
    if (node.children.length === 0) {
      out.push(node);
    } else {
      for (const c of node.children) visit(c);
    }
  };
  visit(root);
  return out;
}
