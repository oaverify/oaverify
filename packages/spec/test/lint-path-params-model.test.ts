import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

const ok = { "200": { description: "ok" } };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };

function doc(extra: Record<string, unknown>): OpenAPIDocument {
  return { openapi: "3.1.0", info: { title: "t", version: "1" }, ...extra } as OpenAPIDocument;
}

const pathFindings = (document: OpenAPIDocument): [string, string][] =>
  lintResolvedSpec(document)
    .filter((issue) => issue.code.startsWith("path-"))
    .map((issue) => [issue.code, issue.pointer]);

describe("path-parameter rules read the effective Path Item", () => {
  it("reports an undeclared template name on an entry that is a Path Item reference", () => {
    const document = doc({
      paths: {
        "/direct/{id}": { get: { responses: ok } },
        "/viaRef/{id}": { $ref: "#/components/pathItems/P" },
      },
      components: { pathItems: { P: { get: { responses: ok } } } },
    });
    expect(pathFindings(document)).toEqual([
      ["path-param-undeclared", "/paths/~1direct~1{id}/get"],
      ["path-param-undeclared", "/components/pathItems/P/get"],
    ]);
  });

  it("accepts a declaration the reference contributes to an operation written beside it", () => {
    const document = doc({
      paths: { "/p/{id}": { $ref: "#/x-items/P", get: { responses: ok } } },
      "x-items": { P: { parameters: [idParam] } },
    });
    expect(pathFindings(document)).toEqual([]);
  });

  it("judges a shared Path Item once for each template that references it", () => {
    const document = doc({
      paths: {
        "/a/{id}": { $ref: "#/components/pathItems/P" },
        "/b/{key}": { $ref: "#/components/pathItems/P" },
      },
      components: { pathItems: { P: { parameters: [idParam], get: { responses: ok } } } },
    });
    const findings = lintResolvedSpec(document).filter((issue) => issue.code.startsWith("path-"));
    expect(findings.map((issue) => [issue.code, issue.pointer])).toEqual([
      ["path-param-unused", "/components/pathItems/P/parameters"],
      ["path-param-undeclared", "/components/pathItems/P/get"],
    ]);
    expect(findings.every((issue) => issue.message.includes('"/b/{key}"'))).toBe(true);
  });

  it("stays quiet about undeclared names when the entry's reference chain does not complete", () => {
    const document = doc({
      paths: { "/p/{id}": { $ref: "#/nope", get: { responses: ok } } },
    });
    expect(pathFindings(document)).toEqual([]);
  });

  it("follows a parameter reference through more than one hop", () => {
    const document = doc({
      paths: {
        "/p/{id}": {
          get: { parameters: [{ $ref: "#/components/parameters/A" }], responses: ok },
        },
      },
      components: { parameters: { A: { $ref: "#/components/parameters/B" }, B: idParam } },
    });
    expect(pathFindings(document)).toEqual([]);
  });

  it("does not read an extension key under paths as a template", () => {
    const document = doc({
      paths: {
        "x-vendor/{id}%zz": { get: { responses: ok } },
        "/ok": { get: { responses: ok } },
      },
    });
    expect(pathFindings(document)).toEqual([]);
  });

  it("does not report a template whose value is not an object", () => {
    const document = doc({ paths: { "/bad%zz": null, "/ok": { get: { responses: ok } } } });
    expect(pathFindings(document)).toEqual([]);
  });

  it("takes a parameter reference target as a parameter only when it has a name and a location", () => {
    const document = doc({
      paths: {
        "/a": { get: { parameters: [{ $ref: "#/components/parameters/A" }], responses: ok } },
      },
      components: { parameters: { A: { in: "path" } } },
    });
    expect(pathFindings(document)).toEqual([]);
  });

  it("stays quiet about undeclared names when the referenced item's parameters cannot be read", () => {
    const document = doc({
      paths: { "/p/{id}": { $ref: "#/x-items/P", get: { responses: ok } } },
      "x-items": { P: { parameters: { name: "id", in: "path" } } },
    });
    expect(pathFindings(document)).toEqual([]);
  });
});
