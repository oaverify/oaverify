import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { openapi31Dialect, resolve } from "@oaverify/internal-schema";
import { checkDocumentExamples, checkDocumentExamplesInContext } from "../src/example-check.js";

function doc(schema: Record<string, unknown>): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "examples", version: "1" },
    paths: {},
    components: { schemas: { S: schema } },
  } as OpenAPIDocument;
}

describe("example schema compilation failure", () => {
  it.each([
    [{ type: "nonsense" }, /type/],
    [{ $ref: "#/components/schemas/Missing" }, /Missing/],
    [{ type: "string", pattern: "[" }, /pattern|regular expression/i],
  ] as const)("reports standalone failures for %j", (schema, reason) => {
    const issues = checkDocumentExamples(doc({ ...schema, example: 1 }));
    expect(issues).toEqual([
      expect.objectContaining({
        code: "example-uncheckable",
        pointer: "/components/schemas/S/example",
        reasons: [],
      }),
    ]);
    expect(issues[0]!.message).toMatch(reason);
    expect(issues[0]!.message).toContain("compilation failed");
  });

  it.each(["3.0.3", "3.1.0", "3.2.0"])("reports eligible examples in %s", (openapi) => {
    const document = doc({ type: "nonsense", example: 1 });
    document.openapi = openapi;
    expect(checkDocumentExamples(document).map((i) => i.code)).toEqual(["example-uncheckable"]);
  });

  it("reports each example on a shared malformed schema and continues independent checks", () => {
    const schema = { type: "nonsense", examples: [1, 2] };
    const document = doc(schema);
    document.components!.schemas!.Valid = { type: "string", examples: ["ok"] };
    document.components!.schemas!.Invalid = { type: "string", examples: [1] };
    document.paths = {
      "/x": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: schema as SchemaOrBoolean,
                example: 3,
                examples: {
                  named: { value: 4 },
                  external: { externalValue: "https://example.com/example.json" },
                },
              },
            },
          },
        },
      },
    };
    const issues = checkDocumentExamples(document);
    expect(
      issues
        .filter((i) => i.code === "example-uncheckable")
        .map((i) => i.pointer)
        .sort(),
    ).toEqual([
      "/paths/~1x/post/requestBody/content/application~1json/example",
      "/paths/~1x/post/requestBody/content/application~1json/examples/named/value",
      "/paths/~1x/post/requestBody/content/application~1json/schema/examples/0",
      "/paths/~1x/post/requestBody/content/application~1json/schema/examples/1",
    ]);
    expect(issues.filter((i) => i.code === "example-invalid")).toEqual([
      expect.objectContaining({ pointer: "/components/schemas/Invalid/examples/0" }),
    ]);
  });

  it.each(["withhold", "throw", "compile"] as const)(
    "keeps checker-owned %s failures silent",
    (mode) => {
      const schema = { type: "nonsense", example: 1 } as unknown as SchemaOrBoolean;
      const document = doc(schema as Record<string, unknown>);
      const issues = checkDocumentExamplesInContext(document, {}, () => {
        if (mode === "withhold") return undefined;
        if (mode === "throw") throw new Error("checker owns this failure");
        return {
          dialect: openapi31Dialect,
          context: {
            graph: resolve(schema),
            nodes: [schema],
            pointerOf: () => "/components/schemas/S",
          },
        };
      });
      expect(issues).toEqual([]);
    },
  );
});
