import { describe, expect, it } from "vitest";
import { createBranchError, createLeafError, type ValidationError } from "../src/errors.js";
import {
  countErrors,
  formatLeafDetail,
  formatSummary,
  formatText,
  toJsonObject,
} from "../src/format.js";

/** A realistic 4-level oneOf failure used by several formatter assertions. */
function sampleTree(): ValidationError {
  return createBranchError("body", ["body"], "request body invalid", [
    createBranchError(
      "oneOf",
      ["body"],
      "must match exactly one of 2 schemas",
      [
        createBranchError(
          "branch",
          ["body"],
          "branch 0 (Cat) failed",
          [createLeafError("type", ["body", "purr"], "must be boolean")],
          { index: 0, title: "Cat" },
        ),
        createBranchError(
          "branch",
          ["body"],
          "branch 1 (Dog) failed",
          [createLeafError("required", ["body"], 'must have required property "bark"')],
          { index: 1, title: "Dog" },
        ),
      ],
      { matchCount: 0 },
    ),
  ]);
}

describe("formatText", () => {
  it("renders a 4-level tree with nested indentation and codes", () => {
    const out = formatText(sampleTree());
    const lines = out.split("\n");
    expect(lines[0]).toBe("body request body invalid [body]");
    expect(lines[1]).toBe("  body must match exactly one of 2 schemas [oneOf]");
    expect(lines[2]).toBe("    body branch 0 (Cat) failed [branch]");
    expect(lines[3]).toBe("      body.purr must be boolean [type]");
    expect(lines[4]).toBe("    body branch 1 (Dog) failed [branch]");
    expect(lines[5]).toBe('      body must have required property "bark" [required]');
  });

  it("truncates at maxDepth with an ellipsis marker", () => {
    const out = formatText(sampleTree(), { maxDepth: 2 });
    const lines = out.split("\n");
    expect(lines).toContain("      …");
    for (const line of lines) {
      expect(line).not.toContain("must be boolean");
    }
    // Boundary: depth==maxDepth must still render (the rule is `depth >
    // maxDepth`, not `>=`). Pin it so an off-by-one regression here would
    // be caught.
    expect(lines).toContain("    body branch 0 (Cat) failed [branch]");
    expect(lines).toContain("    body branch 1 (Dog) failed [branch]");
  });

  it("allows overriding the indent string", () => {
    const out = formatText(sampleTree(), { indent: "\t" });
    expect(out.split("\n")[1]).toMatch(/^\tbody must match/);
  });

  it("omits the path prefix when the path is empty", () => {
    const tree = createLeafError("internal", [], "something broke");
    expect(formatText(tree)).toBe("something broke [internal]");
  });
});

describe("countErrors", () => {
  it("counts branches and leaves", () => {
    expect(countErrors(sampleTree())).toBe(6);
  });

  it("sums node counts across a flat list (default output)", () => {
    const flat = [
      createLeafError("type", ["body", "age"], "must be number"),
      createLeafError("required", ["body"], "missing name"),
    ];
    expect(countErrors(flat)).toBe(2);
    expect(countErrors([])).toBe(0);
  });
});

describe("toJsonObject", () => {
  it("returns a tree that survives JSON.stringify → JSON.parse", () => {
    const tree = sampleTree();
    const roundTripped = JSON.parse(JSON.stringify(toJsonObject(tree)));
    expect(roundTripped).toEqual(tree);
  });

  it("deep-copies children and params", () => {
    const tree = sampleTree();
    const cloned = toJsonObject(tree);
    expect(cloned).not.toBe(tree);
    expect(cloned.children).not.toBe(tree.children);
    const firstChild = cloned.children[0];
    if (firstChild === undefined) throw new Error("unreachable");
    firstChild.message = "mutated";
    expect(tree.children[0]?.message).not.toBe("mutated");
  });

  it("round-trips a flat list to a list (default output)", () => {
    const flat = [
      createLeafError("type", ["body", "age"], "must be number"),
      createLeafError("required", ["body"], "missing name"),
    ];
    const cloned = toJsonObject(flat);
    expect(Array.isArray(cloned)).toBe(true);
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(flat);
    expect(cloned).not.toBe(flat);
  });
});

