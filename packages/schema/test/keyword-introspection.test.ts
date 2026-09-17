import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  compileSchema,
  containsKeyword,
  CORE_VALIDATION_VOCAB,
  jsonSchemaDialect,
  keywordDefinitions,
  maxContainsKeyword,
  minContainsKeyword,
  oas30Dialect,
  openapi31Dialect,
  schemaUsesUnevaluated,
  typeKeyword,
  unevaluatedPropertiesKeyword,
} from "../src/index.js";

import * as keywords from "../src/keywords/index.js";
import * as oas30Keywords from "../src/keywords/oas30.js";
import {
  defaultVocabularies,
  formatAssertionVocabulary,
  oas30Vocabulary,
  openapiMetaDataVocabulary,
  unevaluatedVocabulary,
} from "../src/keywords/vocabulary.js";

const updateDocs =
  "dialect composition changed; review docs/dialects.md and packages/schema/test/keyword-introspection.test.ts";

describe("contains-bound exports", () => {
  const dialect = {
    id: "test-contains-bounds",
    vocabularies: [
      {
        uri: CORE_VALIDATION_VOCAB,
        keywords: [typeKeyword, containsKeyword, minContainsKeyword, maxContainsKeyword],
      },
    ],
    rules: { refSuppressesSiblings: false },
  };

  it("exports the existing vocabulary definitions through both barrels", () => {
    expect(minContainsKeyword).toBe(keywordDefinitions().get("minContains"));
    expect(maxContainsKeyword).toBe(keywordDefinitions().get("maxContains"));
    expect(keywords.minContainsKeyword).toBe(minContainsKeyword);
    expect(keywords.maxContainsKeyword).toBe(maxContainsKeyword);
  });

  it.each(["minContains", "maxContains"] as const)(
    "rejects malformed %s in a custom dialect",
    (keyword) => {
      for (const value of [-1, 1.5, "2"]) {
        expect(() =>
          compileSchema({ contains: true, [keyword]: value } as SchemaOrBoolean, { dialect }),
        ).toThrow(`keyword "${keyword}" requires a non-negative integer`);
      }
    },
  );

  it("enforces the selected contains bounds in a custom dialect", () => {
    const compiled = compileSchema(
      { contains: { type: "integer" }, minContains: 1, maxContains: 2 },
      { dialect },
    );
    expect(compiled.validate(["x"]).valid).toBe(false);
    expect(compiled.validate([1, "x"]).valid).toBe(true);
    expect(compiled.validate([1, 2, "x"]).valid).toBe(true);
    expect(compiled.validate([1, 2, 3, "x"]).valid).toBe(false);
  });
});

