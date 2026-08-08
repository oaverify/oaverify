/**
 * `returnValues`: the deserialized parameter values handed back on the
 * result. Covers the option-off path staying byte-identical, the
 * presence rule on both verdicts, the two request-level short-circuits
 * that return before any parameter is reached, and the boundaries the
 * option deliberately does not cross (body, defaults, responses).
 */
import type { HttpRequest, OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/index.js";

/** Four parameters, one per HTTP location. */
const spec = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/w/{id}": {
      get: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "limit", in: "query", required: true, schema: { type: "integer" } },
          {
            name: "tags",
            in: "query",
            required: true,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "X-Req-Id", in: "header", required: true, schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
} as unknown as OpenAPIDocument;

const goodRequest = (): HttpRequest =>
  ({
    method: "GET",
    path: "/w/42",
    query: { limit: "10", tags: ["a", "b"] },
    headers: { "x-req-id": "abc" },
    cookies: { session: "s1" },
  }) as unknown as HttpRequest;

describe("returnValues off", () => {
  it("leaves a passing result byte-identical to the no-option result", () => {
    const result = createValidator(spec).validateRequest(goodRequest());
    expect(result).toEqual({ valid: true });
    expect(Object.keys(result)).toEqual(["valid"]);
  });

  it("does not add the key on a failing result either", () => {
    const req = { ...goodRequest(), query: { limit: "nope", tags: ["a"] } } as HttpRequest;
    const result = createValidator(spec).validateRequest(req);
    expect(result.valid).toBe(false);
    expect("value" in result).toBe(false);
  });

  it("does not add the key when explicitly false", () => {
    const result = createValidator(spec, { returnValues: false }).validateRequest(goodRequest());
    expect("value" in result).toBe(false);
  });
});

describe("returnValues on, request valid", () => {
  it("returns deserialized values for all four locations", () => {
    const result = createValidator(spec, { returnValues: true }).validateRequest(goodRequest());
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({
      path: { id: 42 },
      query: { limit: 10, tags: ["a", "b"] },
      headers: { "X-Req-Id": "abc" },
      cookies: { session: "s1" },
    });
  });

  it("returns values coerced to their schema type, not the raw strings", () => {
    const result = createValidator(spec, { returnValues: true }).validateRequest(goodRequest());
    expect(result.value.path.id).toBe(42);
    expect(result.value.query.limit).toBe(10);
    expect(typeof result.value.path.id).toBe("number");
  });

  it("keys headers by the spec's spelling, not the request's", () => {
    const result = createValidator(spec, { returnValues: true }).validateRequest(goodRequest());
    // Sent as `x-req-id`, declared as `X-Req-Id`.
    expect(Object.keys(result.value.headers)).toEqual(["X-Req-Id"]);
  });

  it("does not mutate the request the caller passed in", () => {
    const req = goodRequest();
    const before = structuredClone(req);
    createValidator(spec, { returnValues: true }).validateRequest(req);
    expect(req).toEqual(before);
  });

  it("omits a parameter the client did not send", () => {
    const req = goodRequest();
    delete (req as { cookies?: unknown }).cookies;
    const result = createValidator(spec, { returnValues: true }).validateRequest(req);
    expect(result.valid).toBe(true);
    expect(result.value.cookies).toEqual({});
  });

  it("allocates a fresh value object per call", () => {
    const validator = createValidator(spec, { returnValues: true });
    const a = validator.validateRequest(goodRequest());
    const b = validator.validateRequest(goodRequest());
    expect(a.value).not.toBe(b.value);
    expect(a.value).toEqual(b.value);
  });
});

