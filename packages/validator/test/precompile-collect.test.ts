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
