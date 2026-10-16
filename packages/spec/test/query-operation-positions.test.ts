import { describe, expect, it } from "vitest";
import { HTTP_METHODS, refPositionFor, type OpenAPIDocument } from "@oaverify/internal-core";
import { createMemoryReader, type SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { lintResolvedSpec } from "../src/lint.js";

function document(openapi: string, schema: unknown): OpenAPIDocument {
  return {
    openapi,
    info: { title: "QUERY", version: "1" },
    paths: {
      "/t": {
        query: {
          requestBody: { content: { "application/json": { schema } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as OpenAPIDocument;
}

describe("QUERY operation positions", () => {
  // Written from the specification text, not from HTTP_METHODS, so a
  // method added to that list fails here until it is classified.
  const BASE = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
  const OPERATION_FIELDS = { "3.0": BASE, "3.1": BASE, "3.2": [...BASE, "query"] } as const;

  it("classifies every HTTP method in some version", () => {
    expect([...HTTP_METHODS].sort()).toEqual(
      [...new Set(Object.values(OPERATION_FIELDS).flat())].sort(),
    );
  });

  it.each(["3.0", "3.1", "3.2"] as const)(
    "recognizes exactly the operation fields OpenAPI %s defines",
    (version) => {
      const expected: readonly string[] = OPERATION_FIELDS[version];
      for (const method of HTTP_METHODS) {
        expect(refPositionFor(version, "pathItem", method), method).toEqual(
          expected.includes(method)
            ? { kind: "operation", arity: "one", refable: false }
            : undefined,
        );
      }
    },
  );

  it.each(["sync", "async"])(
    "hoists an external schema in QUERY through the %s resolver",
    async (mode) => {
      const sources = new Map<string, unknown>([
        ["main.json", document("3.2.0", { $ref: "ext.json#/Thing" })],
        ["ext.json", { Thing: { type: "integer", minimum: 2 } }],
      ]);
      const reader: SyncDocumentReader = {
        canRead: (uri) => sources.has(uri),
        read: (uri) => structuredClone(sources.get(uri)),
      };
      const resolved =
        mode === "sync"
          ? resolveSpecSync({ reader, entry: "main.json" })
          : await resolveSpec({ reader: createMemoryReader(sources), entry: "main.json" });
      expect(resolved.sources).toEqual(["main.json", "ext.json"]);
      expect(resolved.document.paths?.["/t"]?.query?.requestBody).toEqual({
        content: { "application/json": { schema: { $ref: "#/components/schemas/ext_Thing" } } },
      });
      expect(resolved.document.components?.schemas?.ext_Thing).toEqual({
        type: "integer",
        minimum: 2,
      });
    },
  );

  it.each(["3.0.3", "3.1.0", "3.2.0"])(
    "discovers QUERY schemas only where %s defines the field",
    async (openapi) => {
      const doc = document(openapi, { $defs: { Unused: false } });
      expect(
        lintResolvedSpec(doc)
          .filter((issue) => issue.code === "unreachable-defs")
          .map((issue) => issue.pointer),
      ).toEqual(
        openapi === "3.2.0"
          ? ["/paths/~1t/query/requestBody/content/application~1json/schema/$defs/Unused"]
          : [],
      );
      if (openapi !== "3.2.0") {
        const literal = document(openapi, { $ref: "missing.json#/Thing" });
        const { document: resolved, sources } = await resolveSpec({
          reader: createMemoryReader(new Map([["main.json", literal]])),
          entry: "main.json",
        });
        expect(resolved).toEqual(literal);
        expect(sources).toEqual(["main.json"]);
      }
    },
  );
});
