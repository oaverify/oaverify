import { collectLeaves, httpStatusFor, type OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator, leafAt, leafCodes, petSpec } from "./fixtures.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";

describe("validateRequest", () => {
  const v = createValidator(petSpec());

  it("returns null for a valid request", () => {
    expect(
      v.validateRequest({
        method: "POST",
        path: "/pets",
        contentType: "application/json",
        headers: { "x-tenant": "t1" },
        body: { name: "Fido" },
      }),
    ).toBeNull();
  });

  it("matches request header parameters case-insensitively", () => {
    expect(
      v.validateRequest({
        method: "POST",
        path: "/pets",
        contentType: "application/json",
        headers: { "X-TENANT": "t1" },
        body: { name: "Fido" },
      }),
    ).toBeNull();
  });

  it("errors for a body that violates its schema", () => {
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      headers: { "x-tenant": "t1" },
      body: { age: -1 },
    });
    expect(err?.code).toBe("request");
    expect(leafAt(err, "body.age")?.code).toBe("minimum");
  });

  it("errors when required header is missing", () => {
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: "x" },
    });
    expect(leafCodes(err)).toContain("header-param");
  });

  it("errors for unknown route", () => {
    const err = v.validateRequest({ method: "DELETE", path: "/nope" });
    expect(err?.code).toBe("route");
  });

  it("errors with `method` (not `route`) when the path exists but the verb doesn't", () => {
    // /pets declares GET + POST; DELETE is 405, not 404.
    const err = v.validateRequest({ method: "DELETE", path: "/pets" });
    expect(err?.code).toBe("method");
    expect(err?.params).toMatchObject({
      method: "DELETE",
      pathPattern: "/pets",
      allowed: ["GET", "HEAD", "POST"],
    });
  });

  it("ignoreUndocumented: true suppresses the route error", () => {
    const vi = createValidator(petSpec(), { ignoreUndocumented: true });
    expect(vi.validateRequest({ method: "GET", path: "/nope" })).toBeNull();
  });

  it("ignoreUndocumented does not suppress the method error (405 still surfaces)", () => {
    const vi = createValidator(petSpec(), { ignoreUndocumented: true });
    const err = vi.validateRequest({ method: "DELETE", path: "/pets" });
    expect(err?.code).toBe("method");
  });

  it("ignorePaths runs before routing and short-circuits to null", () => {
    const vi = createValidator(petSpec(), {
      ignorePaths: (p) => p.startsWith("/internal/"),
    });
    // /internal/* isn't in the spec; predicate matches → null
    expect(vi.validateRequest({ method: "GET", path: "/internal/health" })).toBeNull();
    // /nope isn't in the spec; predicate doesn't match → route error
    expect(vi.validateRequest({ method: "GET", path: "/nope" })?.code).toBe("route");
  });

  it('schemaLint: "strict" surfaces unknown-keyword issues through validator.stats', () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/p": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  // minLenght is a typo (the actual keyword is minLength).
                  schema: {
                    type: "string",
                    minLenght: 3,
                  } as unknown as SchemaOrBoolean,
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const vi = createValidator(spec, { schemaLint: "strict" });
    // Schemas compile lazily; first touch to the route triggers it.
    vi.validateRequest({ method: "POST", path: "/p", contentType: "application/json", body: "x" });
    const unknown = vi.stats.schemaLintIssues.find((i) => i.code === "unknown-keyword");
    expect(unknown).toBeDefined();
    expect(unknown?.keyword).toBe("minLenght");
  });

  it("strict mode surfaces silent-rewrite/redundant-composition-branches after binary-bypass collapse", () => {
    // Two branches that look distinct in the source spec ({string +
    // format:binary} vs {string + format:binary + description}) collapse
    // to identical empty schemas after the validator's binary bypass.
    // The lint surfaces from the post-transform shape.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      file: {
                        oneOf: [
                          { type: "string", format: "binary" },
                          { type: "string", format: "binary", description: "the upload" },
                        ],
                      },
                    },
                  } as unknown as SchemaOrBoolean,
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const vi = createValidator(spec);
    // Lazy compile: trigger the request-side schema compile.
    vi.validateRequest({
      method: "POST",
      path: "/upload",
      contentType: "multipart/form-data",
      body: { file: Buffer.from("x") },
    });
    const redundant = vi.stats.schemaLintIssues.find(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    expect(redundant).toBeDefined();
    expect(redundant?.keyword).toBe("oneOf");
  });

  it("errors for wrong Content-Type", () => {
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "text/plain",
      headers: { "x-tenant": "t1" },
      body: "raw",
    });
    expect(leafCodes(err)).toContain("content-type");
  });

  it("absent body + unmatched Content-Type → content-type leaf (415), not body-required (400)", () => {
    // Spec accepts only multipart/form-data. Client says text/plain and
    // sends no body. Today's bug: the gate skipped body-absent requests
    // entirely, so validateBody fired "missing required request body"
    // (400), true but downstream of the actual cause. Now the gate
    // sees the unmatched header and surfaces a content-type leaf (415),
    // which is the actionable signal.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: { "multipart/form-data": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({
      method: "POST",
      path: "/upload",
      contentType: "text/plain",
    });
    const leaves = collectLeaves(err!);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.code).toBe("content-type");
    expect(httpStatusFor(err!)).toBe(415);
  });

  it("absent body + no Content-Type → body-required leaf (400), not content-type", () => {
    // Regression guard for the body-absent fix: with no header, the
    // client said nothing about the payload, so the actionable signal
    // is the missing required body (400). The naive "swap the gate
    // unconditionally" fix would regress this to a less-helpful 415
    // for a header the client never sent.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({ method: "POST", path: "/x" });
    const leaves = collectLeaves(err!);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.code).toBe("body");
    expect(httpStatusFor(err!)).toBe(400);
  });

  it("content-type gate short-circuits before parameter validation", () => {
    // Wrong Content-Type AND missing required X-Tenant header. The gate
    // fires first, so the tree is a single content-type leaf, no
    // paired header-param diagnostic. Motivation: a client who fixes
    // the content-type can't act on a header-param complaint anyway;
    // surface the upstream problem unambiguously.
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "text/plain",
      body: "raw",
      // no X-Tenant header
    });
    const leaves = collectLeaves(err!);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.code).toBe("content-type");
  });

  it("deserializes path parameters to their declared type", () => {
    expect(v.validateRequest({ method: "GET", path: "/pets/42" })).toBeNull();
    const err = v.validateRequest({ method: "GET", path: "/pets/abc" });
    expect(leafCodes(err)).toContain("type");
  });

  it("deserializes query parameters (string → integer)", () => {
    const err = v.validateRequest({
      method: "GET",
      path: "/pets",
      query: { limit: "0" },
      headers: { "x-tenant": "t1" },
    });
    expect(leafCodes(err)).toContain("minimum");
  });

  it("aggregates body + query + header errors into a single tree", () => {
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      // missing X-Tenant, invalid body
      body: { age: "not a number" },
    });
    expect(leafCodes(err)).toContain("header-param");
  });

  it("empty-string query param is not treated as missing", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/search": {
          get: {
            parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(sv.validateRequest({ method: "GET", path: "/search", query: { q: "" } })).toBeNull();
  });

  it("empty-string query param is rejected by a minLength:1 schema", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/search": {
          get: {
            parameters: [
              {
                name: "q",
                in: "query",
                required: true,
                schema: { type: "string", minLength: 1 },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({ method: "GET", path: "/search", query: { q: "" } });
    expect(leafCodes(err)).toContain("minLength");
  });

  it("assembles form/explode object query params from top-level query keys", () => {
    // OAS `style: form, explode: true` (the default for query) spreads
    // an object across top-level keys: ?role=admin&firstName=Alex should
    // populate filter = { role: "admin", firstName: "Alex" }.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                required: true,
                schema: {
                  type: "object",
                  required: ["role"],
                  properties: {
                    role: { type: "string" },
                    firstName: { type: "string" },
                    age: { type: "integer" },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    // All three property keys present; integer is coerced.
    expect(
      sv.validateRequest({
        method: "GET",
        path: "/x",
        query: { role: "admin", firstName: "Alex", age: "42" },
      }),
    ).toBeNull();
    // Required role missing from a partial payload → required error.
    const err = sv.validateRequest({
      method: "GET",
      path: "/x",
      query: { firstName: "Alex" },
    });
    expect(leafCodes(err)).toContain("required");
    // No matching keys at all → missing required param.
    const missing = sv.validateRequest({ method: "GET", path: "/x" });
    expect(leafCodes(missing)).toContain("query-param");
  });

  it("assembles deepObject query params (?color[r]=100&color[g]=50)", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/paint": {
          get: {
            parameters: [
              {
                name: "color",
                in: "query",
                style: "deepObject",
                schema: {
                  type: "object",
                  properties: {
                    r: { type: "string" },
                    g: { type: "string" },
                    b: { type: "string" },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(
      sv.validateRequest({
        method: "GET",
        path: "/paint",
        query: { "color[r]": "100", "color[g]": "50" },
      }),
    ).toBeNull();
    // Keys outside the prefix are ignored (don't collide with other params).
    expect(
      sv.validateRequest({
        method: "GET",
        path: "/paint",
        query: { "color[r]": "100", other: "ignored" },
      }),
    ).toBeNull();
  });

  it("reports distinct paths when two properties share a $ref", () => {
    // openapi-backend #730: a component schema referenced by multiple
    // properties must surface the failing property's path on each error,
    // not the first $ref usage.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Measurement: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "number" } },
          },
        },
      },
      paths: {
        "/m": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      weight: { $ref: "#/components/schemas/Measurement" },
                      temperature: { $ref: "#/components/schemas/Measurement" },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({
      method: "POST",
      path: "/m",
      contentType: "application/json",
      body: { weight: {}, temperature: {} },
    });
    const leaves = collectLeaves(err ?? undefined!).filter((l) => l.code === "required");
    const paths = leaves.map((l) => l.path.join("."));
    // Each error's path carries the parent property's slot (weight vs
    // temperature), not a single shared location derived from the
    // $ref site.
    expect(paths.sort()).toEqual(["body.temperature.value", "body.weight.value"]);
  });

  it("response validation flags undeclared status codes", () => {
    // openapi-backend #384.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/p": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateResponse({ method: "GET", path: "/p" }, { status: 204 });
    const leaf = collectLeaves(err ?? undefined!).find((l) => l.code === "status");
    expect(leaf?.params).toMatchObject({ status: 204 });
  });

  it("optional requestBody:required=false passes when the body is omitted", () => {
    // openapi-backend #817 / #292. Distinct from the bareboss no-body
    // case; here the spec declares content but explicitly marks it
    // non-required.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/maybe": {
          post: {
            requestBody: {
              required: false,
              content: {
                "application/json": { schema: { type: "object", required: ["name"] } },
              },
            },
            responses: { "204": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(sv.validateRequest({ method: "POST", path: "/maybe" })).toBeNull();
    // But if the caller does send a body, the schema still applies.
    const err = sv.validateRequest({
      method: "POST",
      path: "/maybe",
      contentType: "application/json",
      body: {},
    });
    expect(leafCodes(err)).toContain("required");
  });

  it("treats an explicit JSON null body as a value, not an absent body", () => {
    // #706. Only `undefined` means absent. `null` is a parsed JSON value
    // and has to reach the schema in both directions.
    const spec = (schema: SchemaOrBoolean, required: boolean): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/n": {
          post: {
            requestBody: { required, content: { "application/json": { schema } } },
            responses: { "204": { description: "ok" } },
          },
        },
      },
    });
    const req = { method: "POST", path: "/n", contentType: "application/json", body: null };

    // Required body, `type: "null"`: null satisfies it. Previously a
    // false reject with "missing required request body".
    expect(createValidator(spec({ type: "null" }, true)).validateRequest(req)).toBeNull();

    // Optional body, `type: "string"`: null violates it. Previously a
    // false accept, since the gate skipped validation entirely.
    const err = createValidator(spec({ type: "string" }, false)).validateRequest(req);
    expect(leafAt(err, "body")?.code).toBe("type");

    // An omitted body is still absent under the same required schema.
    const missing = createValidator(spec({ type: "null" }, true)).validateRequest({
      method: "POST",
      path: "/n",
    });
    expect(leafCodes(missing)).toContain("body");
  });

  it("accepts Buffer / Uint8Array for type:string, format:binary body fields", () => {
    // openapi-backend #860 / #809: multipart binary fields arrive as
    // Buffer / Uint8Array / framework-specific objects, not JS strings.
    // A strict string-type check here would reject every file upload.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    required: ["file"],
                    properties: {
                      name: { type: "string" },
                      file: { type: "string", format: "binary" },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);

    // Buffer-backed field passes.
    expect(
      sv.validateRequest({
        method: "POST",
        path: "/upload",
        contentType: "multipart/form-data",
        body: { name: "hello.txt", file: Buffer.from("hello") },
      }),
    ).toBeNull();
    // Uint8Array also passes.
    expect(
      sv.validateRequest({
        method: "POST",
        path: "/upload",
        contentType: "multipart/form-data",
        body: { name: "x", file: new Uint8Array([1, 2, 3]) },
      }),
    ).toBeNull();
    // But format:byte (base64) stays a string and is checked normally.
    const strictSpec: OpenAPIDocument = {
      ...spec,
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["file"],
                    properties: { file: { type: "string", format: "byte" } },
                  },
                },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const strictSv = createValidator(strictSpec);
    const err = strictSv.validateRequest({
      method: "POST",
      path: "/upload",
      contentType: "application/json",
      body: { file: Buffer.from("nope") },
    });
    expect(leafAt(err, "body.file")?.code).toBe("type");
  });

  it("operation-level parameters replace path-level ones with the same name+in", () => {
    // openapi-backend #46. Path-level param: minLength 1; op-level
    // override: minLength 10. Per OAS 3.x the op-level fully replaces
    // the path-level: a single error with the op-level constraint.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          parameters: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          get: {
            parameters: [
              {
                name: "id",
                in: "query",
                required: true,
                schema: { type: "string", minLength: 10 },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    // "x" fails the op-level constraint (len 1 < 10) and would have
    // passed the path-level (len 1 >= 1). The op-level must win.
    const err = sv.validateRequest({ method: "GET", path: "/users", query: { id: "x" } });
    const leaves = collectLeaves(err ?? undefined!).filter((l) => l.path.join(".") === "query.id");
    // Exactly one leaf, carrying the op-level constraint.
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.params).toMatchObject({ minLength: 10 });
    // And a value that passes the op-level constraint validates cleanly.
    expect(
      sv.validateRequest({ method: "GET", path: "/users", query: { id: "0123456789" } }),
    ).toBeNull();
  });

  it("enforces item-level schemas on array query parameters", () => {
    // eov #917: per-item pattern / minLength checks must run on each
    // element of a deserialized array query param.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/search": {
          get: {
            parameters: [
              {
                name: "tag",
                in: "query",
                required: true,
                explode: false,
                schema: {
                  type: "array",
                  items: { type: "string", pattern: "^[a-z]+$", minLength: 2 },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(
      sv.validateRequest({ method: "GET", path: "/search", query: { tag: "foo,bar" } }),
    ).toBeNull();
    const patternErr = sv.validateRequest({
      method: "GET",
      path: "/search",
      query: { tag: "foo,BAR" },
    });
    expect(leafCodes(patternErr)).toContain("pattern");
    const lengthErr = sv.validateRequest({
      method: "GET",
      path: "/search",
      query: { tag: "foo,b" },
    });
    expect(leafCodes(lengthErr)).toContain("minLength");
  });

  it("resolves parameters declared via $ref", () => {
    // eov #803: operations frequently reference shared parameters from
    // components.parameters.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        parameters: {
          Tenant: { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
        },
      },
      paths: {
        "/pets": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Tenant" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(
      sv.validateRequest({ method: "GET", path: "/pets", headers: { "x-tenant": "t1" } }),
    ).toBeNull();
    const err = sv.validateRequest({ method: "GET", path: "/pets" });
    expect(leafCodes(err)).toContain("header-param");
  });

  it("accepts an optional-body POST with no body and no content-type", () => {
    // eov #397 / #646 / #655: when requestBody is not required and the
    // caller sends nothing, there's nothing to validate; don't error
    // on the missing content-type.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/ping": {
          post: {
            requestBody: {
              required: false,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "204": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(sv.validateRequest({ method: "POST", path: "/ping" })).toBeNull();
  });

  it("format validators let null pass through on nullable OAS 3.0 fields", () => {
    // eov #382 / #108: format checks should not fire for null values on
    // nullable properties; the format predicate only applies to strings.
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      when: { type: "string", format: "date-time", nullable: true },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(
      sv.validateRequest({
        method: "POST",
        path: "/t",
        contentType: "application/json",
        body: { when: null },
      }),
    ).toBeNull();
  });

  it("discriminator failures inside an array carry the index in the body path", () => {
    // eov #669: when a polymorphic body element fails, the error tree
    // must identify which array index broke. Exercises the full
    // body-validation path, not just the schema compiler.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Cat: {
            type: "object",
            required: ["kind", "purr"],
            properties: { kind: { const: "Cat" }, purr: { type: "boolean" } },
          },
          Dog: {
            type: "object",
            required: ["kind", "bark"],
            properties: { kind: { const: "Dog" }, bark: { type: "string" } },
          },
        },
      },
      paths: {
        "/pack": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      discriminator: { propertyName: "kind" },
                      oneOf: [
                        { $ref: "#/components/schemas/Cat" },
                        { $ref: "#/components/schemas/Dog" },
                      ],
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({
      method: "POST",
      path: "/pack",
      contentType: "application/json",
      body: [
        { kind: "Cat", purr: true },
        { kind: "Dog" }, // missing bark
      ],
    });
    const leaf = leafAt(err, "body.1.bark");
    expect(leaf?.code).toBe("required");
  });

  it("readOnly properties are rejected in request bodies", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                      id: { type: "string", readOnly: true },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);

    // Client sends readOnly id → rejected.
    const err = sv.validateRequest({
      method: "POST",
      path: "/users",
      contentType: "application/json",
      body: { id: "x", name: "n" },
    });
    expect(leafAt(err, "body.id")).toBeDefined();

    // Client omits readOnly id → passes (not required on the request side).
    expect(
      sv.validateRequest({
        method: "POST",
        path: "/users",
        contentType: "application/json",
        body: { name: "n" },
      }),
    ).toBeNull();
  });

  it("readOnly inside an allOf-referenced subschema is enforced on request bodies", () => {
    // eov #149 / #389: the classic OpenAPI composition pattern, a
    // per-entity schema extends a shared "timestamps" fragment via
    // allOf + $ref. The shared fragment's readOnly fields (and their
    // required-ness) must be transformed on the request side.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Timestamps: {
            type: "object",
            required: ["createdAt"],
            properties: { createdAt: { type: "string", readOnly: true } },
          },
          User: {
            allOf: [
              { $ref: "#/components/schemas/Timestamps" },
              {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            ],
          },
        },
      },
      paths: {
        "/users": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/User" } },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    // Omitting createdAt should pass; the readOnly field is exempt
    // from required on the request side.
    expect(
      sv.validateRequest({
        method: "POST",
        path: "/users",
        contentType: "application/json",
        body: { name: "n" },
      }),
    ).toBeNull();
    // Sending createdAt should fail; clients must not supply it.
    const err = sv.validateRequest({
      method: "POST",
      path: "/users",
      contentType: "application/json",
      body: { name: "n", createdAt: "2026-01-01" },
    });
    expect(leafAt(err, "body.createdAt")).toBeDefined();
  });

  it("readOnly via $ref is still enforced on request bodies", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          ServerId: { type: "string", readOnly: true },
          User: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { $ref: "#/components/schemas/ServerId" },
              name: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/users": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/User" } },
              },
            },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    const err = sv.validateRequest({
      method: "POST",
      path: "/users",
      contentType: "application/json",
      body: { id: "x", name: "n" },
    });
    expect(leafAt(err, "body.id")).toBeDefined();
  });

  it("parameter.content parses JSON and validates its schema", () => {
    // OpenAPI 3.1 §4.8.12.1 lets a parameter carry `content` instead of
    // `schema`: standard pattern for structured-JSON query params.
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/items": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["x"],
                      properties: { x: { type: "integer" } },
                    },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);

    // Valid JSON against schema → ok.
    expect(
      sv.validateRequest({
        method: "GET",
        path: "/items",
        query: { filter: '{"x":1}' },
      }),
    ).toBeNull();

    // JSON that violates the schema → schema error (not a parse error).
    const schemaErr = sv.validateRequest({
      method: "GET",
      path: "/items",
      query: { filter: '{"x":"nope"}' },
    });
    expect(leafCodes(schemaErr)).toContain("type");

    // Malformed JSON → dedicated content-parse error.
    const parseErr = sv.validateRequest({
      method: "GET",
      path: "/items",
      query: { filter: "{not-json}" },
    });
    const leaf = collectLeaves(parseErr ?? undefined!).find(
      (l) => l.params?.reason === "content-parse",
    );
    expect(leaf?.params).toMatchObject({
      name: "filter",
      in: "query",
      mediaType: "application/json",
    });
  });

  it("allowEmptyValue on a query parameter exempts empty-string from schema validation", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/search": {
          get: {
            parameters: [
              {
                name: "debug",
                in: "query",
                required: false,
                allowEmptyValue: true,
                // A schema that would normally reject "" (allowEmptyValue skips it).
                schema: { type: "string", minLength: 4 },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const sv = createValidator(spec);
    expect(sv.validateRequest({ method: "GET", path: "/search", query: { debug: "" } })).toBeNull();
    const err = sv.validateRequest({ method: "GET", path: "/search", query: { debug: "ab" } });
    expect(leafCodes(err)).toContain("minLength");
  });
});