describe("formatSummary", () => {
  it('defaults to "first" and picks the first leaf in tree-traversal order', () => {
    expect(formatSummary(sampleTree())).toBe("body.purr must be boolean");
  });

  it('"deepest" picks the leaf with the longest path', () => {
    const tree = createBranchError("body", ["body"], "bad", [
      createLeafError("required", ["body"], "missing name"),
      createLeafError("type", ["body", "items", 3, "name"], "must be string"),
    ]);
    expect(formatSummary(tree, { select: "first" })).toBe("body missing name");
    expect(formatSummary(tree, { select: "deepest" })).toBe("body.items[3].name must be string");
  });

  it('"all" enumerates every leaf, one per line', () => {
    const out = formatSummary(sampleTree(), { select: "all" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("body.purr must be boolean [type]");
    expect(lines[1]).toBe('body must have required property "bark" [required]');
  });

  it('"all" honors a custom separator', () => {
    const out = formatSummary(sampleTree(), { select: "all", separator: ", " });
    expect(out).toBe(
      'body.purr must be boolean [type], body must have required property "bark" [required]',
    );
  });

  it('"all" suppresses the trailing [code] when includeCode is false', () => {
    const out = formatSummary(sampleTree(), { select: "all", includeCode: false });
    const lines = out.split("\n");
    expect(lines).toEqual(["body.purr must be boolean", 'body must have required property "bark"']);
  });

  it('"all" with eov-shape options composes separator + includeCode orthogonally', () => {
    const out = formatSummary(sampleTree(), {
      select: "all",
      separator: ", ",
      includeCode: false,
    });
    expect(out).toBe('body.purr must be boolean, body must have required property "bark"');
  });

  it("separator and includeCode have no effect on single-leaf modes", () => {
    const tree = sampleTree();
    const opts = { separator: ", ", includeCode: false } as const;
    expect(formatSummary(tree, { select: "first", ...opts })).toBe(
      formatSummary(tree, { select: "first" }),
    );
    expect(formatSummary(tree, { select: "deepest", ...opts })).toBe(
      formatSummary(tree, { select: "deepest" }),
    );
  });

  it('path: "auto" drops the prefix for self-locating HTTP-level leaves', () => {
    const missingParam = createLeafError(
      "query-param",
      ["query", "persona"],
      'missing required query parameter "persona"',
      { name: "persona", in: "query" },
    );
    const missingBody = createLeafError("body", ["body"], "missing required request body");
    expect(formatSummary([missingParam], { path: "auto" })).toBe(
      'missing required query parameter "persona"',
    );
    expect(formatSummary([missingBody], { path: "auto" })).toBe("missing required request body");
    // Default and explicit "always" keep the (stuttering) prefix.
    expect(formatSummary([missingParam])).toBe(
      'query.persona missing required query parameter "persona"',
    );
    expect(formatSummary([missingParam], { path: "always" })).toBe(
      'query.persona missing required query parameter "persona"',
    );
  });

  it('path: "auto" keeps the prefix on schema-keyword leaves', () => {
    const typeLeaf = createLeafError("type", ["body", "outer", "inner"], "must be string");
    expect(formatSummary([typeLeaf], { path: "auto" })).toBe("body.outer.inner must be string");
    // The format/"email" trap: a field named like its format must keep
    // its path; this is why "auto" keys on the code, not the message.
    const emailLeaf = createLeafError("format", ["body", "email"], 'must match format "email"');
    expect(formatSummary([emailLeaf], { path: "auto" })).toBe(
      'body.email must match format "email"',
    );
  });

  it('path: "auto" applies per leaf under select: "all"', () => {
    const leaves = [
      createLeafError(
        "query-param",
        ["query", "persona"],
        'missing required query parameter "persona"',
        {
          name: "persona",
          in: "query",
        },
      ),
      createLeafError("type", ["body", "age"], "must be number"),
    ];
    expect(formatSummary(leaves, { select: "all", path: "auto" })).toBe(
      'missing required query parameter "persona" [query-param]\nbody.age must be number [type]',
    );
  });

  it("byCode returns the first leaf matching the highest-priority listed code", () => {
    const tree = createBranchError("request", [], "request invalid", [
      createLeafError("type", ["body", "age"], "must be number"),
      createLeafError("content-type", ["body"], 'Content-Type "text/plain" not accepted'),
      createLeafError("required", ["body"], "missing name"),
    ]);
    expect(formatSummary(tree, { select: { byCode: ["content-type", "required"] } })).toBe(
      'body Content-Type "text/plain" not accepted',
    );
    expect(formatSummary(tree, { select: { byCode: ["required", "content-type"] } })).toBe(
      "body missing name",
    );
  });

  it('byCode falls back to "first" when no leaf matches any listed code', () => {
    const tree = createLeafError("type", ["body", "age"], "must be number");
    expect(formatSummary(tree, { select: { byCode: ["content-type", "security"] } })).toBe(
      "body.age must be number",
    );
  });

  it("renders a path-less leaf as just the message", () => {
    const tree = createLeafError("route", [], "no matching route");
    expect(formatSummary(tree)).toBe("no matching route");
  });

  it("accepts a flat list (default output) and treats elements as leaves", () => {
    const flat = [
      createLeafError("type", ["body", "age"], "must be number"),
      createLeafError("required", ["body"], "missing name"),
    ];
    expect(formatSummary(flat)).toBe("body.age must be number");
    expect(formatSummary(flat, { select: "deepest" })).toBe("body.age must be number");
    expect(formatSummary(flat, { select: "all" })).toBe(
      "body.age must be number [type]\nbody missing name [required]",
    );
    expect(formatSummary(flat, { select: { byCode: ["required"] } })).toBe("body missing name");
  });

  it("returns an empty string for an empty list", () => {
    expect(formatSummary([])).toBe("");
    expect(formatSummary([], { select: "all" })).toBe("");
  });
});

describe("formatSummary path-less leaf", () => {
  it("renders a path-less leaf as just the message", () => {
    const tree = createLeafError("route", [], "no matching route");
    expect(formatSummary(tree)).toBe("no matching route");
  });
});

describe("formatLeafDetail", () => {
  // Shared by an example finding's summary and by the located item a
  // SARIF related location carries for the same leaf (#777). They
  // rendered the same leaf differently while this was private to one
  // of them.
  it("names the value and the set for enum", () => {
    expect(formatLeafDetail("enum", { actual: "EFT", allowed: ["ACH", "CHECK"] })).toBe(
      ' (actual: "EFT", allowed: ["ACH","CHECK"])',
    );
  });

  it("names the value and the expectation for const", () => {
    expect(formatLeafDetail("const", { actual: 2, expected: 1 })).toBe(" (actual: 2, expected: 1)");
  });

  it("names the actual type for type, which is a name and not a value", () => {
    expect(formatLeafDetail("type", { actual: "number" })).toBe(" (actual: number)");
  });

  it("says nothing for a type leaf whose actual is not a type name", () => {
    // Callers append unconditionally, so this has to be safe rather
    // than render `(actual: [object Object])`.
    expect(formatLeafDetail("type", { actual: { a: 1 } })).toBe("");
    expect(formatLeafDetail("type", {})).toBe("");
  });

  it("says nothing for a code whose message already names its bound", () => {
    // `minLength` reports `actual` as a count, so appending it would
    // read as a second bound.
    expect(formatLeafDetail("minLength", { minLength: 34, actual: 0 })).toBe("");
    expect(formatLeafDetail("required", { missing: "id" })).toBe("");
  });

  it("elides a long value rather than running past a line", () => {
    const long = "x".repeat(500);
    const out = formatLeafDetail("const", { actual: long, expected: "y" });
    expect(out).toContain("...");
    expect(out.length).toBeLessThan(120);
  });

  it("allows an enum more room than a single value", () => {
    // A set is worth naming in full more often than one value is.
    const allowed = Array.from({ length: 20 }, (_, i) => `option-${i}`);
    const out = formatLeafDetail("enum", { actual: "nope", allowed });
    expect(out).toContain("option-0");
    expect(out).toContain("option-5");
  });

  it("survives a value that will not serialize", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(formatLeafDetail("const", { actual: circular, expected: 1 })).toContain("the value");
  });
});
