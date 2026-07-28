/**
 * A malformed schema inside a component the body reaches by `$ref`.
 *
 * The well-formedness guard used to walk only the schema object handed
 * to `compileSchema`. In the HTTP pipeline that is one operation's
 * inline schema, with components supplied through the resolver, so
 * anything behind a nested `$ref` compiled unchecked. The structural
 * checks exist nowhere else, so this was not a missing message: the
 * document was accepted and the constraint was silently dropped (#512).
 */
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

function specWith(tags: unknown): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: {
      schemas: { Bag: { type: "object", properties: { tags } } },
    },
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
                    properties: { bag: { $ref: "#/components/schemas/Bag" } },
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

describe("malformed schema behind a nested $ref", () => {
  it("is rejected rather than compiled with the constraint dropped", () => {
    // The array-valued `items` is the draft-04 tuple spelling. Compiled,
    // it yields a schema with no element constraint at all, so
    // {"tags": [1, 2, 3]} validated clean against `items: [{type:
    // "string"}]`. Refusing to build the validator is the whole point.
    expect(() => createValidator(specWith({ items: [{ type: "string" }] })).precompile()).toThrow(
      /"items" at "components\.schemas\.Bag\.properties\.tags"/,
    );
  });

  it("locates keyword-value defects instead of naming only the keyword", () => {
    expect(() =>
      createValidator(specWith({ type: "array", items: { type: "Boolean" } })).precompile(),
    ).toThrow(/keyword "type" at "components\.schemas\.Bag\.properties\.tags\.items\.type"/);
  });

  it("reports a structural defect that used to crash codegen", () => {
    // `prefixItems` as an object reached codegen and died with
    // "schemas.forEach is not a function".
    expect(() =>
      createValidator(specWith({ prefixItems: { type: "string" } })).precompile(),
    ).toThrow(/"prefixItems" at "components\.schemas\.Bag\.properties\.tags" must be an array/);
  });

  it("still accepts a well-formed component", () => {
    const v = createValidator(specWith({ type: "array", items: { type: "string" } }));
    expect(() => v.precompile()).not.toThrow();
    const bad = v.validateResponse(
      { method: "GET", path: "/p" },
      { status: 200, contentType: "application/json", body: { bag: { tags: [1, 2, 3] } } },
    );
    expect(bad.valid).toBe(false);
  });
});