describe("createValidator option validation", () => {
  it("rejects maxErrors: 0 eagerly at construction", () => {
    // Lazy compile would otherwise defer this until the first
    // request and surface as a per-op compile error. Surface it at
    // construction so misconfiguration fails loudly.
    expect(() => createValidator(petSpec(), { maxErrors: 0 })).toThrow(
      /must be a positive integer/,
    );
  });

  it("rejects negative and non-integer maxErrors", () => {
    expect(() => createValidator(petSpec(), { maxErrors: -1 })).toThrow(
      /must be a positive integer/,
    );
    expect(() => createValidator(petSpec(), { maxErrors: 1.5 })).toThrow(
      /must be a positive integer/,
    );
  });

  it("accepts maxErrors: 1 (fast-fail) and finite positive integers", () => {
    expect(() => createValidator(petSpec(), { maxErrors: 1 })).not.toThrow();
    expect(() => createValidator(petSpec(), { maxErrors: 100 })).not.toThrow();
  });

  it("specHygieneIssues is empty by default (lint not requested)", () => {
    const v = createValidator(petSpec());
    expect(v.specHygieneIssues).toEqual([]);
  });

  it("populates specHygieneIssues when lint: true and the spec has hygiene issues", () => {
    const spec = petSpec();
    spec.components = {
      ...spec.components,
      schemas: { ...spec.components?.schemas, Orphan: { type: "object" } },
    };
    const v = createValidator(spec, { lint: true });
    expect(v.specHygieneIssues.some((i) => i.code === "unused-component")).toBe(true);
  });

  it("specHygieneIssues is frozen (callers can't mutate it)", () => {
    const v = createValidator(petSpec(), { lint: true });
    expect(Object.isFrozen(v.specHygieneIssues)).toBe(true);
  });
});