describe("returnValues on, request invalid", () => {
  it("returns the parameters that passed and omits the one that failed", () => {
    const req = { ...goodRequest(), query: { limit: "nope", tags: ["a"] } } as HttpRequest;
    const result = createValidator(spec, { returnValues: true }).validateRequest(req);
    expect(result.valid).toBe(false);
    expect(result.value.query).toEqual({ tags: ["a"] });
    expect(result.value.path).toEqual({ id: 42 });
    expect(result.value.headers).toEqual({ "X-Req-Id": "abc" });
  });

  it("omits a parameter that deserialized cleanly but failed a constraint", () => {
    const bounded = structuredClone(spec) as unknown as {
      paths: { "/w/{id}": { get: { parameters: { name: string; schema: unknown }[] } } };
    };
    const limit = bounded.paths["/w/{id}"].get.parameters[1] as { schema: unknown };
    limit.schema = { type: "integer", maximum: 100 };
    const req = { ...goodRequest(), query: { limit: "999", tags: ["a"] } } as HttpRequest;
    const result = createValidator(bounded as unknown as OpenAPIDocument, {
      returnValues: true,
    }).validateRequest(req);
    expect(result.valid).toBe(false);
    // 999 is a fine deserialization and still absent: presence means
    // accepted, not merely parsed.
    expect("limit" in result.value.query).toBe(false);
  });

  it("collects every passing parameter even under the default maxErrors of 1", () => {
    const req = {
      ...goodRequest(),
      query: { limit: "nope", tags: ["a", "b"] },
    } as HttpRequest;
    const result = createValidator(spec, { returnValues: true }).validateRequest(req);
    expect(result.valid).toBe(false);
    // The error budget trims errors at the boundary; it does not stop
    // the parameter walk, so siblings are still collected.
    expect(result.value.query.tags).toEqual(["a", "b"]);
    expect(result.value.cookies.session).toBe("s1");
  });

  it("omits a required parameter that was missing entirely", () => {
    const req = { ...goodRequest(), query: { tags: ["a"] } } as HttpRequest;
    const result = createValidator(spec, { returnValues: true }).validateRequest(req);
    expect(result.valid).toBe(false);
    expect("limit" in result.value.query).toBe(false);
  });
});

describe("returnValues on, nothing to report", () => {
  const bare = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/bare": { get: { responses: { "200": { description: "ok" } } } } },
  } as unknown as OpenAPIDocument;

  it("returns every location present and empty when no parameters are declared", () => {
    const result = createValidator(bare, { returnValues: true }).validateRequest({
      method: "GET",
      path: "/bare",
    } as HttpRequest);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });
});

