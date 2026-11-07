import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

function document(reached: boolean): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    // Referenced paths remain outside the runtime PathItem type (#1059).
    paths: (reached
      ? { "/a": { $ref: "#/components/pathItems/P" } }
      : {}) as OpenAPIDocument["paths"],
    components: {
      pathItems: {
        P: {
          get: {
            security: [{ auth: [] }],
            callbacks: { C: { $ref: "#/components/callbacks/C" } },
            responses: { "200": { $ref: "#/components/responses/R" } },
          },
        },
      },
      callbacks: {
        C: {
          "{$request.query.callback}": {
            post: {
              security: [{ callbackAuth: [] }],
              requestBody: { $ref: "#/components/requestBodies/B" },
              callbacks: { again: { $ref: "#/components/callbacks/C" } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      responses: {
        R: {
          description: "ok",
          content: { "application/json": { schema: { $ref: "#/components/schemas/S" } } },
        },
      },
      requestBodies: { B: { content: { "text/plain": { schema: { type: "string" } } } } },
      schemas: { S: { type: "string" } },
      securitySchemes: {
        auth: { type: "http", scheme: "bearer" },
        callbackAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

describe("component container reachability (#1049)", () => {
  it("follows Path Items, callbacks, security and transitive references through cycles", () => {
    expect(lintResolvedSpec(document(true))).toEqual([]);
  });

  it("keeps unreferenced containers from becoming roots", () => {
    expect(lintResolvedSpec(document(false)).map((issue) => issue.pointer)).toEqual([
      "/components/schemas/S",
      "/components/requestBodies/B",
      "/components/responses/R",
      "/components/securitySchemes/auth",
      "/components/securitySchemes/callbackAuth",
      "/components/pathItems/P",
    ]);
  });

  it("reports an unreferenced components.pathItems entry (#1354)", () => {
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: { "/a": { $ref: "#/components/pathItems/Used" } } as OpenAPIDocument["paths"],
      components: {
        pathItems: {
          Used: { get: { responses: { "200": { description: "ok" } } } },
          Orphan: { get: { responses: { "200": { description: "ok" } } } },
        },
      },
    };
    expect(lintResolvedSpec(doc)).toEqual([
      {
        code: "unused-component",
        pointer: "/components/pathItems/Orphan",
        message: "components.pathItems.Orphan is declared but no operation reaches it",
      },
    ]);
  });

  it("follows a referenced webhook Path Item", () => {
    const doc = document(false);
    doc.webhooks = { hook: { $ref: "#/components/pathItems/P" } };
    expect(lintResolvedSpec(doc)).toEqual([]);
  });

  it("collects security from inline callbacks without treating schema data as operations", () => {
    const doc = document(false);
    const item = doc.components!.pathItems!.P!;
    if ("$ref" in item) throw new Error("expected an inline Path Item");
    doc.paths = { "/a": item };
    item.get!.callbacks = { C: doc.components!.callbacks!.C! };
    doc.components!.schemas!.S = { examples: [{ get: { security: [{ unused: [] }] } }] };
    doc.components!.securitySchemes!.unused = { type: "http", scheme: "bearer" };
    // The Path Item is placed under paths as the same object, which is
    // no reference, so its component entry is unreached.
    expect(lintResolvedSpec(doc).map((issue) => issue.pointer)).toEqual([
      "/components/securitySchemes/unused",
      "/components/pathItems/P",
    ]);
  });
});

describe("OpenAPI 3.2 media type component reachability", () => {
  function mediaTypeDocument(reached: boolean): OpenAPIDocument {
    return {
      openapi: "3.2.0",
      info: { title: "T", version: "1" },
      paths: reached
        ? {
            "/a": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: { "application/json": { $ref: "#/components/mediaTypes/M" } },
                  },
                },
              },
            },
          }
        : {},
      components: {
        mediaTypes: { M: { schema: { $ref: "#/components/schemas/S" } } },
        schemas: { S: { type: "string" } },
      },
    } as OpenAPIDocument;
  }

  it("follows a referenced media type to its schema", () => {
    expect(lintResolvedSpec(mediaTypeDocument(true))).toEqual([]);
  });

  it("keeps an unreferenced media type from rooting its schema", () => {
    expect(lintResolvedSpec(mediaTypeDocument(false))).toMatchObject([
      { code: "unused-component", pointer: "/components/schemas/S" },
    ]);
  });
});
