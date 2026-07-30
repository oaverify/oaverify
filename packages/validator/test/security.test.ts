import type { ErrorParamsFor, OpenAPIDocument, ValidationError } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "./fixtures.js";

/**
 * Shape-only security validation coverage: bearer / basic / apiKey.
 * Credential verification is explicitly out of scope; these tests only
 * exercise presence + structural shape of the declared credential
 * location.
 */

function specWith(
  securitySchemes: Record<string, unknown>,
  operationSecurity: Array<Record<string, string[]>> | undefined,
  topLevelSecurity?: Array<Record<string, string[]>>,
): OpenAPIDocument {
  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: { securitySchemes: securitySchemes as never },
    paths: {
      "/ping": {
        get: {
          ...(operationSecurity !== undefined ? { security: operationSecurity } : {}),
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
  if (topLevelSecurity !== undefined) doc.security = topLevelSecurity;
  return doc;
}

function firstLeaf(err: ValidationError | null): ValidationError | null {
  if (err === null) return null;
  if (err.children.length === 0) return err;
  return firstLeaf(err.children[0] ?? null);
}

describe("security validation: bearer (http / bearer)", () => {
  const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [{ bearerAuth: [] }]);
  const v = createValidator(spec, { validateSecurity: "shape" });

  it("accepts Authorization: Bearer <token>", () => {
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { authorization: "Bearer abc.def.ghi" },
      }),
    ).toBeNull();
  });

  it("matches the Authorization header case-insensitively", () => {
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { Authorization: "Bearer abc.def.ghi" },
      }),
    ).toBeNull();
  });

  it("is case-insensitive on the scheme keyword", () => {
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { authorization: "bearer abc" },
      }),
    ).toBeNull();
  });

  it("rejects when the Authorization header is absent", () => {
    const err = v.validateRequest({ method: "GET", path: "/ping" });
    expect(err?.code).toBe("request");
    const leaf = firstLeaf(err);
    expect(leaf?.code).toBe("security");
    const params = leaf?.params as ErrorParamsFor<"security">;
    expect(params.declared).toEqual([["bearerAuth"]]);
  });

  it("rejects a non-Bearer Authorization header", () => {
    const err = v.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(firstLeaf(err)?.code).toBe("security");
  });

  it("rejects Bearer with an empty token", () => {
    const err = v.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { authorization: "Bearer " },
    });
    expect(firstLeaf(err)?.code).toBe("security");
  });
});

describe("security validation: basic (http / basic)", () => {
  const spec = specWith({ basicAuth: { type: "http", scheme: "basic" } }, [{ basicAuth: [] }]);
  const v = createValidator(spec, { validateSecurity: "shape" });

  it("accepts a well-formed Basic credential", () => {
    const creds = Buffer.from("user:pass").toString("base64");
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { authorization: `Basic ${creds}` },
      }),
    ).toBeNull();
  });

  it("rejects a Basic header whose payload isn't base64", () => {
    const err = v.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { authorization: "Basic not!!base64@@" },
    });
    expect(firstLeaf(err)?.code).toBe("security");
  });

  it("rejects a Basic header whose base64 lacks the 'user:pass' colon", () => {
    const payload = Buffer.from("nousercolonhere").toString("base64");
    const err = v.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { authorization: `Basic ${payload}` },
    });
    expect(firstLeaf(err)?.code).toBe("security");
  });

  it("rejects when the Authorization header is absent", () => {
    const err = v.validateRequest({ method: "GET", path: "/ping" });
    expect(firstLeaf(err)?.code).toBe("security");
  });
});

