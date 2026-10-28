import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "../src/index.js";
import { expect, it } from "vitest";

it("validates recursive unions of references with default HTTP options", () => {
  const document: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "recursive union", version: "1" },
    paths: {
      "/n": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          oneOf: [{ $ref: "#/components/schemas/Leaf" }, { $ref: "#/components/schemas/Pair" }],
        },
        Leaf: { type: "string" },
        Pair: {
          type: "object",
          properties: {
            l: { $ref: "#/components/schemas/Node" },
            r: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    },
  };
  const validator = createValidator(document);
  for (const [body, valid] of [
    ["a", true],
    [{ l: "a", r: { l: "b", r: "c" } }, true],
    [{ l: "a", r: 3 }, false],
  ] as const) {
    expect(
      validator.validateRequest({
        method: "POST",
        path: "/n",
        contentType: "application/json",
        body,
      }).valid,
    ).toBe(valid);
  }
});
