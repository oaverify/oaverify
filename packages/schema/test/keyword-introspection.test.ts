import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  jsonSchemaDialect,
  keywordDefinitions,
  oas30Dialect,
  oas30MaximumKeyword,
  oas30TypeKeyword,
  openapi31Dialect,
  schemaUsesUnevaluated,
  typeKeyword,
  unevaluatedPropertiesKeyword,
} from "../src/index.js";

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

  it("includes the unevaluated vocabulary in 2020-12 but not in 3.0", () => {
    expect(keywordDefinitions(jsonSchemaDialect).has("unevaluatedProperties")).toBe(true);
    expect(keywordDefinitions(openapi31Dialect).has("unevaluatedProperties")).toBe(true);
    expect(keywordDefinitions(oas30Dialect).has("unevaluatedProperties")).toBe(false);
  });

  it("mirrors the compiler's first-wins precedence: 3.0 overrides win", () => {
    // oas30Vocabulary sits ahead of the standard validation vocabulary
    // in the 3.0 stack, so its `type` / `maximum` flavours win dispatch.
    const kw = keywordDefinitions(oas30Dialect);
    expect(kw.get("type")).toBe(oas30TypeKeyword);
    expect(kw.get("maximum")).toBe(oas30MaximumKeyword);
    // The default dialect keeps the 2020-12 `type`.
    expect(keywordDefinitions(jsonSchemaDialect).get("type")).toBe(typeKeyword);
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