describe("security validation: apiKey", () => {
  it("header: missing rejects; present accepts", () => {
    const spec = specWith({ apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } }, [
      { apiKeyAuth: [] },
    ]);
    const v = createValidator(spec, { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/ping" })?.code).toBe("request");
    expect(
      v.validateRequest({ method: "GET", path: "/ping", headers: { "x-api-key": "abc" } }),
    ).toBeNull();
    expect(
      v.validateRequest({ method: "GET", path: "/ping", headers: { "X-API-KEY": "abc" } }),
    ).toBeNull();
  });

  it("header: empty string is treated as missing", () => {
    const spec = specWith({ apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } }, [
      { apiKeyAuth: [] },
    ]);
    const v = createValidator(spec, { validateSecurity: "shape" });
    const err = v.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { "x-api-key": "" },
    });
    expect(firstLeaf(err)?.code).toBe("security");
  });

  it("query: missing rejects; present accepts", () => {
    const spec = specWith({ apiKeyAuth: { type: "apiKey", in: "query", name: "api_key" } }, [
      { apiKeyAuth: [] },
    ]);
    const v = createValidator(spec, { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/ping" })?.code).toBe("request");
    expect(
      v.validateRequest({ method: "GET", path: "/ping", query: { api_key: "abc" } }),
    ).toBeNull();
  });

  it("cookie: missing rejects; present accepts", () => {
    const spec = specWith({ apiKeyAuth: { type: "apiKey", in: "cookie", name: "session" } }, [
      { apiKeyAuth: [] },
    ]);
    const v = createValidator(spec, { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/ping" })?.code).toBe("request");
    expect(
      v.validateRequest({ method: "GET", path: "/ping", cookies: { session: "abc" } }),
    ).toBeNull();
  });
});

describe("security validation: OR across alternatives, AND within", () => {
  const spec = specWith(
    {
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    [{ bearerAuth: [] }, { apiKeyAuth: [] }],
  );
  const v = createValidator(spec, { validateSecurity: "shape" });

  it("either scheme on its own satisfies the operation", () => {
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { authorization: "Bearer a" },
      }),
    ).toBeNull();
    expect(
      v.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { "x-api-key": "a" },
      }),
    ).toBeNull();
  });

  it("neither present rejects; declared lists both alternatives", () => {
    const err = v.validateRequest({ method: "GET", path: "/ping" });
    const leaf = firstLeaf(err);
    expect(leaf?.code).toBe("security");
    const params = leaf?.params as ErrorParamsFor<"security">;
    expect(params.declared).toEqual([["bearerAuth"], ["apiKeyAuth"]]);
  });

  it("AND within a single requirement: missing one fails", () => {
    const andSpec = specWith(
      {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      [{ bearerAuth: [], apiKeyAuth: [] }],
    );
    const andV = createValidator(andSpec, { validateSecurity: "shape" });

    // Only the bearer is present; AND fails.
    const err = andV.validateRequest({
      method: "GET",
      path: "/ping",
      headers: { authorization: "Bearer a" },
    });
    expect(firstLeaf(err)?.code).toBe("security");

    // Both present; passes.
    expect(
      andV.validateRequest({
        method: "GET",
        path: "/ping",
        headers: { authorization: "Bearer a", "x-api-key": "k" },
      }),
    ).toBeNull();
  });
});

