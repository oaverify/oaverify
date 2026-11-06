import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

const ok = { "200": { description: "ok" } };

function doc(extra: Record<string, unknown>): OpenAPIDocument {
  return { openapi: "3.1.0", info: { title: "t", version: "1" }, ...extra } as OpenAPIDocument;
}

const findings = (document: OpenAPIDocument, code: string): string[] =>
  lintResolvedSpec(document)
    .filter((issue) => issue.code === code)
    .map((issue) => issue.pointer);

describe("document-wide rules read every Path Item the document declares", () => {
  const flawed = {
    responses: ok,
    security: [{ missing: [] }],
    servers: [{ url: "https://{missing}.example" }],
    parameters: [
      { name: "p", in: "query" },
      { name: "p", in: "query" },
    ],
  };

  it("checks a callback of an operation that a field beside the reference shadows", () => {
    const document = doc({
      paths: { "/a": { $ref: "#/x-items/P", get: { responses: ok } } },
      "x-items": {
        P: { get: { responses: ok, callbacks: { c: { "{$url}": { post: flawed } } } } },
      },
    });
    const at = "/x-items/P/get/callbacks/c/{$url}/post";
    expect(findings(document, "duplicate-parameter")).toEqual([`${at}/parameters/1`]);
    expect(findings(document, "security-scheme-undeclared")).toEqual([`${at}/security/0/missing`]);
    expect(findings(document, "server-variable-undeclared")).toEqual([`${at}/servers/0/url`]);
  });

  it("checks a Path Item at the end of a reference chain of any length", () => {
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 39; i++) items[`P${i}`] = { $ref: `#/x-items/P${i + 1}` };
    items["P39"] = { get: flawed };
    const document = doc({ paths: { "/a": { $ref: "#/x-items/P0" } }, "x-items": items });
    expect(findings(document, "duplicate-parameter")).toEqual(["/x-items/P39/get/parameters/1"]);
    expect(findings(document, "security-scheme-undeclared")).toEqual([
      "/x-items/P39/get/security/0/missing",
    ]);
  });

  it("reports the later of two operationIds in the order the document is written", () => {
    const nested = doc({
      paths: {
        "/a": {
          post: {
            responses: ok,
            callbacks: {
              first: {
                "{$a}": {
                  post: {
                    responses: ok,
                    callbacks: {
                      nested: { "{$n}": { post: { responses: ok, operationId: "x" } } },
                    },
                  },
                },
              },
              second: { "{$b}": { post: { responses: ok, operationId: "x" } } },
            },
          },
        },
      },
    });
    expect(findings(nested, "duplicate-operation-id")).toEqual([
      "/paths/~1a/post/callbacks/second/{$b}/post/operationId",
    ]);

    const targets = doc({
      paths: { "/a": { $ref: "#/x-items/A" }, "/b": { $ref: "#/x-items/B" } },
      "x-items": {
        A: { $ref: "#/x-items/C" },
        B: { get: { responses: ok, operationId: "y" } },
        C: { get: { responses: ok, operationId: "y" } },
      },
    });
    expect(findings(targets, "duplicate-operation-id")).toEqual(["/x-items/C/get/operationId"]);

    const ownCallback = doc({
      paths: { "/a": { $ref: "#/x-items/A" } },
      "x-items": {
        A: {
          post: {
            responses: ok,
            operationId: "z",
            callbacks: { c: { "{$u}": { post: { responses: ok, operationId: "z" } } } },
          },
        },
      },
    });
    expect(findings(ownCallback, "duplicate-operation-id")).toEqual([
      "/x-items/A/post/callbacks/c/{$u}/post/operationId",
    ]);
  });

  it("does not read the document as a Path Item through a reference to its root", () => {
    const document = doc({
      servers: [{ url: "https://{v}.example" }],
      parameters: [
        { name: "a", in: "query" },
        { name: "a", in: "query" },
      ],
      paths: { "/a": { $ref: "#" } },
    });
    expect(findings(document, "duplicate-parameter")).toEqual([]);
    expect(findings(document, "server-variable-undeclared")).toEqual(["/servers/0/url"]);
  });
});
