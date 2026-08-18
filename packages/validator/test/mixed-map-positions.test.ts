import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkDocumentExamples } from "../src/example-check.js";
import { createValidator } from "../src/validator.js";

/**
 * `dependencies` holds subschemas at some entries, so everything a
 * walker does inside `dependentSchemas` it must also do here. Each test
 * pairs the two keywords: the `dependentSchemas` case is the control,
 * and a failure in only the `dependencies` case is the walker stepping
 * past a mixed position (#859).
 */
type Mixed = "dependentSchemas" | "dependencies";

const withSchema = (schema: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
    paths: {
      "/things": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
          responses: { "201": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

describe("mixed-map subschema positions (#859)", () => {
  describe("the request direction transform", () => {
    const specWith = (keyword: Mixed): OpenAPIDocument =>
      withSchema({
        type: "object",
        properties: { x: { type: "string" } },
        [keyword]: {
          x: {
            type: "object",
            properties: { id: { type: "string", readOnly: true } },
          },
        },
      });

    it.each(["dependentSchemas", "dependencies"] as const)(
      "rejects a readOnly property sent in a request body under %s",
      (keyword) => {
        // A readOnly property is server-owned. Accepting one from a
        // client is a validation bypass, not a cosmetic gap.
        const result = createValidator(specWith(keyword)).validateRequest({
          method: "POST",
          path: "/things",
          contentType: "application/json",
          body: { x: "hello", id: "client-supplied" },
        });

        expect(result?.valid).toBe(false);
      },
    );

    it.each(["dependentSchemas", "dependencies"] as const)(
      "still accepts a body that omits the readOnly property under %s",
      (keyword) => {
        const result = createValidator(specWith(keyword)).validateRequest({
          method: "POST",
          path: "/things",
          contentType: "application/json",
          body: { x: "hello" },
        });

        expect(result?.valid).toBe(true);
      },
    );

    it("leaves a dependencies array entry as a property-name list", () => {
      // `{ "x": ["y"] }` names required properties. Rewriting it as a
      // schema would drop the constraint silently.
      const validator = createValidator(
        withSchema({
          type: "object",
          properties: { x: { type: "string" }, y: { type: "string" } },
          dependencies: { x: ["y"] },
        }),
      );

      expect(
        validator.validateRequest({
          method: "POST",
          path: "/things",
          contentType: "application/json",
          body: { x: "hello" },
        })?.valid,
      ).toBe(false);

      expect(
        validator.validateRequest({
          method: "POST",
          path: "/things",
          contentType: "application/json",
          body: { x: "hello", y: "there" },
        })?.valid,
      ).toBe(true);
    });
  });

  describe("the document example check", () => {
    it.each(["dependentSchemas", "dependencies"] as const)(
      "reports an example its own schema rejects under %s",
      (keyword) => {
        const issues = checkDocumentExamples(
          withSchema({
            type: "object",
            [keyword]: { x: { properties: { count: { type: "integer", example: "no" } } } },
          }),
        );

        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "example-invalid" });
        expect(issues[0]?.pointer).toContain(`/${keyword}/x/properties/count/example`);
      },
    );
  });
});
