/**
 * A `$ref` with siblings at a request or response body root.
 *
 * The body-schema transform used to follow the root `$ref` to its
 * target unconditionally, replacing the node. That is only sound when
 * the node is a bare `$ref`. With siblings it means two different wrong
 * things depending on dialect: under 3.1 the siblings are part of the
 * schema and were silently dropped, so constraints the author wrote
 * went unenforced; under 3.0 they are dropped by the specification, but
 * removing the node early also hid it from the lint that warns about
 * exactly that (#505).
 *
 * Both are specific to the root. Nested `$ref` nodes were always
 * handled correctly by the compiler, which is what these compare
 * against.
 */
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

const PET = { type: "object", properties: { name: { type: "string" } } };

function responseSpec(version: string, schema: unknown): OpenAPIDocument {
  return {
    openapi: version,
    info: { title: "t", version: "1" },
    components: { schemas: { Pet: PET } },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": { description: "ok", content: { "application/json": { schema } } },
          },
        },
      },
    },
  } as OpenAPIDocument;
}

function requestSpec(version: string, schema: unknown): OpenAPIDocument {
  return {
    openapi: version,
    info: { title: "t", version: "1" },
    components: { schemas: { Pet: PET } },
    paths: {
      "/pets": {
        post: {
          requestBody: { content: { "application/json": { schema } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as OpenAPIDocument;
}

const withSiblings = { $ref: "#/components/schemas/Pet", required: ["name"] };

describe("OpenAPI 3.1: $ref siblings at a body root are enforced", () => {
  it("applies a sibling `required` on a response body", () => {
    const v = createValidator(responseSpec("3.1.0", withSiblings));
    const err = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: {} },
    );
    expect(err.valid).toBe(false);
  });

  it("applies a sibling `required` on a request body", () => {
    const v = createValidator(requestSpec("3.1.0", withSiblings));
    const result = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: {},
    });
    expect(result.valid).toBe(false);
    // Assert the reason, not just the verdict: a content-type mismatch
    // would also make this invalid and would pass with the fix reverted.
    expect(JSON.stringify(result)).toContain("required");
  });

  it("still accepts a body that satisfies the sibling", () => {
    const v = createValidator(responseSpec("3.1.0", withSiblings));
    const err = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: { name: "x" } },
    );
    expect(err.valid).toBe(true);
  });

  it("agrees with the same shape one level down", () => {
    // The nested case always worked. Root and nested must not disagree.
    const nested = {
      type: "object",
      properties: { pet: withSiblings },
      required: ["pet"],
    };
    const v = createValidator(responseSpec("3.1.0", nested));
    const err = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: { pet: {} } },
    );
    expect(err.valid).toBe(false);
  });
});

describe("OpenAPI 3.0: the dropped siblings are reported", () => {
  it("warns about a sibling of $ref at a response body root", () => {
    const v = createValidator(responseSpec("3.0.3", withSiblings), { schemaLint: "strict" });
    v.precompile();
    const issues = v.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/ref-siblings-oas30",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.keyword).toBe("required");
    expect(issues[0]?.location).toBe("GET /pets 200 response body (application/json)");
  });

  it("warns about a sibling of $ref at a request body root", () => {
    const v = createValidator(requestSpec("3.0.3", withSiblings), { schemaLint: "strict" });
    v.precompile();
    const issues = v.stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/ref-siblings-oas30",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location).toBe("POST /pets request body (application/json)");
  });

  it("keeps 3.0 semantics: the sibling is still not enforced", () => {
    // Warning about the drop is the fix. Applying the sibling under 3.0
    // would be a different, wrong change.
    const v = createValidator(responseSpec("3.0.3", withSiblings));
    const err = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: {} },
    );
    expect(err.valid).toBe(true);
  });
});

describe("a bare $ref at a body root is still followed", () => {
  it("validates against the target", () => {
    const v = createValidator(
      responseSpec("3.1.0", { $ref: "#/components/schemas/Pet", description: "a pet" }),
    );
    const good = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: { name: "x" } },
    );
    expect(good.valid).toBe(true);
    const bad = v.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 200, contentType: "application/json", body: { name: 5 } },
    );
    expect(bad.valid).toBe(false);
  });
});