describe("keywordDefinitions", () => {
  it("defaults to the JSON Schema 2020-12 dialect", () => {
    expect(keywordDefinitions()).toBe(keywordDefinitions(jsonSchemaDialect));
  });

  it("memoizes a stable map per dialect", () => {
    expect(keywordDefinitions(oas30Dialect)).toBe(keywordDefinitions(oas30Dialect));
    expect(keywordDefinitions(jsonSchemaDialect)).not.toBe(keywordDefinitions(oas30Dialect));
  });

  it("exposes the built-in keywords keyed by name, with their definitions", () => {
    const kw = keywordDefinitions();
    expect(kw.get("type")).toBe(typeKeyword);
    // A representative sample across vocabularies.
    for (const name of ["properties", "allOf", "format", "items", "$ref", "required"]) {
      expect(kw.has(name)).toBe(true);
      expect(kw.get(name)?.keyword).toBe(name);
    }
  });

  it("surfaces the classification flags off the definition", () => {
    const kw = keywordDefinitions();
    expect(kw.get("properties")?.applicator).toBe(true);
    expect(kw.get("properties")?.evaluates).toEqual({ properties: true });
    expect(kw.get("title")?.annotation).toBe(true);
  });

  it("includes the unevaluated vocabulary in the 2020-12 dialects", () => {
    expect(keywordDefinitions(jsonSchemaDialect).has("unevaluatedProperties")).toBe(true);
    expect(keywordDefinitions(openapi31Dialect).has("unevaluatedProperties")).toBe(true);
  });

  it("dispatches exactly the documented OAS 3.0 overrides", () => {
    const names = oas30Vocabulary.keywords.map((definition) => definition.keyword).sort();
    expect(names, updateDocs).toEqual([
      "exclusiveMaximum",
      "exclusiveMinimum",
      "maximum",
      "minimum",
      "nullable",
      "type",
    ]);
    const exported = Object.values(oas30Keywords).filter(
      (value) => value !== null && typeof value === "object" && "keyword" in value,
    );
    expect(names, updateDocs).toEqual(exported.map((definition) => definition.keyword).sort());
    const definitions = keywordDefinitions(oas30Dialect);
    for (const definition of exported) {
      expect(definitions.get(definition.keyword), updateDocs).toBe(definition);
    }
    expect(keywordDefinitions(jsonSchemaDialect).get("type")).toBe(typeKeyword);
  });

  it("keeps the documented OAS 3.0 vocabulary additions and omission", () => {
    const active = new Set(oas30Dialect.vocabularies.map((vocabulary) => vocabulary.uri));
    const defaults = new Set(defaultVocabularies.map((vocabulary) => vocabulary.uri));
    expect(
      defaultVocabularies.filter((vocabulary) => !active.has(vocabulary.uri)),
      updateDocs,
    ).toEqual([unevaluatedVocabulary]);
    expect(
      oas30Dialect.vocabularies.filter((vocabulary) => !defaults.has(vocabulary.uri)),
      updateDocs,
    ).toEqual([oas30Vocabulary, formatAssertionVocabulary, openapiMetaDataVocabulary]);
    for (const definition of unevaluatedVocabulary.keywords) {
      expect(keywordDefinitions(oas30Dialect).has(definition.keyword), updateDocs).toBe(false);
    }
  });

  it("suppresses ref siblings only in the OAS 3.0 dialect", () => {
    expect(oas30Dialect.rules.refSuppressesSiblings, updateDocs).toBe(true);
    expect(jsonSchemaDialect.rules.refSuppressesSiblings, updateDocs).toBe(false);
    expect(openapi31Dialect.rules.refSuppressesSiblings, updateDocs).toBe(false);
  });

  it("agrees with the dialect's own vocabulary stack (no keyword dropped)", () => {
    const kw = keywordDefinitions(jsonSchemaDialect);
    const names = new Set<string>();
    for (const vocab of jsonSchemaDialect.vocabularies) {
      for (const def of vocab.keywords) names.add(def.keyword);
    }
    expect(new Set(kw.keys())).toEqual(names);
  });
});

describe("schemaUsesUnevaluated", () => {
  const uses = (schema: SchemaOrBoolean) => schemaUsesUnevaluated(schema);

  it("is the definition keyword's name", () => {
    // Sanity: the keyword the predicate gates on is the one we export.
    expect(unevaluatedPropertiesKeyword.keyword).toBe("unevaluatedProperties");
  });

  it("detects unevaluatedProperties / unevaluatedItems at the root", () => {
    expect(uses({ unevaluatedProperties: false })).toBe(true);
    expect(uses({ unevaluatedItems: false })).toBe(true);
  });

  it("detects a use nested behind subschema positions", () => {
    expect(uses({ properties: { a: { unevaluatedProperties: false } } })).toBe(true);
    expect(uses({ allOf: [{ minProperties: 1 }, { unevaluatedItems: true }] })).toBe(true);
    expect(uses({ items: { unevaluatedProperties: false } })).toBe(true);
  });

  it("returns false when nothing uses unevaluated*", () => {
    expect(uses({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
    expect(uses(true)).toBe(false);
    expect(uses(false)).toBe(false);
  });

  it("is cycle-safe over an object graph", () => {
    const cyclic: SchemaOrBoolean = { type: "object" };
    (cyclic as Record<string, unknown>).properties = { self: cyclic };
    expect(uses(cyclic)).toBe(false);
  });

  it("descends $defs structurally but does not resolve $ref strings", () => {
    // $defs is a walked subschema position, so a use there is found by
    // structural descent (not by following the $ref).
    expect(uses({ $ref: "#/$defs/X", $defs: { X: { unevaluatedProperties: false } } })).toBe(true);
    // With the use reachable only by resolving the ref target (no
    // structural descent reaches it), the predicate does not detect it.
    expect(uses({ $ref: "#/$defs/X" })).toBe(false);
  });
});
