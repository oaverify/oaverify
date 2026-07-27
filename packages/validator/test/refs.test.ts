/**
 * Operation-level $ref handling: OpenAPI permits `ReferenceObject`s at
 * `requestBody`, `responses[code]`, `parameters[i]`, and
 * `response.headers[name]`. The validator must resolve these against
 * the spec before compiling schemas; verdicts must match the inlined
 * equivalent exactly.
 */

import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createMemoryReader, resolveSpec } from "@oaverify/internal-spec";
import { createValidator } from "./fixtures.js";

describe("operation-level $ref resolution", () => {
  it("resolves requestBody $ref", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/things": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/Thing" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          Thing: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string", minLength: 1 } },
                },
              },
            },
          },
        },
      },
    };
    const v = createValidator(spec);
    expect(
      v.validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: { name: "ok" },
      }),
    ).toBeNull();
    const err = v.validateRequest({
      method: "POST",
      path: "/things",
      contentType: "application/json",
      body: { name: "" },
    });
    expect(err).not.toBeNull();
  });

  it("enforces requestBody.required after ref resolution", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/things": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/Thing" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          Thing: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    };
    const v = createValidator(spec);
    const err = v.validateRequest({ method: "POST", path: "/things" });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("request");
  });

  it("resolves response $ref and its header $ref", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/things": {
          get: {
            responses: {
              "200": { $ref: "#/components/responses/ThingOk" },
            },
          },
        },
      },
      components: {
        responses: {
          ThingOk: {
            description: "ok",
            headers: {
              "X-Rate-Limit": { $ref: "#/components/headers/RateLimit" },
            },
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        headers: {
          RateLimit: {
            required: true,
            schema: { type: "integer", minimum: 0 },
          },
        },
      },
    };
    const v = createValidator(spec);
    // All required headers present, body matches → clean
    expect(
      v.validateResponse(
        { method: "GET", path: "/things" },
        {
          status: 200,
          contentType: "application/json",
          headers: { "x-rate-limit": "10" },
          body: ["a", "b"],
        },
      ),
    ).toBeNull();
    // Missing required header → fails
    const errMissing = v.validateResponse(
      { method: "GET", path: "/things" },
      {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: ["a"],
      },
    );
    expect(errMissing).not.toBeNull();
    // Body shape wrong → fails body validation
    const errBody = v.validateResponse(
      { method: "GET", path: "/things" },
      {
        status: 200,
        contentType: "application/json",
        headers: { "x-rate-limit": "5" },
        body: [1, 2] as unknown as string[],
      },
    );
    expect(errBody).not.toBeNull();
  });

  it("resolves parameter $ref at path-item and operation levels", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/items/{id}": {
          parameters: [{ $ref: "#/components/parameters/Id" }],
          get: {
            parameters: [{ $ref: "#/components/parameters/Limit" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        parameters: {
          Id: {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
          },
          Limit: {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", maximum: 100 },
          },
        },
      },
    };
    const v = createValidator(spec);
    // id=5, limit=10 → ok
    expect(
      v.validateRequest({
        method: "GET",
        path: "/items/5",
        query: { limit: "10" },
      }),
    ).toBeNull();
    // id=0 violates minimum
    expect(
      v.validateRequest({
        method: "GET",
        path: "/items/0",
        query: { limit: "10" },
      }),
    ).not.toBeNull();
    // limit=999 violates maximum
    expect(
      v.validateRequest({
        method: "GET",
        path: "/items/5",
        query: { limit: "999" },
      }),
    ).not.toBeNull();
  });

  it("resolves chained $refs (ref → ref → concrete)", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/things": {
          post: {
            // This $ref points to another $ref, which points to the real body.
            requestBody: { $ref: "#/components/requestBodies/Alias" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          Alias: { $ref: "#/components/requestBodies/Real" } as never,
          Real: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["x"], properties: { x: { type: "integer" } } },
              },
            },
          },
        },
      },
    };
    const v = createValidator(spec);
    expect(
      v.validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: { x: 1 },
      }),
    ).toBeNull();
    expect(
      v.validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: { x: "no" } as unknown as { x: number },
      }),
    ).not.toBeNull();
  });

  it("throws at construction if a $ref chain cycles", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/A" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          A: { $ref: "#/components/requestBodies/B" } as never,
          B: { $ref: "#/components/requestBodies/A" } as never,
        },
      },
    };
    const v = createValidator(spec);
    expect(() =>
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: {},
      }),
    ).toThrow(/chain|cycle/i);
  });

  it("validates a request with cross-file circular schema refs", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/nodes": {
                post: {
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": { schema: { $ref: "node.json#/Node" } },
                    },
                  },
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          },
        ],
        [
          "node.json",
          {
            Node: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1 },
                next: { $ref: "node.json#/Node" },
              },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const v = createValidator(document);
    expect(
      v.validateRequest({
        method: "POST",
        path: "/nodes",
        contentType: "application/json",
        body: { name: "a", next: { name: "b", next: { name: "c" } } },
      }),
    ).toBeNull();
    const err = v.validateRequest({
      method: "POST",
      path: "/nodes",
      contentType: "application/json",
      body: { name: "a", next: { name: "" } },
    });
    expect(err).not.toBeNull();
  });

  it("throws with a helpful message on unresolved external $ref", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "refs", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: { $ref: "other.yaml#/components/requestBodies/X" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const v = createValidator(spec);
    expect(() =>
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: {},
      }),
    ).toThrow(/external ref/);
  });
});
