/**
 * Pin the dialect composition described in docs/dialects.md (#1041).
 * A change here calls for reviewing that description alongside the code.
 */
import { describe, expect, it } from "vitest";
import * as oas30Keywords from "../src/keywords/oas30.js";
import {
  defaultVocabularies,
  oas30Dialect,
  oas30Vocabulary,
  unevaluatedVocabulary,
} from "../src/keywords/vocabulary.js";

const updateDocs =
  "dialect composition changed; review docs/dialects.md and packages/schema/test/oas30-vocabulary.test.ts";

describe("the documented OAS 3.0 dialect composition", () => {
  it("omits only the unevaluated vocabulary from the default stack", () => {
    const active = new Set(oas30Dialect.vocabularies.map((vocabulary) => vocabulary.uri));
    expect(
      defaultVocabularies.filter((vocabulary) => !active.has(vocabulary.uri)),
      updateDocs,
    ).toEqual([unevaluatedVocabulary]);
  });

  it("registers exactly the keyword overrides described by the type and bound rules", () => {
    const groups = {
      nullableType: ["type", "nullable"],
      booleanBounds: ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum"],
    };
    const names = oas30Vocabulary.keywords.map((definition) => definition.keyword).sort();
    expect(names, updateDocs).toEqual(Object.values(groups).flat().sort());

    const exported = Object.values(oas30Keywords).filter((value) => typeof value === "object");
    expect(names, updateDocs).toEqual(exported.map((definition) => definition.keyword).sort());
    for (const definition of exported) {
      expect(
        oas30Vocabulary.keywords.find((entry) => entry.keyword === definition.keyword),
        updateDocs,
      ).toBe(definition);
    }
  });

  it("places each override before the shared definition it replaces", () => {
    const definitions = oas30Dialect.vocabularies.flatMap((vocabulary) => vocabulary.keywords);
    for (const override of oas30Vocabulary.keywords) {
      expect(
        definitions.find((definition) => definition.keyword === override.keyword),
        updateDocs,
      ).toBe(override);
    }
  });
});
