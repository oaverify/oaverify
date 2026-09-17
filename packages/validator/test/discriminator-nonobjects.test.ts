import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "../src/index.js";

describe.each(["3.0.3", "3.1.0"])("non-object discriminator bodies under %s", (openapi) => {
  it.each(["oneOf", "anyOf"] as const)("validates the %s branches", (keyword) => {
    const schema = {
      [keyword]: [
        { $ref: "#/components/schemas/A" },
        { $ref: "#/components/schemas/B" },
        { $ref: "#/components/schemas/Cat" },
      ],
      discriminator: { propertyName: "kind" },
    };
    const spec: OpenAPIDocument = {
      openapi,
      info: { title: "Discriminator", version: "1" },
      paths: {
        "/pets": {
          post: {
            requestBody: { content: { "application/json": { schema } } },
            responses: {
              "200": { description: "ok", content: { "application/json": { schema } } },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { type: "number" },
          B: { type: "integer" },
          Cat: { type: "object", required: ["lives"] },
        },
      },
    };
    for (const output of ["flat", "tree", "predicate"] as const) {
      const validator = createValidator(spec, { output });
      const cases: Array<[unknown, boolean]> = [
        [1.5, true],
        [42, keyword === "anyOf"],
        [null, false],
        ["cat", false],
        [[], false],
        [{ kind: "Cat", lives: 9 }, true],
        [{ kind: "Cat" }, false],
      ];
      for (const [body, valid] of cases) {
        const request = { method: "POST", path: "/pets", contentType: "application/json", body };
        for (const result of [
          validator.validateRequest(request),
          validator.validateResponse(request, {
            status: 200,
            contentType: "application/json",
            body,
          }),
        ]) {
          expect(typeof result === "boolean" ? result : result.valid).toBe(valid);
        }
      }
    }
  });
});
