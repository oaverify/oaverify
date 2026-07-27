import { describe, expect, it } from "vitest";
import {
  jsonSchemaDialect,
  keywordDefinitions,
  oas30Dialect,
  openapi31Dialect,
} from "@oaverify/internal-schema";
import { KEYWORD_CATEGORY } from "../src/classifier/index.js";

/**
 * Drift backstop: every keyword `@oaverify/internal-schema` registers must have a
 * classification in the engine's table. A new keyword (or a new dialect's
 * keyword) upstream fails this test until the engine consciously
 * classifies it, rather than silently mis-streaming. The runtime compile
 * path has its own REJECT backstop for an unclassified keyword; this
 * test catches the drift at build time across every dialect.
 */
describe("classifier keyword drift", () => {
  for (const [label, dialect] of [
    ["jsonSchema2020-12", jsonSchemaDialect],
    ["openapi3.1", openapi31Dialect],
    ["oas3.0", oas30Dialect],
  ] as const) {
    it(`every ${label} keyword has a classification`, () => {
      const unclassified: string[] = [];
      for (const name of keywordDefinitions(dialect).keys()) {
        if (!(name in KEYWORD_CATEGORY)) unclassified.push(name);
      }
      expect(unclassified, `unclassified keywords: ${unclassified.join(", ")}`).toEqual([]);
    });
  }

  it("the table classifies only real registered keywords (no stale entries)", () => {
    // Union of every dialect's keyword names, plus the folded partners
    // (then/else, minContains/maxContains) which the table is allowed to
    // omit but must not misclassify if present.
    const registered = new Set<string>();
    for (const dialect of [jsonSchemaDialect, openapi31Dialect, oas30Dialect]) {
      for (const name of keywordDefinitions(dialect).keys()) registered.add(name);
    }
    const stale = Object.keys(KEYWORD_CATEGORY).filter((k) => !registered.has(k));
    expect(stale, `stale table entries: ${stale.join(", ")}`).toEqual([]);
  });
});
