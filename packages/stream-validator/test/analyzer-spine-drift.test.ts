import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { classify } from "../src/classifier/index.js";
import { nodeKind as analyzerNodeKind } from "../src/analyzer/analyze.js";
import { SpineValidator } from "../src/spine/spine.js";

/**
 * Drift backstop for the analyzer/spine kind agreement.
 *
 * The reported peak-buffer budget is only trustworthy if the analyzer
 * decides stream/tee/buffer exactly as the engine does. The analyzer
 * mirrors the spine's `computeKind` rather than reading the classifier's
 * `strategyOf` alone, because `strategyOf` marks `contains`, asserting
 * `format`, `uniqueItems`, and complex `enum` / `const` as forward or
 * scalar while the spine still materializes them. Using `strategyOf`
 * alone under-reports buffering, and under-reporting a buffer budget is
 * the failure that matters.
 *
 * Nothing structural keeps the two in step, so this enumerates a schema
 * per trigger and asserts they agree. Changing one fails here until the
 * other is consciously updated.
 *
 * The analyzer stays engine-free (importing only the analyzer must not
 * pull the engine); that constraint is on the analyzer's own imports, so
 * a test importing both sides is fine. Both entry points are reached
 * through deep source paths and neither is package public API.
 */

/** Feed both sides the same classification, then compare their verdicts. */
function kinds(schema: SchemaObject, formatAsserts: boolean): { analyzer: string; spine: string } {
  const cls = classify(schema, {});
  const spine = new SpineValidator(schema as SchemaOrBoolean, {
    strategyOf: cls.strategyOf,
    assertsFormat: formatAsserts,
  });
  // `nodeKind` is private on the spine (memoized wrapper over
  // `computeKind`). Reached by cast rather than by widening the engine's
  // surface for a test; a rename breaks this test loudly, which is the
  // point of a drift backstop.
  const spineNodeKind = (spine as unknown as { nodeKind(s: SchemaObject): string }).nodeKind.bind(
    spine,
  );
  return {
    analyzer: analyzerNodeKind(schema, cls, formatAsserts),
    spine: spineNodeKind(schema),
  };
}

// One representative schema per kind trigger. The four the analyzer
// documents as strategyOf-invisible (contains, asserting format,
// uniqueItems, complex enum/const) are the load-bearing rows; the rest
// pin the surrounding cases so a change that fixes one by breaking
// another still fails.
const FIXTURES: ReadonlyArray<{
  label: string;
  schema: SchemaObject;
  expected: "stream" | "tee" | "buffer";
  formatAsserts?: boolean;
}> = [
  // Forward: nothing to materialize.
  { label: "bare string", schema: { type: "string" }, expected: "stream" },
  { label: "bounded integer", schema: { type: "integer", minimum: 0 }, expected: "stream" },
  {
    label: "object with scalar properties",
    schema: { type: "object", properties: { a: { type: "string" } } },
    expected: "stream",
  },
  {
    label: "array of scalars",
    schema: { type: "array", items: { type: "string" } },
    expected: "stream",
  },
  { label: "scalar enum", schema: { enum: ["a", "b"] }, expected: "stream" },
  { label: "scalar const", schema: { const: 42 }, expected: "stream" },
  {
    label: "format, dialect does not assert",
    schema: { type: "string", format: "email" },
    expected: "stream",
    formatAsserts: false,
  },

  // Forward composition: concurrent sub-spines.
  { label: "allOf", schema: { allOf: [{ type: "object" }] }, expected: "tee" },
  { label: "anyOf", schema: { anyOf: [{ type: "object" }, { type: "array" }] }, expected: "tee" },
  { label: "oneOf", schema: { oneOf: [{ type: "object" }, { type: "array" }] }, expected: "tee" },
  { label: "not", schema: { not: { type: "null" } }, expected: "tee" },
  // `if` is the composition key both sides read; the partner branch is
  // spelled `else` because a literal `then` property trips
  // unicorn(no-thenable), and `if`/`else` is an equally valid schema.
  {
    label: "if/else",
    schema: { if: { type: "object" }, else: { type: "array" } },
    expected: "tee",
  },

  // The strategyOf-invisible buffer triggers: the reason the analyzer
  // mirrors computeKind instead of reading strategyOf alone.
  {
    label: "contains",
    schema: { type: "array", contains: { type: "string" } },
    expected: "buffer",
  },
  {
    label: "format, dialect asserts",
    schema: { type: "string", format: "email" },
    expected: "buffer",
    formatAsserts: true,
  },
  {
    label: "uniqueItems",
    schema: { type: "array", items: { type: "string" }, uniqueItems: true },
    expected: "buffer",
  },
  {
    label: "complex enum",
    schema: { enum: [{ a: 1 }, { a: 2 }] } as SchemaObject,
    expected: "buffer",
  },
  { label: "complex const", schema: { const: { a: 1 } } as SchemaObject, expected: "buffer" },

  // Buffer triggers the spine names alongside them.
  {
    label: "dependentSchemas",
    schema: {
      type: "object",
      dependentSchemas: { a: { required: ["b"] } },
    } as unknown as SchemaObject,
    expected: "buffer",
  },
  {
    label: "discriminator",
    schema: {
      oneOf: [{ type: "object" }],
      discriminator: { propertyName: "kind" },
    } as unknown as SchemaObject,
    expected: "buffer",
  },
];

describe("analyzer/spine kind agreement", () => {
  for (const { label, schema, expected, formatAsserts = false } of FIXTURES) {
    it(`agrees on ${label}`, () => {
      const { analyzer, spine } = kinds(schema, formatAsserts);
      expect(analyzer, `analyzer nodeKind disagrees with spine computeKind`).toBe(spine);
      // Pin the verdict itself too: without this the test still passes if
      // both sides drift the same way, which would silently move the
      // reported budget.
      expect(analyzer).toBe(expected);
    });
  }

  it("covers every buffer trigger the spine names", () => {
    // Guard against a new trigger landing in computeKind with no fixture
    // here. Bump this list (and add a fixture) when the spine grows one.
    const covered = new Set(FIXTURES.map((f) => f.label));
    for (const required of [
      "contains",
      "dependentSchemas",
      "discriminator",
      "format, dialect asserts",
      "uniqueItems",
      "complex enum",
      "complex const",
    ]) {
      expect(covered.has(required), `missing fixture: ${required}`).toBe(true);
    }
  });
});