describe("security validation: top-level vs operation-level", () => {
  it("operation `security: []` opts out of a top-level requirement", () => {
    const spec = specWith(
      { bearerAuth: { type: "http", scheme: "bearer" } },
      [], // explicit opt-out on the operation
      [{ bearerAuth: [] }], // top-level requirement
    );
    const v = createValidator(spec, { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/ping" })).toBeNull();
  });

  it("operation inherits top-level security when it doesn't declare its own", () => {
    const spec = specWith(
      { bearerAuth: { type: "http", scheme: "bearer" } },
      undefined, // operation omits the field
      [{ bearerAuth: [] }],
    );
    const v = createValidator(spec, { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/ping" })?.code).toBe("request");
  });
});

describe("security validation: configuration", () => {
  it("defaults to off: security is not enforced unless validateSecurity is set", () => {
    // The default reflects the "auth middleware runs upstream" reality:
    // by the time the validator sees a request, the credential has
    // already been verified (or rejected) by the host app's auth layer.
    // Opt in with `"shape"` for dev / prototyping without auth middleware
    // or for decorator-only auth that doesn't reject unauthenticated.
    const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [{ bearerAuth: [] }]);
    const v = createValidator(spec);
    expect(v.validateRequest({ method: "GET", path: "/ping" })).toBeNull();
  });

  it("an undeclared scheme name fails the check (fail-closed, no silent pass)", () => {
    const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [{ typoAuth: [] }]);
    const v = createValidator(spec, { validateSecurity: "shape" });
    const err = v.validateRequest({ method: "GET", path: "/ping" });
    expect(firstLeaf(err)?.code).toBe("security");
  });

  it("short-circuits before parameter / body checks: only a security error surfaces", () => {
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths: {
        "/echo": {
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", required: ["name"] },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const v = createValidator(doc, { validateSecurity: "shape" });
    const err = v.validateRequest({
      method: "POST",
      path: "/echo",
      contentType: "application/json",
      body: {}, // missing `name`, normally a second error
    });
    // Only one child error (security); body violation is suppressed.
    expect(err?.code).toBe("request");
    expect(err?.children).toHaveLength(1);
    expect(err?.children[0]?.code).toBe("security");
  });

  it("oauth2 / openIdConnect schemes are accepted but not shape-checked", () => {
    const spec = specWith(
      {
        oauth: {
          type: "oauth2",
          flows: { implicit: { authorizationUrl: "https://example.com/auth", scopes: {} } },
        },
      },
      [{ oauth: ["read"] }],
    );
    const v = createValidator(spec, { validateSecurity: "shape" });
    // No headers / query; oauth2 isn't shape-checked, so pass.
    expect(v.validateRequest({ method: "GET", path: "/ping" })).toBeNull();
  });

  describe('validateSecurity: "off" | "shape" | "strict"', () => {
    it('"off" skips the check (same as default / `false`)', () => {
      const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [
        { bearerAuth: [] },
      ]);
      const v = createValidator(spec, { validateSecurity: "off" });
      expect(v.validateRequest({ method: "GET", path: "/ping" })).toBeNull();
    });

    it('"shape" matches the legacy `true` behavior on recognized schemes', () => {
      const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [
        { bearerAuth: [] },
      ]);
      const v = createValidator(spec, { validateSecurity: "shape" });
      expect(v.validateRequest({ method: "GET", path: "/ping" })?.code).toBe("request");
      expect(
        v.validateRequest({
          method: "GET",
          path: "/ping",
          headers: { authorization: "Bearer abc" },
        }),
      ).toBeNull();
    });

    it('"shape" silently passes on oauth2 (matching legacy `true`)', () => {
      const spec = specWith(
        {
          oauth: {
            type: "oauth2",
            flows: { implicit: { authorizationUrl: "https://example.com/auth", scopes: {} } },
          },
        },
        [{ oauth: ["read"] }],
      );
      const v = createValidator(spec, { validateSecurity: "shape" });
      expect(v.validateRequest({ method: "GET", path: "/ping" })).toBeNull();
    });

    it('"strict" rejects oauth2 with a security leaf error', () => {
      const spec = specWith(
        {
          oauth: {
            type: "oauth2",
            flows: { implicit: { authorizationUrl: "https://example.com/auth", scopes: {} } },
          },
        },
        [{ oauth: ["read"] }],
      );
      const v = createValidator(spec, { validateSecurity: "strict" });
      const err = v.validateRequest({ method: "GET", path: "/ping" });
      expect(firstLeaf(err)?.code).toBe("security");
    });

    it('"strict" rejects openIdConnect / mutualTLS', () => {
      const oidcSpec = specWith(
        { oidc: { type: "openIdConnect", openIdConnectUrl: "https://example.com/.well-known" } },
        [{ oidc: [] }],
      );
      const oidcV = createValidator(oidcSpec, { validateSecurity: "strict" });
      expect(firstLeaf(oidcV.validateRequest({ method: "GET", path: "/ping" }))?.code).toBe(
        "security",
      );

      const mtlsSpec = specWith({ mtls: { type: "mutualTLS" } }, [{ mtls: [] }]);
      const mtlsV = createValidator(mtlsSpec, { validateSecurity: "strict" });
      expect(firstLeaf(mtlsV.validateRequest({ method: "GET", path: "/ping" }))?.code).toBe(
        "security",
      );
    });

    it('"strict" rejects HTTP non-bearer / non-basic (digest etc.)', () => {
      const spec = specWith({ digestAuth: { type: "http", scheme: "digest" } }, [
        { digestAuth: [] },
      ]);
      const v = createValidator(spec, { validateSecurity: "strict" });
      expect(firstLeaf(v.validateRequest({ method: "GET", path: "/ping" }))?.code).toBe("security");
    });

    it('"strict" still accepts recognized schemes when the credential is well-formed', () => {
      const spec = specWith({ bearerAuth: { type: "http", scheme: "bearer" } }, [
        { bearerAuth: [] },
      ]);
      const v = createValidator(spec, { validateSecurity: "strict" });
      expect(
        v.validateRequest({
          method: "GET",
          path: "/ping",
          headers: { authorization: "Bearer abc" },
        }),
      ).toBeNull();
    });
  });
});
