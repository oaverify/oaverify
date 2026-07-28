/**
 * Compile-time schema output carries the operation it came from.
 *
 * Paths in errors and lint issues are relative to whichever schema was
 * handed to `compileSchema`. On a single schema that is unambiguous; on
 * a spec with dozens of operations, `"if" at "properties.a.allOf[1]"`
 * says what is wrong and not where to look. The validator compiles
 * per operation, so it is the layer that knows.
 */
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

function spec(paths: OpenAPIDocument["paths"]): OpenAPIDocument {
  return { openapi: "3.1.0", info: { title: "x", version: "1" }, paths } as OpenAPIDocument;
}

const jsonBody = (schema: unknown) => ({
  content: { "application/json": { schema: schema as SchemaOrBoolean } },
});

describe("operation context on schema lint issues", () => {
  it("names the operation and the request body media type", () => {
    const validator = createValidator(
      spec({
        "/things": {
          post: {
            requestBody: jsonBody({
              type: "object",
              properties: { name: { type: "string" } },
              required: ["nam"],
            }),
            responses: { "200": { description: "ok" } },
          },
        },
      }),
      { schemaLint: "strict" },
    );
    validator.precompile();

    const issues = validator.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.context).toBe("POST /things request body (application/json)");
    // The path stays schema-relative; context locates it, it does not
    // replace it.
    expect(issues[0]?.path).toBe("");
  });

  it("names the operation, status and media type for a response body", () => {
    const validator = createValidator(
      spec({
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                ...jsonBody({ type: "object", properties: {}, required: ["missing"] }),
              },
            },
          },
        },
      }),
      { schemaLint: "strict" },
    );
    validator.precompile();

    const issues = validator.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.context).toBe("GET /pets 200 response body (application/json)");
  });

  it("names the parameter, with its location", () => {
    const validator = createValidator(
      spec({
        "/pets": {
          get: {
            parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimumx: 1 } }],
            responses: { "200": { description: "ok" } },
          },
        },
      } as never),
      { schemaLint: "strict" },
    );
    validator.precompile();

    const issues = validator.stats.schemaLintIssues.filter((i) => i.code === "unknown-keyword");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.context).toBe('GET /pets query parameter "limit"');
  });

  it("names a response header", () => {
    const validator = createValidator(
      spec({
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: { "X-Rate-Limit": { schema: { type: "integer", minimumx: 1 } } },
              },
            },
          },
        },
      } as never),
      { schemaLint: "strict" },
    );
    validator.precompile();

    const issues = validator.stats.schemaLintIssues.filter((i) => i.code === "unknown-keyword");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.context).toBe('GET /pets 200 response header "x-rate-limit"');
  });

  it("reports a shared component against whichever operation compiled it first", () => {
    // Documented behaviour rather than a wish: the compile cache is
    // keyed by schema identity, so the second operation reuses the
    // first's compilation and never gets its own label. Context points
    // at the schema; it does not enumerate every operation affected.
    const shared = { type: "object", properties: {}, required: ["nope"] };
    const validator = createValidator(
      spec({
        "/a": { get: { responses: { "200": { description: "ok", ...jsonBody(shared) } } } },
        "/b": { get: { responses: { "200": { description: "ok", ...jsonBody(shared) } } } },
      }),
      { schemaLint: "strict" },
    );
    validator.precompile();

    const issues = validator.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.context).toContain("response body (application/json)");
  });
});

describe("operation context on malformed-schema errors", () => {
  it("prefixes the thrown message with the operation", () => {
    expect(() =>
      createValidator(
        spec({
          "/things": {
            post: {
              requestBody: jsonBody({ type: "array", items: [{ type: "string" }] }),
              responses: { "200": { description: "ok" } },
            },
          },
        }),
      ).precompile(),
    ).toThrow(/^POST \/things request body \(application\/json\): "items" at <root> must be/);
  });
});
