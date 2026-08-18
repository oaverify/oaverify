import { describe, expect, it } from "vitest";
import type { SyncDocumentReader } from "../src/reader.js";
import { createMemoryReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

/**
 * Both resolvers against the mixed-map subschema position.
 *
 * `dependencies` holds a subschema at some entries and an array of
 * property names at others. The resolvers classified a key with
 * `isSubschemaKey`, which deliberately answers `false` for a position
 * whose values disagree, so `dependencies` was not recognised as a
 * schema position at all: an external `$ref` written inside one was
 * never hoisted, the file it named was never loaded, and the compiler
 * then failed on an unresolvable ref (#859).
 *
 * Every case pairs the two keywords, `dependentSchemas` as the control.
 */
type Mixed = "dependentSchemas" | "dependencies";

const KEYWORDS: readonly Mixed[] = ["dependentSchemas", "dependencies"];

const docWith = (schema: Record<string, unknown>) => ({
  openapi: "3.1.0",
  info: { title: "X", version: "1" },
  paths: {
    "/a": {
      post: {
        requestBody: { content: { "application/json": { schema } } },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const files = (schema: Record<string, unknown>) =>
  new Map<string, unknown>([
    ["main.json", docWith(schema)],
    ["ext.json", { type: "string", minLength: 3 }],
  ]);

const resolveAsync = (schema: Record<string, unknown>) =>
  resolveSpec({ reader: createMemoryReader(files(schema)), entry: "main.json" });

const syncReader = (schema: Record<string, unknown>): SyncDocumentReader => {
  const sources = files(schema);
  return {
    canRead: (uri) => sources.has(uri),
    read: (uri) => structuredClone(sources.get(uri)),
  };
};

const resolveSync = (schema: Record<string, unknown>) =>
  resolveSpecSync({ reader: syncReader(schema), entry: "main.json" });

/** The schema the request body ends up carrying, after resolution. */
function bodySchema(document: unknown): Record<string, unknown> {
  const at = (value: unknown, key: string): Record<string, unknown> =>
    (value as Record<string, Record<string, unknown>>)[key] as Record<string, unknown>;

  const post = at(at(at(document, "paths"), "/a"), "post");
  const content = at(at(post, "requestBody"), "content");
  return at(at(content, "application/json"), "schema");
}

describe("resolving inside a mixed-map position (#859)", () => {
  describe.each(["async", "sync"] as const)("%s resolver", (mode) => {
    const resolve = (schema: Record<string, unknown>) =>
      mode === "async" ? resolveAsync(schema) : Promise.resolve(resolveSync(schema));

    it.each(KEYWORDS)("loads a file named by an external $ref under %s", async (keyword) => {
      const { sources } = await resolve({ [keyword]: { x: { $ref: "ext.json" } } });
      expect(sources).toContain("ext.json");
    });

    it.each(KEYWORDS)("hoists that target and leaves an internal ref under %s", async (keyword) => {
      const { document } = await resolve({ [keyword]: { x: { $ref: "ext.json" } } });
      const at = (bodySchema(document)[keyword] as Record<string, { $ref?: string }>).x;

      // Hoisted rather than inlined, so the schema keeps an address.
      expect(at?.$ref).toMatch(/^#\/components\/schemas\//);
    });

    it("leaves an array entry under dependencies as a property-name list", async () => {
      // The hazard of teaching the resolver this position: `["$ref"]`
      // is a list of property names, and one of them is spelled like a
      // keyword. Walking it as a schema would rewrite it.
      const { document } = await resolve({
        properties: { x: {}, $ref: {} },
        dependencies: { x: ["$ref"] },
      });

      expect((bodySchema(document).dependencies as Record<string, unknown>).x).toEqual(["$ref"]);
    });

    it("resolves a subschema entry beside an array entry in one map", async () => {
      const { document, sources } = await resolve({
        dependencies: { needsY: ["y"], withSchema: { $ref: "ext.json" } },
      });
      const deps = bodySchema(document).dependencies as Record<string, unknown>;

      expect(sources).toContain("ext.json");
      expect(deps.needsY).toEqual(["y"]);
      expect(deps.withSchema).toMatchObject({ $ref: expect.stringMatching(/^#\/components/) });
    });
  });
});
