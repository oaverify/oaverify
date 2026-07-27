import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator, leafAt, leafCodes, petSpec } from "./fixtures.js";

describe("validateResponse", () => {
  const v = createValidator(petSpec());

  it("returns null for a valid response", () => {
    expect(
      v.validateResponse(
        { method: "GET", path: "/pets", headers: { "x-tenant": "t1" } },
        { status: 200, contentType: "application/json", body: [{ name: "x" }] },
      ),
    ).toBeNull();
  });

  it("matches XX status class", () => {
    const err = v.validateResponse(
      { method: "POST", path: "/pets", headers: { "x-tenant": "t1" }, body: { name: "x" } },
      { status: 418 },
    );
    expect(err).toBeNull();
  });

  it("errors when the response Content-Type is unexpected", () => {
    const err = v.validateResponse(
      { method: "GET", path: "/pets", headers: { "x-tenant": "t1" } },
      { status: 200, contentType: "text/plain", body: "nope" },
    );
    expect(leafCodes(err)).toContain("content-type");
  });

  it("errors when the body violates the schema", () => {
    const err = v.validateResponse(
      { method: "GET", path: "/pets", headers: { "x-tenant": "t1" } },
      { status: 200, contentType: "application/json", body: "should be array" },
    );
    expect(leafCodes(err)).toContain("type");
  });

  it("errors for an undeclared status code", () => {
    const err = v.validateResponse(
      { method: "GET", path: "/pets", headers: { "x-tenant": "t1" } },
      { status: 500 },
    );
    expect(leafCodes(err)).toContain("status");
  });

  it('response header errors are rooted at ["header", name] (singular, matching request side)', () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: {
                  "X-Count": { required: true, schema: { type: "integer", minimum: 0 } },
                },
              },
            },
          },
        },
      },
    };
    const sv = createValidator(spec);

    const missing = sv.validateResponse(
      { method: "GET", path: "/items" },
      { status: 200, headers: {} },
    );
    expect(leafAt(missing, "header.X-Count")).toBeDefined();

    const invalid = sv.validateResponse(
      { method: "GET", path: "/items" },
      { status: 200, headers: { "x-count": "-1" } },
    );
    expect(leafAt(invalid, "header.X-Count")).toBeDefined();

    // Regression for #255: a runtime response with required headers
    // declared in the spec but no `headers` object at all used to slip
    // past validation entirely. Treat absent `headers` as `{}`.
    const absent = sv.validateResponse({ method: "GET", path: "/items" }, { status: 200 });
    expect(leafAt(absent, "header.X-Count")).toBeDefined();
  });

  it("writeOnly properties are rejected in response bodies", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id", "password"],
                      properties: {
                        id: { type: "string" },
                        password: { type: "string", writeOnly: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const sv = createValidator(spec);

    // Server returns writeOnly password → rejected.
    const err = sv.validateResponse(
      { method: "GET", path: "/users" },
      {
        status: 200,
        contentType: "application/json",
        body: { id: "u1", password: "secret" },
      },
    );
    expect(leafAt(err, "body.password")).toBeDefined();

    // Server omits writeOnly password → passes (not required on the response side).
    expect(
      sv.validateResponse(
        { method: "GET", path: "/users" },
        { status: 200, contentType: "application/json", body: { id: "u1" } },
      ),
    ).toBeNull();
  });

  it("writeOnly inside an allOf-referenced subschema is enforced on response bodies", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Secrets: {
            type: "object",
            required: ["password"],
            properties: { password: { type: "string", writeOnly: true } },
          },
          User: {
            allOf: [
              { $ref: "#/components/schemas/Secrets" },
              {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              },
            ],
          },
        },
      },
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/User" } },
                },
              },
            },
          },
        },
      },
    };
    const sv = createValidator(spec);
    // Response omits writeOnly password; should pass.
    expect(
      sv.validateResponse(
        { method: "GET", path: "/users" },
        { status: 200, contentType: "application/json", body: { id: "u1" } },
      ),
    ).toBeNull();
    // Response includes writeOnly password; rejected.
    const err = sv.validateResponse(
      { method: "GET", path: "/users" },
      {
        status: 200,
        contentType: "application/json",
        body: { id: "u1", password: "secret" },
      },
    );
    expect(leafAt(err, "body.password")).toBeDefined();
  });
});

describe("requireResponseBody", () => {
  const spec: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/users/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
            "201": { description: "no declared content" },
            "204": {
              description: "bodyless status that still declares content",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "304": {
              description: "not modified, content declared",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
  const req = { method: "GET", path: "/users/u1" };

  it("is off by default: declared content with an absent body passes", () => {
    const v = createValidator(spec);
    expect(v.validateResponse(req, { status: 200, contentType: "application/json" })).toBeNull();
  });

  it("emits a body leaf when declared content has no body", () => {
    const v = createValidator(spec, { requireResponseBody: true });
    const err = v.validateResponse(req, { status: 200, contentType: "application/json" });
    expect(leafCodes(err)).toContain("body");
    expect(leafAt(err, "body")?.message).toContain("declares content but no body was sent");
  });

  it("a present, valid body still passes", () => {
    const v = createValidator(spec, { requireResponseBody: true });
    expect(
      v.validateResponse(req, {
        status: 200,
        contentType: "application/json",
        body: { id: "u1" },
      }),
    ).toBeNull();
  });

  it("does not fire when the matched response declares no content", () => {
    const v = createValidator(spec, { requireResponseBody: true });
    expect(v.validateResponse(req, { status: 201 })).toBeNull();
  });

  it("exempts HEAD answered by the GET operation", () => {
    const v = createValidator(spec, { requireResponseBody: true });
    expect(
      v.validateResponse(
        { method: "HEAD", path: "/users/u1" },
        { status: 200, contentType: "application/json" },
      ),
    ).toBeNull();
  });

  it("exempts bodyless statuses (204, 304) even with declared content", () => {
    const v = createValidator(spec, { requireResponseBody: true });
    expect(v.validateResponse(req, { status: 204 })).toBeNull();
    expect(v.validateResponse(req, { status: 304 })).toBeNull();
  });
});
