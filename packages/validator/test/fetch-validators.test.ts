import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import {
  httpRequestFromFetch,
  httpResponseFromFetch,
  readBodyFromFetch,
} from "../src/from-fetch.js";
import { createValidator } from "../src/validator.js";

/**
 * Four concerns under test here:
 *   - `httpRequestFromFetch`: content-type dispatch, URL parsing,
 *     header normalization, multipart + form-urlencoded + JSON + text
 *     + unknown media types.
 *   - `httpResponseFromFetch`: mirrored coverage on the response side.
 *   - `validator.validateFetchRequest`: the discriminated-union result
 *     shape end-to-end against a real spec.
 *   - `validator.validateFetchResponse`: same shape, response-side.
 */

describe("httpRequestFromFetch", () => {
  it("parses a bodyless GET request", async () => {
    const req = new Request("https://example.com/pets?limit=10&tag=dog", {
      method: "GET",
      headers: { "X-Tenant": "acme" },
    });
    const { httpRequest, body } = await httpRequestFromFetch(req);
    expect(httpRequest.method).toBe("GET");
    expect(httpRequest.path).toBe("/pets");
    expect(httpRequest.query).toEqual({ limit: "10", tag: "dog" });
    expect(httpRequest.headers?.["x-tenant"]).toBe("acme");
    expect(body).toBeUndefined();
  });

  it("collapses repeated query keys into an array", async () => {
    const req = new Request("https://example.com/pets?id=1&id=2&id=3", { method: "GET" });
    const { httpRequest } = await httpRequestFromFetch(req);
    expect(httpRequest.query?.id).toEqual(["1", "2", "3"]);
  });

  it("parses JSON bodies", async () => {
    const req = new Request("https://example.com/pets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fido", age: 3 }),
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toEqual({ name: "Fido", age: 3 });
  });

  it("parses `*+json` media types as JSON", async () => {
    const req = new Request("https://example.com/x", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json; charset=utf-8" },
      body: JSON.stringify({ a: 1 }),
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toEqual({ a: 1 });
  });

  it("returns undefined body for an empty JSON body", async () => {
    const req = new Request("https://example.com/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toBeUndefined();
  });

  it("parses application/x-www-form-urlencoded bodies", async () => {
    const req = new Request("https://example.com/form", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=Fido&tags=dog&tags=brown",
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toEqual({ name: "Fido", tags: ["dog", "brown"] });
  });

  it("parses multipart/form-data with string + file fields", async () => {
    const form = new FormData();
    form.set("name", "avatar.png");
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "avatar.png");
    const req = new Request("https://example.com/upload", { method: "POST", body: form });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toMatchObject({ name: "avatar.png" });
    const bytes = (body as Record<string, unknown>).file;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("parses text/plain bodies as strings", async () => {
    const req = new Request("https://example.com/note", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "just text",
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toBe("just text");
  });

  it("reads unknown content types as Uint8Array", async () => {
    const req = new Request("https://example.com/bin", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([4, 5, 6]),
    });
    const { body } = await httpRequestFromFetch(req);
    expect(body).toBeInstanceOf(Uint8Array);
    expect([...(body as Uint8Array)]).toEqual([4, 5, 6]);
  });

  it("uppercases the method", async () => {
    const req = new Request("https://example.com/x", { method: "post" });
    const { httpRequest } = await httpRequestFromFetch(req);
    expect(httpRequest.method).toBe("POST");
  });

  it("lowercases header names", async () => {
    const req = new Request("https://example.com/x", {
      method: "GET",
      headers: { "X-Mixed-Case": "v", Authorization: "bearer t" },
    });
    const { httpRequest } = await httpRequestFromFetch(req);
    expect(Object.keys(httpRequest.headers ?? {}).sort()).toEqual([
      "authorization",
      "x-mixed-case",
    ]);
  });
});

function petSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: {
      "/pets": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    age: { type: "integer", minimum: 0 },
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
}

describe("httpResponseFromFetch", () => {
  it("parses status, headers, and JSON body", async () => {
    const res = new Response(JSON.stringify({ id: 1, name: "Fido" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-Id": "abc" },
    });
    const { httpResponse, body } = await httpResponseFromFetch(res);
    expect(httpResponse.status).toBe(200);
    expect(httpResponse.contentType).toMatch(/^application\/json/);
    expect(httpResponse.headers?.["x-request-id"]).toBe("abc");
    expect(body).toEqual({ id: 1, name: "Fido" });
  });

  it("handles bodyless responses (204 No Content)", async () => {
    const res = new Response(null, { status: 204 });
    const { httpResponse, body } = await httpResponseFromFetch(res);
    expect(httpResponse.status).toBe(204);
    expect(body).toBeUndefined();
  });

  it("parses text bodies", async () => {
    const res = new Response("plain text", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const { body } = await httpResponseFromFetch(res);
    expect(body).toBe("plain text");
  });
});

describe("validator.validateFetchRequest", () => {
  const v = createValidator(petSpec());

  it("returns ok:true + typed body on a valid request", async () => {
    const req = new Request("https://example.com/pets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fido", age: 3 }),
    });
    const result = await v.validateFetchRequest<{ name: string; age: number }>(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The generic is a documentation contract, not a runtime-enforced type.
      expect(result.body).toEqual({ name: "Fido", age: 3 });
    }
  });

  it("returns ok:false + error tree on a failing request", async () => {
    const req = new Request("https://example.com/pets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: -1 }), // missing required name, invalid age
    });
    const result = await v.validateFetchRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path[0]).toBe("body");
    }
  });

  it("flags unknown routes via the usual 'route' error code", async () => {
    const req = new Request("https://example.com/nope", { method: "DELETE" });
    const result = await v.validateFetchRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("route");
  });

  it("accepts a multipart upload body", async () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "Uploads", version: "1" },
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
    const u = createValidator(spec);

    const form = new FormData();
    form.set("name", "hi.txt");
    form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "hi.txt");
    const req = new Request("https://example.com/upload", { method: "POST", body: form });
    const result = await u.validateFetchRequest(req);
    expect(result.ok).toBe(true);
  });

  describe("readBody override", () => {
    it("uses the caller's body reader instead of the default dispatch", async () => {
      const req = new Request("https://example.com/pets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Body on the wire that the default reader would accept…
        body: JSON.stringify({ name: "FromWire", age: 1 }),
      });
      // …but the override returns a different body shape instead. The
      // Request stream isn't consumed by our default parser; the
      // callback owns it.
      const result = await v.validateFetchRequest<{ name: string; age: number }>(req, {
        readBody: async () => ({ name: "FromOverride", age: 2 }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.body).toEqual({ name: "FromOverride", age: 2 });
    });

    it("surfaces validation failures on the overridden body like any other", async () => {
      const req = new Request("https://example.com/pets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fido", age: 3 }),
      });
      const result = await v.validateFetchRequest(req, {
        // Override returns something that fails the schema (missing required "name").
        readBody: async () => ({ age: 5 }),
      });
      expect(result.ok).toBe(false);
    });

    it("lets the callback delegate to the default reader via readBodyFromFetch", async () => {
      const req = new Request("https://example.com/pets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fido", age: 3 }),
      });
      let calledDefault = false;
      const result = await v.validateFetchRequest(req, {
        readBody: async (r) => {
          calledDefault = true;
          return readBodyFromFetch(r);
        },
      });
      expect(calledDefault).toBe(true);
      expect(result.ok).toBe(true);
    });

    it("works with a multer-equivalent multipart streaming pattern", async () => {
      // A streaming multipart-proxy shape: a multipart endpoint
      // declared in the spec as `{ documents: string, format: binary }`
      // (or an array of same). A user's streaming parser pulls bytes off
      // the request and assembles whatever body the spec expects;
      // placeholders for file fields (paths, buffer handles) pass through
      // the validator's format:binary bypass.
      const spec: OpenAPIDocument = {
        openapi: "3.0.3",
        info: { title: "Uploads", version: "1" },
        paths: {
          "/documents": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      required: ["documents"],
                      properties: {
                        documents: { type: "string", format: "binary" },
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
      const u = createValidator(spec);

      // Simulate a streaming parser that writes to disk and returns a path.
      async function myStreamingParser(_req: Request): Promise<{ documents: string }> {
        // In real usage: pipe req.body through a multipart parser into a
        // temp file. Here we just pretend we did and ignore the body.
        return { documents: "/tmp/fake-123.bin" };
      }

      const req = new Request("https://example.com/documents", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=x" },
        body: "placeholder",
      });
      const result = await u.validateFetchRequest(req, { readBody: myStreamingParser });
      expect(result.ok).toBe(true);
    });
  });
});

function petListSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                      },
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
}

describe("validator.validateFetchResponse", () => {
  const v = createValidator(petListSpec());

  it("returns ok:true + typed body on a valid response", async () => {
    const req = new Request("https://example.com/pets", { method: "GET" });
    const res = new Response(JSON.stringify([{ id: 1, name: "Fido" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const result = await v.validateFetchResponse<Array<{ id: number; name: string }>>(req, res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual([{ id: 1, name: "Fido" }]);
    }
  });

  it("returns ok:false on a schema violation in the response body", async () => {
    const req = new Request("https://example.com/pets", { method: "GET" });
    const res = new Response(JSON.stringify([{ id: "not-a-number" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const result = await v.validateFetchResponse(req, res);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path[0]).toBe("body");
  });

  it("flags an undeclared status code", async () => {
    const req = new Request("https://example.com/pets", { method: "GET" });
    const res = new Response(null, { status: 500 });
    const result = await v.validateFetchResponse(req, res);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("status");
  });

  it("flags unknown routes at the request level", async () => {
    const req = new Request("https://example.com/nope", { method: "GET" });
    const res = new Response(null, { status: 200 });
    const result = await v.validateFetchResponse(req, res);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("route");
  });

  it("doesn't read the request body", async () => {
    // Request body present but validateFetchResponse shouldn't consume it;
    // a caller that wants the request body after validating the response
    // should still be able to read it.
    const req = new Request("https://example.com/pets", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const res = new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await v.validateFetchResponse(req, res);
    // If the helper had consumed req.body, this next read would throw.
    expect(req.bodyUsed).toBe(false);
  });
});
