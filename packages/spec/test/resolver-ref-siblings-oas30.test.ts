import { describe, expect, it } from "vitest";
import type { SyncDocumentReader } from "../src/reader.js";
import { createMemoryReader } from "../src/reader.js";
import { resolveJsonPointer, resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

const info = { title: "X", version: "1" };

function document(version: string, schema: unknown): unknown {
  return {
    openapi: version,
    info,
    paths: {
      "/p": {
        post: {
          requestBody: { content: { "application/json": { schema } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { schemas: { S: { type: "object" } } },
  };
}

function syncReader(sources: Map<string, unknown>): SyncDocumentReader {
  return {
    canRead: (uri) => sources.has(uri),
    read(uri) {
      if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
      return structuredClone(sources.get(uri));
    },
  };
}

async function resolveBoth(sources: Map<string, unknown>, entry = "main.json") {
  const asyncResult = await resolveSpec({ reader: createMemoryReader(sources), entry });
  const syncResult = resolveSpecSync({ reader: syncReader(sources), entry });
  return [asyncResult, syncResult] as const;
}

function bodySchema(document: unknown): Record<string, unknown> {
  return resolveJsonPointer(
    document,
    "/paths/~1p/post/requestBody/content/application~1json/schema",
  ) as Record<string, unknown>;
}

describe("resolveSpec and OAS 3.0 $ref sibling suppression", () => {
  it("does not read external refs inside discarded sibling subtrees", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.0.3", {
          $ref: "#/components/schemas/S",
          properties: { ignored: { $ref: "missing.json" } },
        }),
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      expect(result.sources).toEqual(["main.json"]);
      expect(bodySchema(result.document).properties).toEqual({
        ignored: { $ref: "missing.json" },
      });
    }
  });

  it("still reads external refs inside $ref sibling subtrees under OAS 3.1", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.1.0", {
          $ref: "#/components/schemas/S",
          properties: { loaded: { $ref: "loaded.json" } },
        }),
      ],
      ["loaded.json", { type: "string" }],
    ]);

    for (const result of await resolveBoth(sources)) {
      expect(result.sources).toContain("loaded.json");
      const loaded = (bodySchema(result.document).properties as Record<string, { $ref: string }>)
        .loaded;
      expect(loaded?.$ref).toMatch(/^#\/components\/schemas\//);
    }
  });

  it("rejects external schema fragments that enter discarded sibling subtrees", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "schemas.json#/properties/ignored" })],
      [
        "schemas.json",
        {
          $ref: "#/$defs/S",
          properties: { ignored: { type: "string" } },
          $defs: { S: { type: "object" } },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external OpenAPI document fragments that enter discarded sibling subtrees", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.0.3", { $ref: "defs.json#/components/schemas/Wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          openapi: "3.0.3",
          info,
          paths: {},
          components: {
            schemas: {
              Wrapper: {
                $ref: "#/components/schemas/S",
                properties: { ignored: { type: "string" } },
              },
              S: { type: "object" },
            },
          },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external components-only fragments that enter discarded sibling subtrees", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.0.3", { $ref: "defs.json#/components/schemas/Wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          components: {
            schemas: {
              Wrapper: {
                $ref: "#/components/schemas/S",
                properties: { ignored: { type: "string" } },
              },
              S: { type: "object" },
            },
          },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external schema-map fragments that enter discarded sibling subtrees", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/Wrapper/properties/ignored" })],
      [
        "defs.json",
        {
          Wrapper: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external schema-map fragments whose first segment is a schema keyword", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/type/properties/ignored" })],
      [
        "defs.json",
        {
          type: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external schema-map fragments whose first segment is an annotation keyword", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/default/properties/ignored" })],
      [
        "defs.json",
        {
          default: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("rejects external schema-map fragments whose first segment is a subschema map keyword", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/properties/properties/ignored" })],
      [
        "defs.json",
        {
          properties: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("does not treat a schema-map entry named $ref as a direct schema ref", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/Wrapper" })],
      [
        "defs.json",
        {
          $ref: { type: "string" },
          Wrapper: { type: "object" },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("object");
    }
  });

  it("does not treat arbitrary direct-schema data as a components-only schema map", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.0.3", { $ref: "defs.json#/components/schemas/Wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          type: "object",
          components: {
            schemas: {
              Wrapper: {
                $ref: "#/S",
                properties: { ignored: { type: "string" } },
              },
            },
          },
          S: { type: "object" },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });

  it("does not treat arbitrary direct-schema data as a top-level schema map", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/example/properties/ignored" })],
      [
        "defs.json",
        {
          type: "object",
          example: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });

  it("does not treat a direct-schema properties map with a $ref property as ref siblings", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.0.3", { $ref: "defs.json#/properties/foo" })],
      [
        "defs.json",
        {
          properties: {
            $ref: { type: "string" },
            foo: { type: "number" },
          },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("number");
    }
  });

  it("does not treat a valid direct-schema properties map as a top-level schema map", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.0.3", { $ref: "defs.json#/properties/wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          type: "object",
          properties: {
            wrapper: {
              $ref: "#/$defs/S",
              properties: { ignored: { type: "string" } },
            },
          },
          $defs: { S: { type: "object" } },
        },
      ],
    ]);

    await expect(
      resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" }),
    ).rejects.toThrow(/OAS 3\.0 \$ref sibling/);
    expect(() => resolveSpecSync({ reader: syncReader(sources), entry: "main.json" })).toThrow(
      /OAS 3\.0 \$ref sibling/,
    );
  });

  it("still resolves the same external schema fragment under OAS 3.1", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.1.0", { $ref: "schemas.json#/properties/ignored" })],
      [
        "schemas.json",
        {
          $ref: "#/$defs/S",
          properties: { ignored: { type: "string" } },
          $defs: { S: { type: "object" } },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });

  it("still resolves the same external components-only fragment under OAS 3.1", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.1.0", { $ref: "defs.json#/components/schemas/Wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          components: {
            schemas: {
              Wrapper: {
                $ref: "#/components/schemas/S",
                properties: { ignored: { type: "string" } },
              },
              S: { type: "object" },
            },
          },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });

  it("still resolves the same external schema-map fragment under OAS 3.1", async () => {
    const sources = new Map<string, unknown>([
      ["main.json", document("3.1.0", { $ref: "defs.json#/Wrapper/properties/ignored" })],
      [
        "defs.json",
        {
          Wrapper: {
            $ref: "#/S",
            properties: { ignored: { type: "string" } },
          },
          S: { type: "object" },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });

  it("still resolves the same external OpenAPI document fragment under OAS 3.1", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        document("3.1.0", { $ref: "defs.json#/components/schemas/Wrapper/properties/ignored" }),
      ],
      [
        "defs.json",
        {
          openapi: "3.1.0",
          info,
          paths: {},
          components: {
            schemas: {
              Wrapper: {
                $ref: "#/components/schemas/S",
                properties: { ignored: { type: "string" } },
              },
              S: { type: "object" },
            },
          },
        },
      ],
    ]);

    for (const result of await resolveBoth(sources)) {
      const schemaRef = bodySchema(result.document).$ref;
      expect(schemaRef).toMatch(/^#\/components\/schemas\//);
      const target = resolveJsonPointer(result.document, (schemaRef as string).slice(1)) as Record<
        string,
        unknown
      >;
      expect(target.type).toBe("string");
    }
  });
});
