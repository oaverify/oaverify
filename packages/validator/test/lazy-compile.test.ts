import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

describe("lazy response-schema compilation", () => {
  // Observable contract: response-body schemas are compiled lazily on
  // first validateResponse touch. Direct assertion via
  // `validator.stats.responseBodiesCompiled`; no reliance on a
  // throw-on-compile trick.
  function specWithResponseBody(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: {
        "/a": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
  }

  it("doesn't compile response bodies at createValidator time", () => {
    const v = createValidator(specWithResponseBody());
    expect(v.stats.responseBodiesCompiled).toBe(0);
  });

  it("doesn't compile response bodies during validateRequest", () => {
    const v = createValidator(specWithResponseBody());
    v.validateRequest({
      method: "POST",
      path: "/a",
      contentType: "application/json",
      body: {},
    });
    expect(v.stats.responseBodiesCompiled).toBe(0);
  });

  it("compiles the response body on first validateResponse touch, then memoizes", () => {
    const v = createValidator(specWithResponseBody());
    v.validateResponse(
      { method: "POST", path: "/a" },
      { status: 200, contentType: "application/json", body: "ok" },
    );
    expect(v.stats.responseBodiesCompiled).toBe(1);
    v.validateResponse(
      { method: "POST", path: "/a" },
      { status: 200, contentType: "application/json", body: "again" },
    );
    expect(v.stats.responseBodiesCompiled).toBe(1);
  });

  it("doesn't compile response headers whose values are absent", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: {
                  "X-Opt": {
                    schema: { type: ["string", "null"] as unknown as string },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v = createValidator(spec);
    expect(() => v.validateResponse({ method: "GET", path: "/a" }, { status: 200 })).not.toThrow();
  });
});
