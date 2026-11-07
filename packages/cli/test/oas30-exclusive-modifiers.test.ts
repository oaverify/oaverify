/**
 * The emitters reach the compiler by their own routes, so a non-boolean OAS
 * 3.0 exclusive modifier has to fail the build there as well.
 */
import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { emitSpec } from "../src/emit-spec.js";
import { emitStandalone } from "../src/emit-standalone.js";

describe("OAS 3.0 exclusive modifiers in the emitters", () => {
  it("fail emitStandalone on a numeric value", () => {
    const schema = { exclusiveMaximum: 5 } as unknown as SchemaOrBoolean;
    expect(() => emitStandalone(schema, { dialect: "openapi-3.0" })).toThrow(/requires a boolean/);
  });

  it("fail emitSpec on a numeric value", () => {
    const document = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { exclusiveMaximum: 5 } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(() => emitSpec(document)).toThrow(/requires a boolean/);
  });
});
