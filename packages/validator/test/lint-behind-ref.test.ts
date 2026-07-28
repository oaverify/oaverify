/**
 * Schema lint rules on components reached by a nested `$ref`.
 *
 * `runSchemaLint` drives every rule except `required-not-in-properties`
 * through `walkSubschemas`, which did not follow `$ref`. The validator
 * unwraps a body schema's root ref before compiling, so the lint saw
 * each operation's inline schema plus at most the one component named
 * directly as its body. Anything deeper was never visited: on Asana, 1
 * of 278 component schemas (#513).
 */
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

function spec(version: string, components: Record<string, unknown>): OpenAPIDocument {
  return {
    openapi: version,
    info: { title: "t", version: "1" },
    components: { schemas: components },
    paths: {
      "/p": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    // Nested, so the root-ref unwrap does not expose it.
                    properties: { e: { $ref: "#/components/schemas/E" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  } as OpenAPIDocument;
}

const lint = (doc: OpenAPIDocument) => {
  const v = createValidator(doc, { schemaLint: "strict" });
  v.precompile();
  return v.stats.schemaLintIssues;
};

describe("schema lint reaches components behind a nested $ref", () => {
  it("reports an unknown keyword", () => {
    const issues = lint(
      spec("3.1.0", { E: { type: "object", descrciption: "typo", properties: {} } }),
    );
    const found = issues.filter((i) => i.code === "unknown-keyword");
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("components.schemas.E");
  });

  it("reports redundant composition branches", () => {
    const issues = lint(
      spec("3.1.0", {
        E: {
          type: "object",
          properties: { x: { oneOf: [{ type: "string" }, { type: "string" }] } },
        },
      }),
    );
    expect(
      issues.filter((i) => i.code === "silent-rewrite/redundant-composition-branches"),
    ).toHaveLength(1);
  });

  it("reports OAS 3.0 $ref siblings", () => {
    const issues = lint(
      spec("3.0.3", {
        E: {
          type: "object",
          properties: { y: { $ref: "#/components/schemas/F", readOnly: true } },
        },
        F: { type: "object", properties: { z: { type: "string" } } },
      }),
    );
    const found = issues.filter((i) => i.code === "silent-rewrite/ref-siblings-oas30");
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("components.schemas.E.properties.y");
  });

  it("visits a shared component once, not once per reference", () => {
    const issues = lint(
      spec("3.1.0", {
        E: {
          type: "object",
          properties: {
            a: { $ref: "#/components/schemas/Shared" },
            b: { $ref: "#/components/schemas/Shared" },
          },
        },
        Shared: { type: "object", nope: 1, properties: {} },
      }),
    );
    expect(issues.filter((i) => i.code === "unknown-keyword")).toHaveLength(1);
  });

  it("terminates on a self-referential component", () => {
    const issues = lint(
      spec("3.1.0", {
        E: { type: "object", bad: 1, properties: { next: { $ref: "#/components/schemas/E" } } },
      }),
    );
    expect(issues.filter((i) => i.code === "unknown-keyword")).toHaveLength(1);
  });
});
