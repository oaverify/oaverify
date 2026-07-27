import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import type { RegexCompiler } from "../src/index.js";
import { createValidator } from "../src/validator.js";

/**
 * Validator-level forwarding: createValidator(spec, { regexCompiler })
 * has to thread the option into every per-operation compileSchema
 * invocation. The compiler-level tests in @oaverify/internal-schema cover the API
 * directly; these tests exercise the validator surface so a future
 * refactor that drops the forward (e.g. only passing through one of
 * the request / response code paths) regresses visibly.
 */
describe("createValidator forwards regexCompiler", () => {
  function spec(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "pat", version: "1" },
      paths: {
        "/items": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["sku"],
                    properties: { sku: { type: "string", pattern: "^OAV-" } },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string", pattern: "^[a-z0-9-]+$" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  it("invokes the custom compiler for request-body pattern keywords", () => {
    const seen: string[] = [];
    const compiler: RegexCompiler = (pattern) => {
      seen.push(pattern);
      return new RegExp(pattern, "u");
    };
    const v = createValidator(spec(), { regexCompiler: compiler });
    v.validateRequest({
      method: "POST",
      path: "/items",
      contentType: "application/json",
      body: { sku: "OAV-42" },
    });
    expect(seen).toContain("^OAV-");
  });

  it("invokes the custom compiler for response-body pattern keywords", () => {
    const seen: string[] = [];
    const compiler: RegexCompiler = (pattern) => {
      seen.push(pattern);
      return new RegExp(pattern, "u");
    };
    const v = createValidator(spec(), { regexCompiler: compiler });
    v.validateResponse(
      {
        method: "POST",
        path: "/items",
        contentType: "application/json",
        body: { sku: "OAV-42" },
      },
      {
        status: 200,
        contentType: "application/json",
        body: { id: "abc-123" },
      },
    );
    expect(seen).toContain("^[a-z0-9-]+$");
  });

  it("a rejecting custom compiler makes pattern validation fail", () => {
    // Pin the failure path: the validator should surface a pattern
    // validation error when the custom compiler returns a regex that
    // matches nothing.
    const v = createValidator(spec(), {
      regexCompiler: () => ({ test: () => false }),
    });
    const err = v.validateRequest({
      method: "POST",
      path: "/items",
      contentType: "application/json",
      body: { sku: "OAV-42" },
    });
    expect(err.valid).toBe(false);
    if (!err.valid) expect(err.errors.some((e) => e.code === "pattern")).toBe(true);
  });
});
