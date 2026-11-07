import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { walkDocumentSchemas } from "../src/document-walk.js";
import { listIgnoredHeaders } from "../src/ignored-headers.js";
import { resolveOperationRef } from "../src/operation-cache.js";

const base = { openapi: "3.1.0", info: { title: "t", version: "1" } };
const ok = { "200": { description: "ok" } };
const accept = { name: "Accept", in: "header", schema: { type: "string" } };

function roots(document: unknown): string[] {
  const out: string[] = [];
  walkDocumentSchemas(document as OpenAPIDocument, {
    onSchemaRoot: (_schema, pointer) => out.push(pointer),
  });
  return out;
}

const ignored = (document: unknown): string[] =>
  listIgnoredHeaders(document as OpenAPIDocument).map(
    (header) => header.definitionPointer ?? "(none)",
  );

/** A parameter reached through `references` references, the last landing on the declaration. */
function chained(references: number): { document: OpenAPIDocument; use: { $ref: string } } {
  const refs: Record<string, unknown> = {};
  for (let i = 0; i < references - 1; i++) refs[`r${i}`] = { $ref: `#/x-refs/r${i + 1}` };
  refs[`r${references - 1}`] = accept;
  const use = { $ref: "#/x-refs/r0" };
  const document = {
    ...base,
    paths: { "/p": { get: { parameters: [use], responses: ok } } },
    "x-refs": refs,
  } as unknown as OpenAPIDocument;
  return { document, use };
}

describe("the document walk and the header listing follow references as the request path does", () => {
  it("follows the longest chain the request path resolves", () => {
    const { document, use } = chained(31);
    expect(resolveOperationRef(document, use)).toBe(accept);
    expect(roots(document)).toEqual(["/x-refs/r30/schema"]);
    expect(ignored(document)).toEqual(["/x-refs/r30"]);
  });

  it("does not follow a chain the request path refuses as too long", () => {
    const { document, use } = chained(32);
    expect(() => resolveOperationRef(document, use)).toThrow(/exceeded 32 hops/);
    expect(roots(document)).toEqual([]);
    expect(ignored(document)).toEqual([]);
  });

  it("reads a percent-encoded fragment as the pointer it encodes", () => {
    const use = { $ref: "#%2Fx-params%2FA" };
    const document = {
      ...base,
      paths: { "/p": { get: { parameters: [use], responses: ok } } },
      "x-params": { A: accept },
    } as unknown as OpenAPIDocument;
    expect(resolveOperationRef(document, use)).toBe(accept);
    expect(roots(document)).toEqual(["/x-params/A/schema"]);
    expect(ignored(document)).toEqual(["/x-params/A"]);
  });

  it("follows a reference to the whole document", () => {
    const use = { $ref: "#" };
    const document = {
      ...base,
      ...accept,
      paths: { "/p": { get: { parameters: [use], responses: ok } } },
    } as unknown as OpenAPIDocument;
    expect(resolveOperationRef(document, use)).toBe(document);
    expect(roots(document)).toEqual(["/schema"]);
    expect(ignored(document)).toEqual([""]);
  });

  it("reads a Path Item reference by the same rules, one hop at a time", () => {
    const item = { get: { parameters: [accept], responses: ok } };
    const document = {
      ...base,
      paths: { "/encoded": { $ref: "#%2Fx-items%2FA" }, "/whole": { $ref: "#" } },
      "x-items": { A: item },
      get: { parameters: [{ ...accept, name: "Authorization" }], responses: ok },
    } as unknown as OpenAPIDocument;
    expect(roots(document)).toEqual([
      "/x-items/A/get/parameters/0/schema",
      "/get/parameters/0/schema",
    ]);
    expect(ignored(document)).toEqual(["/x-items/A/get/parameters/0", "/get/parameters/0"]);
  });

  it("skips an anchor, an external reference and a cycle", () => {
    const document = {
      ...base,
      paths: {
        "/p": {
          get: {
            parameters: [
              { $ref: "#anchor" },
              { $ref: "other.yaml#/components/parameters/P" },
              { $ref: "#/x-loop/a" },
            ],
            responses: ok,
          },
        },
      },
      "x-loop": { a: { $ref: "#/x-loop/b" }, b: { $ref: "#/x-loop/a" } },
    } as unknown as OpenAPIDocument;
    expect(roots(document)).toEqual([]);
    expect(ignored(document)).toEqual([]);
  });
});
