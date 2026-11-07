import { expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { listIgnoredHeaders } from "../src/ignored-headers.js";

it("reports ignored headers beside each Path Item reference once per route (#1290)", () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/p": { $ref: "#/x-items/Mid" } },
    "x-items": {
      Mid: {
        $ref: "#/x-items/Final",
        get: { parameters: [{ name: "Accept", in: "header", schema: { type: "string" } }] },
      },
      Final: {
        $ref: "#/x-items/Mid",
        post: { parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } }] },
      },
    },
  } as unknown as OpenAPIDocument;
  expect(listIgnoredHeaders(doc).map((entry) => entry.pointer)).toEqual([
    "/x-items/Mid/get/parameters/0",
    "/x-items/Final/post/parameters/0",
  ]);
});

it("reports parameters inherited from an intermediate hop with no own operations", () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/p": { $ref: "#/x-items/Mid" },
      "/unused": { parameters: [{ name: "Accept", in: "header" }] },
    },
    "x-items": {
      Mid: {
        $ref: "#/x-items/Final",
        parameters: [{ name: "Accept", in: "header", schema: { type: "string" } }],
      },
      Final: { get: { responses: {} } },
    },
  } as unknown as OpenAPIDocument;
  expect(listIgnoredHeaders(doc).map((entry) => entry.pointer)).toEqual([
    "/x-items/Mid/parameters/0",
  ]);
});

it("walks long Path Item reference chains without recursive stack growth", () => {
  const items: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i++) items[String(i)] = { $ref: `#/x-items/${i + 1}` };
  items["5000"] = { get: { parameters: [{ name: "Accept", in: "header" }] } };
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/p": { $ref: "#/x-items/0" } },
    "x-items": items,
  } as unknown as OpenAPIDocument;
  expect(listIgnoredHeaders(doc).map((entry) => entry.pointer)).toEqual([
    "/x-items/5000/get/parameters/0",
  ]);
});

it("reports an independent callback into a later hop for both reaching operations", () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/p": {
        $ref: "#/x-items/B",
        get: {
          responses: {},
          callbacks: { cb: { "{$request.query.url}": { $ref: "#/x-items/B" } } },
        },
      },
    },
    "x-items": { B: { post: { parameters: [{ name: "Accept", in: "header" }], responses: {} } } },
  } as unknown as OpenAPIDocument;
  expect(listIgnoredHeaders(doc).map((entry) => entry.where)).toEqual([
    "POST callback cb {$request.query.url} of GET /p",
    "POST /p",
  ]);
});

it("reports a declaration under an additionalOperations entry like a fixed method's (#1353)", () => {
  const doc = {
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths: {
      "/p": {
        parameters: [{ name: "Accept", in: "header" }],
        additionalOperations: {
          Purge: {
            parameters: [{ name: "Content-Type", in: "header" }],
            responses: { "200": { description: "ok", headers: { "Content-Type": {} } } },
            callbacks: {
              cb: {
                "{$request.query.url}": {
                  post: { parameters: [{ name: "Authorization", in: "header" }], responses: {} },
                },
              },
            },
          },
        },
      },
      "/viaRef": { $ref: "#/components/pathItems/P" },
    },
    webhooks: {
      hook: {
        additionalOperations: { Notify: { parameters: [{ name: "Accept", in: "header" }] } },
      },
    },
    components: {
      pathItems: {
        P: { additionalOperations: { "a/b": { parameters: [{ name: "Accept", in: "header" }] } } },
      },
    },
  } as unknown as OpenAPIDocument;
  expect(
    listIgnoredHeaders(doc).map(({ pointer, where, definitionPointer }) => [
      pointer,
      where,
      definitionPointer,
    ]),
  ).toEqual([
    ["/paths/~1p/parameters/0", "path item /p", undefined],
    ["/paths/~1p/additionalOperations/Purge/parameters/0", "Purge /p", undefined],
    [
      "/paths/~1p/additionalOperations/Purge/responses/200/headers/Content-Type",
      "Purge /p",
      undefined,
    ],
    [
      "/paths/~1p/additionalOperations/Purge/callbacks/cb/{$request.query.url}/post/parameters/0",
      "POST callback cb {$request.query.url} of Purge /p",
      undefined,
    ],
    [
      "/components/pathItems/P/additionalOperations/a~1b/parameters/0",
      "a/b /viaRef",
      "/components/pathItems/P/additionalOperations/a~1b/parameters/0",
    ],
    ["/webhooks/hook/additionalOperations/Notify/parameters/0", "Notify webhook hook", undefined],
  ]);
});
