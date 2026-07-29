/**
 * `precompile` with `onMalformed: "collect"`.
 *
 * Throwing is right for a server: continuing past a schema that would
 * not compile leaves that operation validating against nothing. It is
 * wrong for a tool inspecting a document, where one bad `items` hid
 * every other finding in the file (#515).
 */
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

function twoOperations(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      // Malformed: array-valued `items`.
      "/bad": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "array", items: [{ type: "string" }] } },
              },
            },
          },
        },
      },
      // Well-formed, but carries a lint finding that the abort hid.
      "/good": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["nam"],
                  },
                },
              },
            },
          },
        },
      },
    },
  } as unknown as OpenAPIDocument;
}

describe("precompile onMalformed", () => {
  it("throws by default, which is what a server wants", () => {
    expect(() => createValidator(twoOperations()).precompile()).toThrow(/"items"/);
  });

  it("collects the failure and keeps going", () => {
    const v = createValidator(twoOperations(), { schemaLint: "strict" });
    const failures = v.precompile({ onMalformed: "collect" });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.context).toContain("/bad");
    expect(failures[0]?.message).toMatch(/"items" at <root> must be an object or boolean/);

    // The point of the change: the other operation was still linted.
    const lint = v.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );
    expect(lint).toHaveLength(1);
    expect(lint[0]?.context).toContain("/good");
  });

  it("returns nothing when every schema compiles", () => {
    const clean = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
    } as OpenAPIDocument;
    expect(createValidator(clean).precompile({ onMalformed: "collect" })).toEqual([]);
  });

  it("keeps grading an operation whose request side failed", () => {
    // A malformed query parameter used to abort the whole operation:
    // `cacheFor` was one guarded unit, so its response schemas were
    // never driven and their findings vanished. Same defect on both
    // operations, so the assertion is about where it is reported, not
    // about whether the rule fires.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/bad-request-side": {
          get: {
            parameters: [
              { name: "q", in: "query", schema: { type: "array", items: [{ type: "string" }] } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { name: { type: "string" } },
                      required: ["nam"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const v = createValidator(doc, { schemaLint: "strict" });
    const failures = v.precompile({ onMalformed: "collect" });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.context).toContain("/bad-request-side");

    const lint = v.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );
    expect(lint).toHaveLength(1);
    expect(lint[0]?.context).toContain("200 response");
  });

  it("reports every malformed schema in one operation, not just the first", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/two-bad-params": {
          get: {
            parameters: [
              { name: "q", in: "query", schema: { type: "array", items: [{ type: "string" }] } },
              { name: "r", in: "query", schema: { type: "array", items: [{ type: "string" }] } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const failures = createValidator(doc).precompile({ onMalformed: "collect" });

    // One per malformed schema. Collapsing them to one made the reported
    // count a lower bound, so fixing everything reported produced a
    // fresh crop on the next run.
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.context).join(" ")).toContain('query parameter "q"');
    expect(failures.map((f) => f.context).join(" ")).toContain('query parameter "r"');
  });

  it("does not leave a degraded operation cache behind for request validation", () => {
    // Collect mode skips the schemas it could not compile so the rest of
    // the operation can be graded. That cache must not be reused at
    // request time, where the parameter would then go unvalidated.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/bad-param": {
          get: {
            parameters: [
              { name: "q", in: "query", schema: { type: "array", items: [{ type: "string" }] } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const v = createValidator(doc);
    expect(v.precompile({ onMalformed: "collect" })).toHaveLength(1);
    expect(() =>
      v.validateRequest({ method: "get", path: "/bad-param", query: { q: "x" } }),
    ).toThrow(/"items"/);
  });

  it("reports one failure per operation rather than stopping at the first", () => {
    const doc = twoOperations() as unknown as { paths: Record<string, unknown> };
    doc.paths["/alsoBad"] = {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "object", properties: [{ a: 1 }] } } },
          },
        },
      },
    };
    const failures = createValidator(doc as OpenAPIDocument).precompile({
      onMalformed: "collect",
    });
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.context).join(" ")).toMatch(/\/bad/);
    expect(failures.map((f) => f.context).join(" ")).toMatch(/\/alsoBad/);
  });
});
