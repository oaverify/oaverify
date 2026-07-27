import { describe, expect, it } from "vitest";
import {
  contentEncodingKeyword,
  contentMediaTypeKeyword,
  contentSchemaKeyword,
  contentVocabulary,
  descriptionKeyword,
  exampleKeyword,
  externalDocsKeyword,
  jsonSchemaDialect,
  metaDataVocabulary,
  oas30Dialect,
  openapi31Dialect,
  openapiMetaDataVocabulary,
  xmlKeyword,
} from "../src/keywords/index.js";
import { compile } from "./helpers.js";

describe("meta-data vocabulary", () => {
  it("registers the seven JSON Schema 2020-12 annotations as annotation: true", () => {
    expect(metaDataVocabulary.keywords).toHaveLength(7);
    for (const kw of metaDataVocabulary.keywords) {
      expect(kw.annotation).toBe(true);
    }
    expect(metaDataVocabulary.keywords.map((k) => k.keyword).sort()).toEqual([
      "default",
      "deprecated",
      "description",
      "examples",
      "readOnly",
      "title",
      "writeOnly",
    ]);
  });

  it("carries the spec's meta-data vocabulary URI", () => {
    expect(metaDataVocabulary.uri).toBe("https://json-schema.org/draft/2020-12/vocab/meta-data");
  });

  it("OpenAPI dialects extend the meta-data set with `example`, `xml`, `externalDocs`", () => {
    expect(openapiMetaDataVocabulary.keywords.map((k) => k.keyword).sort()).toEqual([
      "example",
      "externalDocs",
      "xml",
    ]);
    for (const kw of openapiMetaDataVocabulary.keywords) {
      expect(kw.annotation).toBe(true);
    }
    expect(exampleKeyword.annotation).toBe(true);
    for (const d of [openapi31Dialect, oas30Dialect]) {
      const has = (name: string) =>
        d.vocabularies.some((v) => v.keywords.some((k) => k.keyword === name));
      expect(has("description")).toBe(true);
      expect(has("example")).toBe(true);
      expect(has("xml")).toBe(true);
      expect(has("externalDocs")).toBe(true);
    }
    // jsonSchemaDialect gets the Meta-Data vocab, but NOT the OpenAPI
    // extensions (`example`, `xml`, `externalDocs`).
    const jsHas = (name: string) =>
      jsonSchemaDialect.vocabularies.some((v) => v.keywords.some((k) => k.keyword === name));
    expect(jsHas("description")).toBe(true);
    expect(jsHas("example")).toBe(false);
    expect(jsHas("xml")).toBe(false);
    expect(jsHas("externalDocs")).toBe(false);
  });

  it("is a no-op at runtime: annotation-only schemas accept any input", () => {
    const v = compile({
      title: "X",
      description: "anything",
      default: 42,
      deprecated: true,
      readOnly: true,
      examples: [1, 2, 3],
      "x-ext": "ok",
    } as Record<string, unknown>);
    expect(v.validate(1).valid).toBe(true);
    expect(v.validate("str").valid).toBe(true);
    expect(v.validate(null).valid).toBe(true);
  });

  it("keywords expose annotation: true so the inliner can skip them", () => {
    // The subschema inliner reads kw.annotation to decide which keys
    // don't count as "real" validation keywords. Lock it in explicitly
    // so a refactor can't silently drop the flag.
    expect(descriptionKeyword.annotation).toBe(true);
  });

  it("registers `xml` and `externalDocs` as OpenAPI annotations", () => {
    expect(xmlKeyword.annotation).toBe(true);
    expect(externalDocsKeyword.annotation).toBe(true);
    const v = compile({
      type: "object",
      properties: {
        msg: { type: "string", xml: { name: "Message", attribute: true } },
        ref: { type: "string", externalDocs: { url: "https://example.com/docs" } },
      },
    } as Record<string, unknown>);
    expect(v.validate({ msg: "hi", ref: "x" }).valid).toBe(true);
  });
});

describe("content vocabulary", () => {
  it("registers contentEncoding / contentMediaType / contentSchema as annotation: true", () => {
    expect(contentVocabulary.keywords.map((k) => k.keyword).sort()).toEqual([
      "contentEncoding",
      "contentMediaType",
      "contentSchema",
    ]);
    for (const kw of contentVocabulary.keywords) {
      expect(kw.annotation).toBe(true);
    }
    expect(contentEncodingKeyword.annotation).toBe(true);
    expect(contentMediaTypeKeyword.annotation).toBe(true);
    expect(contentSchemaKeyword.annotation).toBe(true);
  });

  it("carries the spec's content vocabulary URI", () => {
    expect(contentVocabulary.uri).toBe("https://json-schema.org/draft/2020-12/vocab/content");
  });

  it("appears in every built-in dialect", () => {
    for (const d of [jsonSchemaDialect, openapi31Dialect, oas30Dialect]) {
      const has = (name: string) =>
        d.vocabularies.some((v) => v.keywords.some((k) => k.keyword === name));
      expect(has("contentEncoding")).toBe(true);
      expect(has("contentMediaType")).toBe(true);
      expect(has("contentSchema")).toBe(true);
    }
  });

  it("is a no-op at runtime: content keywords accept any string", () => {
    const v = compile({
      type: "string",
      contentEncoding: "base64",
      contentMediaType: "application/jwt",
      contentSchema: { type: "object", properties: { iss: { type: "string" } } },
    } as Record<string, unknown>);
    // Not actually base64-encoded JWT; oaverify doesn't decode + re-validate.
    expect(v.validate("anything").valid).toBe(true);
    expect(v.validate(123).valid).toBe(false); // type:string still enforced
  });
});