describe("returnValues on, request-level short-circuits", () => {
  it("returns present-but-empty value when the security gate rejects", () => {
    const secured = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths: {
        "/s": {
          get: {
            security: [{ bearerAuth: [] }],
            parameters: [
              { name: "limit", in: "query", required: true, schema: { type: "integer" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(secured, {
      returnValues: true,
      validateSecurity: "shape",
    }).validateRequest({
      method: "GET",
      path: "/s",
      query: { limit: "10" },
    } as unknown as HttpRequest);
    expect(result.valid).toBe(false);
    // `limit` would have deserialized fine; the security gate returns
    // before any parameter is reached, so nothing was accepted.
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });

  it("returns present-but-empty value when the content-type gate rejects", () => {
    const withBody = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/b": {
          post: {
            parameters: [
              { name: "limit", in: "query", required: true, schema: { type: "integer" } },
            ],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(withBody, { returnValues: true }).validateRequest({
      method: "POST",
      path: "/b",
      query: { limit: "10" },
      contentType: "text/plain",
      body: "hi",
    } as unknown as HttpRequest);
    expect(result.valid).toBe(false);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });
});

describe("returnValues on, route resolution", () => {
  it("returns present-but-empty value on a route miss", () => {
    const result = createValidator(spec, { returnValues: true }).validateRequest({
      method: "GET",
      path: "/nope",
    } as HttpRequest);
    expect(result.valid).toBe(false);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });

  it("returns present-but-empty value when the method is not allowed", () => {
    const result = createValidator(spec, { returnValues: true }).validateRequest({
      method: "DELETE",
      path: "/w/42",
    } as HttpRequest);
    expect(result.valid).toBe(false);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });

  it("returns present-but-empty value on a path filtered out by ignorePaths", () => {
    const result = createValidator(spec, {
      returnValues: true,
      ignorePaths: (p) => p.startsWith("/w"),
    }).validateRequest(goodRequest());
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });

  it("returns present-but-empty value on an undocumented path under ignoreUndocumented", () => {
    const result = createValidator(spec, {
      returnValues: true,
      ignoreUndocumented: true,
    }).validateRequest({ method: "GET", path: "/nope" } as HttpRequest);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ path: {}, query: {}, headers: {}, cookies: {} });
  });
});

describe("returnValues and the request body", () => {
  const withBody = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/b": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { n: { type: "integer" } } },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenAPIDocument;

  it("does not carry the body, by decision rather than omission", () => {
    const result = createValidator(withBody, { returnValues: true }).validateRequest({
      method: "POST",
      path: "/b",
      contentType: "application/json",
      body: { n: 1 },
    } as unknown as HttpRequest);
    expect(result.valid).toBe(true);
    expect(Object.keys(result.value).sort()).toEqual(["cookies", "headers", "path", "query"]);
    expect("body" in result.value).toBe(false);
  });
});

describe("returnValues and schema defaults", () => {
  const defaulted = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/d": {
        get: {
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 25 } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenAPIDocument;

  it("leaves an unsent parameter absent rather than filling in its default", () => {
    const result = createValidator(defaulted, { returnValues: true }).validateRequest({
      method: "GET",
      path: "/d",
    } as HttpRequest);
    expect(result.valid).toBe(true);
    expect(result.value.query).toEqual({});
  });

  it("returns the sent value when the client does send one", () => {
    const result = createValidator(defaulted, { returnValues: true }).validateRequest({
      method: "GET",
      path: "/d",
      query: { limit: "7" },
    } as unknown as HttpRequest);
    expect(result.value.query.limit).toBe(7);
  });
});

describe("returnValues and output modes", () => {
  it("carries the value channel in tree mode", () => {
    const result = createValidator(spec, {
      returnValues: true,
      output: "tree",
    }).validateRequest(goodRequest());
    expect(result.valid).toBe(true);
    expect(result.value.query.limit).toBe(10);
  });

  it("carries the value channel alongside a tree-mode failure", () => {
    const req = { ...goodRequest(), query: { limit: "nope", tags: ["a"] } } as HttpRequest;
    const result = createValidator(spec, { returnValues: true, output: "tree" }).validateRequest(
      req,
    );
    if (result.valid) throw new Error("expected the tree-mode request to fail");
    expect(result.error).toBeDefined();
    expect(result.value.query.tags).toEqual(["a"]);
  });

  it("refuses predicate mode at construction", () => {
    expect(() => createValidator(spec, { returnValues: true, output: "predicate" })).toThrow(
      /`returnValues` cannot be combined with `output: "predicate"`/,
    );
  });

  it("still allows predicate mode when returnValues is off", () => {
    expect(() => createValidator(spec, { output: "predicate" })).not.toThrow();
    expect(() => createValidator(spec, { output: "predicate", returnValues: false })).not.toThrow();
  });
});

describe("returnValues and validateResponse", () => {
  it("does not add a value channel to response results", () => {
    const validator = createValidator(spec, { returnValues: true });
    const result = validator.validateResponse(goodRequest(), {
      status: 200,
    } as unknown as Parameters<typeof validator.validateResponse>[1]);
    expect("value" in result).toBe(false);
  });
});

describe("returnValues and the Fetch wrapper", () => {
  it("carries the value channel on a successful validateFetchRequest", async () => {
    const validator = createValidator(spec, { returnValues: true });
    const request = new Request("https://example.test/w/42?limit=10&tags=a&tags=b", {
      method: "GET",
      headers: { "x-req-id": "abc", cookie: "session=s1" },
    });
    const result = await validator.validateFetchRequest(request);
    expect(result.ok).toBe(true);
    expect(result.value.path.id).toBe(42);
    expect(result.value.query.limit).toBe(10);
  });

  it("carries the value channel on a failing validateFetchRequest", async () => {
    const validator = createValidator(spec, { returnValues: true });
    const request = new Request("https://example.test/w/42?limit=nope&tags=a", {
      method: "GET",
      headers: { "x-req-id": "abc" },
    });
    const result = await validator.validateFetchRequest(request);
    expect(result.ok).toBe(false);
    expect(result.value.query.tags).toEqual(["a"]);
    expect("limit" in result.value.query).toBe(false);
  });

  it("adds no value channel when the option is off", async () => {
    const validator = createValidator(spec);
    const request = new Request("https://example.test/w/42?limit=10&tags=a", {
      method: "GET",
      headers: { "x-req-id": "abc" },
    });
    const result = await validator.validateFetchRequest(request);
    expect(result.ok).toBe(true);
    expect("value" in result).toBe(false);
  });
});

describe("returnValues key safety", () => {
  it("does not let a parameter named __proto__ reach Object.prototype", () => {
    const hostile = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/h": {
          get: {
            parameters: [{ name: "__proto__", in: "query", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(hostile, { returnValues: true }).validateRequest({
      method: "GET",
      path: "/h",
      query: { __proto__: "polluted" },
    } as unknown as HttpRequest);
    expect(result.valid).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.value.query)).toBeNull();
  });
});
