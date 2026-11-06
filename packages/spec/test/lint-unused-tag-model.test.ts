import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

const ok = { "200": { description: "ok" } };

const unusedTags = (document: OpenAPIDocument): string[] =>
  lintResolvedSpec(document)
    .filter((issue) => issue.code === "unused-tag")
    .map((issue) => issue.pointer);

describe("unused-tag reads the operation model", () => {
  it("counts a tag used only by an operation behind a Path Item $ref", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "viaRef" }, { name: "unused" }],
      paths: { "/p": { $ref: "#/components/pathItems/P" } },
      components: { pathItems: { P: { get: { tags: ["viaRef"], responses: ok } } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual(["/tags/1"]);
  });

  it("counts a tag used only inside a callback, and one on a referenced webhook", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "cb" }, { name: "hook" }],
      paths: {
        "/p": {
          post: {
            responses: ok,
            callbacks: {
              onDone: { "{$request.body#/url}": { post: { tags: ["cb"], responses: ok } } },
            },
          },
        },
      },
      webhooks: { w: { $ref: "#/components/pathItems/W" } },
      components: { pathItems: { W: { post: { tags: ["hook"], responses: ok } } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual([]);
  });

  it("counts a tag used where the document's version defines no such position", () => {
    const document = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      tags: [{ name: "hook" }, { name: "query" }],
      paths: { "/p": { query: { tags: ["query"], responses: ok } } },
      webhooks: { w: { post: { tags: ["hook"], responses: ok } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual([]);
  });

  it("counts a tag used in a callback that a Path Item reference reaches first", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "t1" }],
      paths: {
        "/a": { $ref: "#/x/C/{$u}", post: { responses: ok } },
        "/b": { post: { responses: ok, callbacks: { c: { $ref: "#/x/C" } } } },
      },
      x: { C: { "{$u}": { post: { tags: ["t1"], responses: ok } } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual([]);
  });

  it("counts a tag used in a callback of an operation that a nearer declaration shadows", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "t1" }],
      paths: { "/a": { $ref: "#/x/A", post: { responses: ok } } },
      x: {
        A: {
          post: {
            responses: ok,
            callbacks: { c: { "{$u}": { post: { tags: ["t1"], responses: ok } } } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual([]);
  });

  it("counts a tag used by an operation that a nearer declaration shadows", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "far" }, { name: "near" }],
      paths: { "/a": { $ref: "#/x/A", post: { tags: ["near"], responses: ok } } },
      x: { A: { post: { tags: ["far"], responses: ok } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual([]);
  });

  it("still reports a tag nothing names", () => {
    const document = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      tags: [{ name: "a" }, { name: "b" }],
      paths: { "/p": { get: { tags: ["a"], responses: ok } } },
    } as unknown as OpenAPIDocument;
    expect(unusedTags(document)).toEqual(["/tags/1"]);
  });
});
