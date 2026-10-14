import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { walkDocumentSchemas } from "../src/document-walk.js";

/** Pointers of every schema root the walk visits, in visit order. */
function roots(document: unknown): string[] {
  const out: string[] = [];
  walkDocumentSchemas(document as OpenAPIDocument, {
    onSchemaRoot: (_schema, pointer) => out.push(pointer),
  });
  return out;
}

const base = { openapi: "3.1.0", info: { title: "t", version: "1" } };

describe("walkDocumentSchemas follows non-schema references (#1242)", () => {
  it("visits an object stitched under x-oaverify-externals, at its own pointer", () => {
    const doc = {
      ...base,
      paths: {
        "/h": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: { X: { $ref: "#/x-oaverify-externals/ext.json" } },
              },
            },
          },
        },
      },
      "x-oaverify-externals": { "ext.json": { schema: { type: "string" } } },
    };
    expect(roots(doc)).toEqual(["/x-oaverify-externals/ext.json/schema"]);
  });

  it("visits a definition under components once, however many refs reach it", () => {
    const ref = { $ref: "#/components/parameters/P" };
    const doc = {
      ...base,
      paths: { "/a": { get: { parameters: [ref], responses: {} } }, "/b": { parameters: [ref] } },
      components: { parameters: { P: { name: "p", in: "query", schema: { type: "string" } } } },
    };
    expect(roots(doc)).toEqual(["/components/parameters/P/schema"]);
  });

  it("follows a chain to its last hop and every referable kind", () => {
    const doc = {
      ...base,
      paths: {
        "/a": { $ref: "#/x-shared/item" },
      },
      "x-shared": {
        item: {
          post: {
            parameters: [{ $ref: "#/x-shared/hop" }],
            requestBody: { $ref: "#/x-shared/body" },
            responses: { "200": { $ref: "#/x-shared/response" } },
            callbacks: { cb: { $ref: "#/x-shared/callback" } },
          },
        },
        hop: { $ref: "#/x-shared/param" },
        param: { name: "p", in: "query", schema: { title: "param" } },
        body: { content: { "application/json": { $ref: "#/x-shared/media" } } },
        media: { schema: { title: "media" } },
        response: { description: "ok", headers: { H: { schema: { title: "header" } } } },
        callback: { "{$url}": { get: { responses: { "200": { description: "ok" } } } } },
      },
    };
    expect(roots(doc).sort()).toEqual([
      "/x-shared/media/schema",
      "/x-shared/param/schema",
      "/x-shared/response/headers/H/schema",
    ]);
  });

  it("terminates on a reference cycle and skips refs that do not resolve", () => {
    const doc = {
      ...base,
      paths: {
        "/a": { $ref: "#/x-cycle/a" },
        "/b": { $ref: "other.json#/paths/~1b" },
        "/c": { $ref: "#/x-missing" },
      },
      "x-cycle": {
        a: { $ref: "#/x-cycle/b" },
        b: { $ref: "#/x-cycle/a" },
      },
    };
    expect(roots(doc)).toEqual([]);
  });

  it("still visits an object placed at two positions once per position", () => {
    const param = { name: "p", in: "query", schema: { type: "string" } };
    const doc = {
      ...base,
      paths: { "/a": { parameters: [param] }, "/b": { parameters: [param] } },
    };
    expect(roots(doc)).toEqual([
      "/paths/~1a/parameters/0/schema",
      "/paths/~1b/parameters/0/schema",
    ]);
  });
});
