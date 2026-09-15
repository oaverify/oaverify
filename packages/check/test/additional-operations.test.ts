import { describe, expect, it } from "vitest";
import { checkDocumentExamples } from "@oaverify/internal-validator";
import { createMemoryReader, loadSpec, lintResolvedSpec } from "@oaverify/internal-spec";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkDocumentFormats, KNOWN_FORMATS } from "../src/format-check.js";
import { checkDocumentRedos } from "../src/redos-check.js";
import { checkSpec } from "../src/check.js";
import { selectionForClasses } from "../src/selection.js";

const operation = () => ({
  tags: ["search"],
  security: [{ auth: [] }],
  parameters: [{ name: "q", in: "query", schema: { type: "string", format: "iban" } }],
  requestBody: {
    content: {
      "application/json": {
        schema: { type: "string", pattern: "^(a+)+$" },
        example: 42,
      },
    },
  },
  responses: { "200": { description: "ok" } },
});

function document(item: unknown): OpenAPIDocument {
  return {
    openapi: "3.2.0",
    info: { title: "T", version: "1" },
    paths: { "/a": item },
    tags: [{ name: "search" }],
    components: { securitySchemes: { auth: { type: "http", scheme: "bearer" } } },
  } as OpenAPIDocument;
}

describe("additionalOperations document checks (#1052)", () => {
  it.each(["path", "webhook", "callback", "component"])("walks a %s Path Item", (position) => {
    const item = { additionalOperations: { "SEARCH~": operation() } };
    const doc = document(position === "path" ? item : {});
    let pointer = "/paths/~1a";
    if (position === "webhook") {
      doc.webhooks = { hook: item } as never;
      pointer = "/webhooks/hook";
    } else if (position === "callback") {
      doc.paths = { "/a": { post: { callbacks: { cb: { expression: item } } } } } as never;
      pointer = "/paths/~1a/post/callbacks/cb/expression";
    } else if (position === "component") {
      doc.components!.pathItems = { P: item } as never;
      pointer = "/components/pathItems/P";
    }
    const at = `${pointer}/additionalOperations/SEARCH~0`;
    expect(checkDocumentFormats(doc, KNOWN_FORMATS).map((f) => f.pointer)).toEqual([
      `${at}/parameters/0/schema/format`,
    ]);
    expect(checkDocumentExamples(doc).map((f) => f.pointer)).toEqual([
      `${at}/requestBody/content/application~1json/example`,
    ]);
    expect(checkDocumentRedos(doc).map((f) => f.pointer)).toEqual([
      `${at}/requestBody/content/application~1json/schema/pattern`,
    ]);
  });

  it("counts security and tags as used, and checks path parameter declarations", () => {
    const doc = document({ additionalOperations: { SEARCH: operation() } });
    doc.paths = { "/a/{id}": doc.paths!["/a"]! };
    expect(lintResolvedSpec(doc).map((f) => [f.code, f.pointer])).toEqual([
      ["path-param-undeclared", "/paths/~1a~1{id}/additionalOperations/SEARCH"],
    ]);
  });

  it.each([null, [], 7, { SEARCH: null }, { SEARCH: [] }])(
    "leaves malformed containers to conformance: %j",
    (additionalOperations) => {
      const doc = document({ additionalOperations });
      expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([]);
      expect(checkDocumentExamples(doc)).toEqual([]);
      expect(checkDocumentRedos(doc)).toEqual([]);
      expect(() => lintResolvedSpec(doc)).not.toThrow();
    },
  );

  it("resolves external schemas and preserves source locations through the composed check", async () => {
    const op = operation();
    op.parameters = [{ name: "q", in: "query", schema: { $ref: "./shared.json" } }] as never;
    const doc = document({ additionalOperations: { SEARCH: op } });
    const resolved = await loadSpec({
      entry: "entry.json",
      reader: createMemoryReader(
        new Map<string, unknown>([
          ["entry.json", doc],
          ["shared.json", { type: "string", format: "iban" }],
        ]),
      ),
      provenance: true,
    });
    const finding = checkSpec(resolved, { findings: selectionForClasses(["schema"]) }).find(
      (f) => f.code === "format-not-validated",
    );
    expect(finding).toBeDefined();
    expect(finding?.target?.source?.uri).toContain("shared.json");
  });

  it("does not treat example data as operations", () => {
    const doc = document({ get: { responses: { "200": { description: "ok" } } } });
    doc.components!.schemas = {
      Data: { examples: [{ additionalOperations: { SEARCH: operation() } }] },
    };
    expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([]);
    expect(checkDocumentRedos(doc)).toEqual([]);
    expect(
      lintResolvedSpec(doc).some((f) => f.pointer === "/components/securitySchemes/auth"),
    ).toBe(true);
  });
});
