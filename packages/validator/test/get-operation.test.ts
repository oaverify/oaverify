import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { applyOverlays } from "@oaverify/internal-spec";
import { createValidator } from "../src/validator.js";

/**
 * Startup-time introspection: `getOperation` returns the resolved +
 * overlay-applied `OperationObject` for a (method, path) pair.
 * Consumers use it to derive middleware config (multer limits,
 * accepted content types, required headers) from the same source of
 * truth the validator uses.
 */

function uploadSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "uploads", version: "1" },
    paths: {
      "/uploads": {
        post: {
          operationId: "uploadOne",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary", maxLength: 2_000_000 },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "ok" } },
        },
      },
      "/items/{id}": {
        get: {
          operationId: "getItem",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("Validator.getOperation", () => {
  it("returns the operation + path metadata for a matching request", () => {
    const v = createValidator(uploadSpec());
    const info = v.getOperation({ method: "POST", path: "/uploads" });
    expect(info).not.toBeNull();
    expect(info?.pathPattern).toBe("/uploads");
    expect(info?.operation.operationId).toBe("uploadOne");
    const mediaTypes = Object.keys(info?.operation.requestBody?.content ?? {});
    expect(mediaTypes).toEqual(["multipart/form-data"]);
  });

  it("returns null for an unknown path", () => {
    const v = createValidator(uploadSpec());
    expect(v.getOperation({ method: "GET", path: "/nope" })).toBeNull();
  });

  it("returns null for a path that matches but a method that isn't declared", () => {
    const v = createValidator(uploadSpec());
    // /items/{id} declares GET only.
    expect(v.getOperation({ method: "DELETE", path: "/items/42" })).toBeNull();
  });

  it("resolves path templates: /items/42 matches /items/{id}", () => {
    const v = createValidator(uploadSpec());
    const info = v.getOperation({ method: "GET", path: "/items/42" });
    expect(info?.pathPattern).toBe("/items/{id}");
    expect(info?.operation.operationId).toBe("getItem");
  });

  it("reflects overlays applied before createValidator", () => {
    const patched = applyOverlays(uploadSpec(), [
      {
        overrides: {
          "/uploads": {
            operations: {
              post: {
                upsertParameters: [
                  {
                    name: "X-Tenant",
                    in: "header",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const v = createValidator(patched);
    const info = v.getOperation({ method: "POST", path: "/uploads" });
    const headers = (info?.operation.parameters ?? []).filter(
      (p) => "in" in p && p.in === "header",
    );
    expect(headers).toHaveLength(1);
    expect(headers[0] && "name" in headers[0] ? headers[0].name : undefined).toBe("X-Tenant");
  });

  it("reads spec-declared body size limits for middleware wiring (multer-style)", () => {
    const v = createValidator(uploadSpec());
    const info = v.getOperation({ method: "POST", path: "/uploads" });
    // The user walks the schema the way their middleware needs; the
    // point of the getter is just that the walk sees the post-overlay
    // operation without the consumer rediscovering path matching.
    const schema = info?.operation.requestBody?.content["multipart/form-data"]?.schema as
      | { properties?: { file?: { maxLength?: number } } }
      | undefined;
    expect(schema?.properties?.file?.maxLength).toBe(2_000_000);
  });
});