describe("Content-Type is read from the field, not the header", () => {
  // `HttpRequest.contentType` is the only source, deliberately. The trap
  // is that `Content-Type` *is* a header and header parameters are
  // matched case-insensitively, so filling in `headers` and leaving the
  // field unset looks right. The old message said the type was
  // "<missing>" for something the caller had supplied.
  const spec: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "ct", version: "1" },
    paths: {
      "/p": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
  const sv = createValidator(spec);

  const requestLeaf = (extra: Record<string, unknown>) => {
    const err = sv.validateRequest({ method: "POST", path: "/p", body: {}, ...extra });
    return err === null ? undefined : collectLeaves(err)[0];
  };

  it("does not accept a request whose media type is only in headers", () => {
    for (const headers of [
      { "content-type": "application/json" },
      { "Content-Type": "application/json" },
    ]) {
      expect(requestLeaf({ headers })?.code).toBe("content-type");
    }
    expect(requestLeaf({ contentType: "application/json" })).toBeUndefined();
  });

  it("names the ignored header instead of claiming the type is missing", () => {
    const message = requestLeaf({ headers: { "content-type": "application/json" } })?.message;
    expect(message).toContain("set HttpRequest.contentType");
    expect(message).toContain('the "content-type" header is not read');
  });

  it("leaves the genuinely-absent and genuinely-mismatched messages alone", () => {
    // No hint here: there is no header to point at, so the type really
    // is missing and the original wording is the accurate one.
    expect(requestLeaf({})?.message).toBe('request Content-Type "<missing>" is not accepted');
    expect(requestLeaf({ contentType: "text/plain" })?.message).toBe(
      'request Content-Type "text/plain" is not accepted',
    );
  });

  it("applies the same rule to the response side, keeping the status", () => {
    const err = sv.validateResponse(
      { method: "POST", path: "/p" },
      { status: 200, body: {}, headers: { "content-type": "application/json" } },
    );
    const leaf = collectLeaves(err!)[0];
    expect(leaf?.code).toBe("content-type");
    expect(leaf?.message).toContain("set HttpResponse.contentType");
    // The status belongs in the response wording. The AOT emitter used
    // to drop it and reuse the request's "is not accepted" instead.
    expect(leaf?.message).toContain("is not declared for status 200");
  });
});
