import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { analyzeSpec } from "../src/index.js";

function doc(partial: Record<string, unknown>): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    ...partial,
  } as OpenAPIDocument;
}

describe("analyzeSpec", () => {
  it("analyzes request and response bodies, in document order", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { type: "object" } } },
              },
              responses: {
                "200": { content: { "application/json": { schema: { type: "array" } } } },
                default: { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    expect(budget.operations).toHaveLength(1);
    const op = budget.operations[0]!;
    expect(op.method).toBe("POST");
    expect(op.path).toBe("/pets");
    expect(op.bodies.map((b) => [b.role, b.status])).toEqual([
      ["request", undefined],
      ["response", "200"],
      ["response", "default"],
    ]);
    expect(op.bodies.every((b) => b.report?.classification === "streamable")).toBe(true);
  });

  it("omits operations with no body schema", () => {
    const budget = analyzeSpec(
      doc({ paths: { "/ping": { get: { responses: { "204": { description: "no content" } } } } } }),
    );
    expect(budget.operations).toEqual([]);
  });

  it("carries components so an internal $ref body resolves and surfaces unbounded positions", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
              },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string", pattern: "^.+$" } },
            },
          },
        },
      }),
    );
    const report = budget.operations[0]!.bodies[0]!.report!;
    expect(report.classification).toBe("buffer");
    expect(report.positions).toContainEqual(
      expect.objectContaining({ path: "name", keyword: "pattern", maxBytes: "unbounded" }),
    );
  });

  it("follows a local response $ref", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            get: { responses: { "200": { $ref: "#/components/responses/Pets" } } },
          },
        },
        components: {
          responses: {
            Pets: { content: { "application/json": { schema: { type: "array" } } } },
          },
        },
      }),
    );
    expect(budget.operations[0]!.bodies[0]).toMatchObject({ role: "response", status: "200" });
    expect(budget.operations[0]!.bodies[0]!.report?.classification).toBe("streamable");
  });

  it("captures a classification failure per body instead of throwing", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/x": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", unevaluatedProperties: false },
                  },
                },
              },
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    const bodies = budget.operations[0]!.bodies;
    expect(bodies[0]!.error).toMatch(/unevaluatedProperties/);
    expect(bodies[0]!.report).toBeUndefined();
    // The bad request body does not stop the response from being analyzed.
    expect(bodies[1]!.report?.classification).toBe("streamable");
  });

  it("reads the OpenAPI version off doc.openapi (3.0 format is annotation, not buffered)", () => {
    // Under 3.0 OpenAPI semantics `format` asserts, so a format string buffers;
    // proving the version is detected. A bare 2020-12 schema would not.
    const budget = analyzeSpec(
      doc({
        openapi: "3.0.3",
        paths: {
          "/x": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: { when: { type: "string", format: "date-time" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(budget.operations[0]!.bodies[0]!.report?.classification).toBe("buffer");
  });
});
