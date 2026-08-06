import { collectLeaves, httpStatusFor, type ValidationError } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

// A self-recursive object schema: each level may carry one `child`, which
// validates against the root again. The canonical tree/comment shape.
const recursive = {
  type: "object",
  properties: { child: { $ref: "#" } },
} as const;

// Build data nesting `child` exactly `depth` levels deep. Iterative so the
// test setup never overflows on the depths it exercises.
function nestChild(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let i = 0; i < depth; i += 1) node = { child: node };
  return node;
}

function leafCodes(err: ValidationError | undefined): string[] {
  return err === undefined ? [] : collectLeaves(err).map((l) => l.code);
}

describe("maxDepth: option validation", () => {
  it("throws on zero, negative, and non-integer caps", () => {
    expect(() => compile(recursive, { maxDepth: 0 })).toThrow(/positive integer/);
    expect(() => compile(recursive, { maxDepth: -3 })).toThrow(/positive integer/);
    expect(() => compile(recursive, { maxDepth: 2.5 })).toThrow(/positive integer/);
  });

  it("accepts a positive integer and the degenerate Infinity", () => {
    expect(() => compile(recursive, { maxDepth: 1 })).not.toThrow();
    expect(() => compile(recursive, { maxDepth: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});

describe("maxDepth: codegen specialization", () => {
  it("emits no depth instrumentation when unset (zero overhead)", () => {
    const v = compile(recursive, { retainSource: true });
    expect(v.source).not.toContain("deps.depth");
    expect(v.source).not.toContain("maxDepth");
  });

  it("emits depth instrumentation when set", () => {
    // The mirror of the test above, and the whole of what codegen
    // specialization promises: instrumented when configured, absent
    // when not. What the guard expression looks like is not a contract,
    // and the behaviour it produces is covered below by the cap
    // boundary, the counter reset, and the unwind cases.
    const v = compile(recursive, { maxDepth: 4, retainSource: true });
    expect(v.source).toContain("deps.depth");
    expect(v.source).toContain("maxDepth");
  });

  it("does not instrument a non-recursive schema even when set", () => {
    const flat = { type: "object", properties: { a: { type: "string" } } };
    const v = compile(flat, { maxDepth: 4, retainSource: true });
    expect(v.source).not.toContain("++deps.depth");
    expect(v.validate({ a: "x" }).valid).toBe(true);
    expect(v.validate({ a: 1 }).valid).toBe(false);
  });
});

describe("maxDepth: boundary semantics", () => {
  it("counts one level per recursive descent; allows up to the cap", () => {
    const v = compile(recursive, { maxDepth: 3 });
    expect(v.validate(nestChild(0)).valid).toBe(true);
    expect(v.validate(nestChild(1)).valid).toBe(true);
    expect(v.validate(nestChild(3)).valid).toBe(true); // exactly at the cap
  });

  it("rejects one level past the cap with a `depth` error", () => {
    const v = compile(recursive, { maxDepth: 3 });
    const r = v.validate(nestChild(4));
    expect(r.valid).toBe(false);
    expect(leafCodes(failure(r).error)).toContain("depth");
  });

  it("reports the configured limit in the error params", () => {
    const v = compile(recursive, { maxDepth: 2 });
    const r = v.validate(nestChild(5));
    expect(r.valid).toBe(false);
    const depthLeaf = collectLeaves(failure(r).error).find((l) => l.code === "depth");
    expect(depthLeaf?.params).toEqual({ limit: 2 });
  });

  it("maps the depth error to HTTP 400", () => {
    const v = compile(recursive, { maxDepth: 2 });
    const r = v.validate(nestChild(5));
    expect(httpStatusFor(failure(r).error)).toBe(400);
  });
});

describe("maxDepth: stack safety", () => {
  const DEEP = 100_000;

  it("rejects a pathologically deep payload instead of overflowing", () => {
    const v = compile(recursive, { maxDepth: 64 });
    const r = v.validate(nestChild(DEEP));
    expect(r.valid).toBe(false);
    expect(leafCodes(failure(r).error)).toContain("depth");
  });

  it("confirms the same payload overflows without the guard", () => {
    // Establishes that the guard is what prevents the crash, not some
    // other bound: uncapped, this throws RangeError.
    const v = compile(recursive);
    expect(() => v.validate(nestChild(DEEP))).toThrow(RangeError);
  });
});

describe("maxDepth: counter discipline", () => {
  it("resets the counter between validate() calls", () => {
    const v = compile(recursive, { maxDepth: 3 });
    expect(v.validate(nestChild(10)).valid).toBe(false); // exhausts the counter
    expect(v.validate(nestChild(2)).valid).toBe(true); // must not leak
    expect(v.validate(nestChild(10)).valid).toBe(false); // and trips again
  });

  it("decrements on unwind so sibling branches don't accumulate", () => {
    // A binary-tree schema: a balanced tree has many nodes but a small
    // recursion depth. If the counter failed to decrement on unwind, the
    // node count (not the depth) would trip the cap.
    const tree = {
      type: "object",
      properties: { left: { $ref: "#" }, right: { $ref: "#" } },
    };
    const balanced = (d: number): unknown =>
      d === 0 ? {} : { left: balanced(d - 1), right: balanced(d - 1) };
    const v = compile(tree, { maxDepth: 3 });
    expect(v.validate(balanced(3)).valid).toBe(true); // depth 3, 15 nodes
    expect(v.validate(balanced(4)).valid).toBe(false); // depth 4 > cap
  });
});

describe("maxDepth: predicate mode", () => {
  it("guards recursion without an error tree", () => {
    const v = compile(recursive, { maxDepth: 3, output: "predicate" });
    expect(v.validate(nestChild(3))).toBe(true);
    expect(v.validate(nestChild(4))).toBe(false);
  });

  it("rejects a pathologically deep payload instead of overflowing", () => {
    const v = compile(recursive, { maxDepth: 64, output: "predicate" });
    expect(v.validate(nestChild(100_000))).toBe(false);
  });
});

describe("maxDepth: mutual recursion", () => {
  it("bounds an A -> B -> A cycle", () => {
    // Two schemas that ref each other via $defs. The cycle still has a
    // single back-edge instrumented, which is enough to bound the stack.
    const mutual = {
      $defs: {
        a: { type: "object", properties: { b: { $ref: "#/$defs/b" } } },
        b: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
      },
      $ref: "#/$defs/a",
    };
    const v = compile(mutual, { maxDepth: 8 });
    // Build alternating a/b nesting 100k deep, key-aligned to the schema:
    // the root matches `a` (property `b`), whose value matches `b`
    // (property `a`), and so on. Position 0 is the outermost level.
    let node: Record<string, unknown> = {};
    for (let i = 100_000 - 1; i >= 0; i -= 1) node = { [i % 2 === 0 ? "b" : "a"]: node };
    const r = v.validate(node);
    expect(r.valid).toBe(false);
    expect(leafCodes(failure(r).error)).toContain("depth");
  });
});
