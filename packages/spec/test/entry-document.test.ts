import { describe, expect, it } from "vitest";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { loadSpecSync } from "../src/load.js";
import { resolveSpec } from "../src/resolver.js";

/**
 * An OpenAPI document is an object. Nothing asserted that, so a spec
 * that parsed to something else was handed back as though it were one:
 * `loadSpecSync` on an empty or comment-only YAML file answered
 * `{ document: null }` and threw nothing, and the failure surfaced much
 * later inside `createValidator` looking unrelated (#850).
 *
 * Only the entry is constrained. A `$ref` target may legitimately be
 * another shape, and the position consuming it reports a better error
 * than this layer could.
 */
const syncReader = (docs: Record<string, unknown>): SyncDocumentReader => ({
  canRead: (uri) => Object.hasOwn(docs, uri),
  read: (uri) => docs[uri],
});

// Hand-rolled rather than `createMemoryReader`, which treats a string
// value as source text to parse and so answers its own error before the
// entry assertion is reached.
const asyncReader = (docs: Record<string, unknown>): DocumentReader => ({
  canRead: (uri) => Object.hasOwn(docs, uri),
  read: (uri) => Promise.resolve(docs[uri]),
});

const valid = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {},
};

describe("the entry document must be an object (#850)", () => {
  describe.each([
    ["null", null, /not an OpenAPI document/],
    ["a bare string", "hello", /not an OpenAPI document/],
    ["a number", 42, /not an OpenAPI document/],
    ["a boolean", true, /not an OpenAPI document/],
    ["an array", [{ openapi: "3.1.0" }], /not an OpenAPI document/],
  ])("%s", (_label, document, pattern) => {
    it("is refused by loadSpecSync, naming the entry", () => {
      expect(() =>
        loadSpecSync({ reader: syncReader({ "spec.yaml": document }), entry: "spec.yaml" }),
      ).toThrow(pattern);
    });

    it("is refused by resolveSpec, naming the entry", async () => {
      await expect(
        resolveSpec({ reader: asyncReader({ "spec.yaml": document }), entry: "spec.yaml" }),
      ).rejects.toThrow(pattern);
    });
  });

  it("names the entry in the message, so the reader knows which file", () => {
    expect(() =>
      loadSpecSync({ reader: syncReader({ "openapi.yaml": null }), entry: "openapi.yaml" }),
    ).toThrow(/openapi\.yaml/);
  });

  it("says what it got, not only what it wanted", () => {
    expect(() =>
      loadSpecSync({ reader: syncReader({ "spec.yaml": "hello" }), entry: "spec.yaml" }),
    ).toThrow(/got a string/);
  });

  it("catches a JSON entry whose content is null, which no reader refuses", () => {
    // `JSON.parse("null")` succeeds, so the reader layer has nothing to
    // say here and this assertion is the only thing standing between a
    // null entry and `{ document: null }`.
    expect(() =>
      loadSpecSync({ reader: syncReader({ "spec.json": null }), entry: "spec.json" }),
    ).toThrow(/spec\.json is not an OpenAPI document/);
  });

  it("still loads a valid document", () => {
    const result = loadSpecSync({ reader: syncReader({ "spec.yaml": valid }), entry: "spec.yaml" });
    expect(result.document.openapi).toBe("3.1.0");
  });

  it("leaves a non-object $ref target alone, which is not the entry", async () => {
    // A boolean schema is a legal target. The constraint is on the
    // entry, not on everything a spec reaches.
    const { document } = await resolveSpec({
      reader: asyncReader({
        "spec.yaml": {
          ...valid,
          paths: {
            "/a": {
              post: {
                requestBody: { content: { "application/json": { schema: { $ref: "any.json" } } } },
                responses: { "204": { description: "ok" } },
              },
            },
          },
        },
        "any.json": true,
      }),
      entry: "spec.yaml",
    });

    expect(document).toBeTypeOf("object");
  });
});
