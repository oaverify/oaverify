import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";
import { createMemoryReader } from "../src/reader.js";
import { loadSpec, loadSpecSync } from "../src/load.js";

function document(overrides: Record<string, unknown> = {}): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Stitched", version: "1" },
    paths: {},
    ...overrides,
  } as OpenAPIDocument;
}

const unused = (doc: OpenAPIDocument) =>
  lintResolvedSpec(doc)
    .filter((finding) => finding.code === "unused-component")
    .map((finding) => finding.pointer);

describe("unused-component through stitched content", () => {
  it.each([false, true])("follows a resolved response-header schema (sync=%s)", async (sync) => {
    const files = new Map<string, unknown>([
      [
        "entry.json",
        document({
          paths: { "/h": { get: { responses: { "200": { $ref: "lib.json#/Resp" } } } } },
        }),
      ],
      [
        "lib.json",
        {
          Resp: { description: "ok", headers: { "X-Rate": { $ref: "#/Rate" } } },
          Rate: { schema: { $ref: "#/Count" } },
          Count: { type: "integer" },
        },
      ],
    ]);
    const loaded = sync
      ? loadSpecSync({
          entry: "entry.json",
          reader: { canRead: (uri) => files.has(uri), read: (uri) => files.get(uri) },
          lint: true,
        })
      : await loadSpec({ entry: "entry.json", reader: createMemoryReader(files), lint: true });
    expect(loaded.document.components?.schemas).toHaveProperty("lib_Count");
    expect(loaded.document).toHaveProperty("x-oaverify-externals");
    expect(loaded.specHygieneIssues.filter((f) => f.code === "unused-component")).toEqual([]);
    expect(unused(loaded.document)).toEqual([]);
  });

  it("follows chains and cycles only from reachable stitches", () => {
    const doc = document({
      paths: { "/h": { get: { responses: { "200": { $ref: "#/x-oaverify-externals/first" } } } } },
      "x-oaverify-externals": {
        first: { description: "ok", headers: { Rate: { $ref: "#/x-oaverify-externals/second" } } },
        second: {
          schema: { $ref: "#/components/schemas/Count" },
          again: { $ref: "#/x-oaverify-externals/first" },
        },
        orphan: { schema: { $ref: "#/components/schemas/Dead" } },
      },
      components: { schemas: { Count: { type: "integer" }, Dead: { type: "string" } } },
    });
    expect(unused(doc)).toEqual(["/components/schemas/Dead"]);
  });

  it("keeps a stitch reached only from an unused component unreachable", () => {
    const doc = document({
      components: {
        responses: { DeadResponse: { $ref: "#/x-oaverify-externals/response" } },
        schemas: { Dead: { type: "integer" } },
      },
      "x-oaverify-externals": {
        response: {
          description: "ok",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Dead" } },
          },
        },
      },
    });
    expect(unused(doc).sort()).toEqual([
      "/components/responses/DeadResponse",
      "/components/schemas/Dead",
    ]);
  });

  it("follows stitches reached from components and webhooks", () => {
    const doc = document({
      webhooks: {
        incoming: { post: { responses: { "200": { $ref: "#/components/responses/Response" } } } },
      },
      components: {
        responses: { Response: { $ref: "#/x-oaverify-externals/response" } },
        schemas: { Count: { type: "integer" } },
      },
      "x-oaverify-externals": {
        response: {
          description: "ok",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Count" } },
          },
        },
      },
    });
    expect(unused(doc)).toEqual([]);
  });

  it.each(["a b.json", "a%20b.json", "a/b~c.json"])("decodes a stitch pointer once: %s", (name) => {
    const token = encodeURIComponent(name.replace(/~/g, "~0").replace(/\//g, "~1"));
    const doc = document({
      paths: {
        "/h": { get: { responses: { "200": { $ref: `#/x-oaverify-externals/${token}` } } } },
      },
      "x-oaverify-externals": { [name]: { schema: { $ref: "#/components/schemas/Count" } } },
      components: { schemas: { Count: { type: "integer" } } },
    });
    expect(unused(doc)).toEqual([]);
  });

  it("visits only the referenced fragment within a stitched file", () => {
    const doc = document({
      paths: {
        "/h": { get: { responses: { "200": { $ref: "#/x-oaverify-externals/lib.json/Used" } } } },
      },
      "x-oaverify-externals": {
        "lib.json": {
          Used: { schema: { $ref: "#/components/schemas/Count" } },
          Unused: { schema: { $ref: "#/components/schemas/Dead" } },
        },
      },
      components: { schemas: { Count: { type: "integer" }, Dead: { type: "integer" } } },
    });
    expect(unused(doc)).toEqual(["/components/schemas/Dead"]);
  });

  it("ignores missing stitches and non-local references", () => {
    const doc = document({
      paths: {
        "/h": {
          get: {
            responses: {
              "200": { $ref: "#/x-oaverify-externals/Missing" },
              "201": { $ref: "other.json#/x-oaverify-externals/Dead" },
            },
          },
        },
      },
      "x-oaverify-externals": { Dead: { schema: { $ref: "#/components/schemas/Dead" } } },
      components: { schemas: { Dead: { type: "integer" } } },
    });
    expect(unused(doc)).toEqual(["/components/schemas/Dead"]);
  });
});
