import { describe, expect, it } from "vitest";
import { checkDocumentExamples } from "../src/index.js";

// #625: a validator that throws was caught and the example reported as
// fine. "I could not check this" and "this is fine" are different
// answers, and a consumer could not tell them apart.
const nest = (n: number): unknown => {
  let v: unknown = "leaf";
  for (let i = 0; i < n; i += 1) v = { next: v };
  return v;
};

const recursiveDoc = (value: unknown) =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Node" } },
          required: ["next"],
          example: value,
        },
      },
    },
  }) as never;

describe("a deeply nested example is reported, not silently passed", () => {
  // Ran clean before the fix: the RangeError was swallowed and the
  // example reported as fine, from roughly 3k levels up.
  for (const depth of [1000, 8000, 20000]) {
    it(`reports at depth ${depth}`, () => {
      const issues = checkDocumentExamples(recursiveDoc(nest(depth)));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe("example-invalid");
    });
  }

  // Pinned so a change to the cap is a deliberate edit here, not a
  // silent shift in which examples get checked.
  it("trips just past the cap and not at it", () => {
    const at = checkDocumentExamples(recursiveDoc(nest(500)));
    expect(at[0]?.reasons.some((r) => r.code === "depth")).toBe(false);
    const past = checkDocumentExamples(recursiveDoc(nest(501)));
    expect(past[0]?.reasons.some((r) => r.code === "depth")).toBe(true);
  });

  it("names depth as the reason, so the finding is actionable", () => {
    const issues = checkDocumentExamples(recursiveDoc(nest(8000)));
    expect(issues[0]?.reasons.some((r) => r.code === "depth")).toBe(true);
  });

  // `required: ["next"]` on a self-`$ref` admits no finite value, so a
  // shallow example here is invalid too. What separates them is the
  // reason: too deep to check, versus wrong.
  it("reports a shallow invalid example without blaming depth", () => {
    const issues = checkDocumentExamples(recursiveDoc(nest(3)));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("example-invalid");
    expect(issues[0]?.reasons.some((r) => r.code === "depth")).toBe(false);
  });

  it("says nothing about an example that validates", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Leaf: { type: "object", properties: { a: { type: "string" } }, example: { a: "x" } },
        },
      },
    } as never;
    expect(checkDocumentExamples(doc)).toEqual([]);
  });
});
