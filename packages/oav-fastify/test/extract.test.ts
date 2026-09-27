import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { httpRequestFromFastify } from "../src/extract.js";

function fakeReq(overrides: Partial<FastifyRequest>): FastifyRequest {
  return overrides as unknown as FastifyRequest;
}

describe("httpRequestFromFastify", () => {
  it("extracts method, path, headers, contentType, query, and body", () => {
    const got = httpRequestFromFastify(
      fakeReq({
        method: "post",
        url: "/pets?limit=10",
        headers: { "content-type": "application/json", "x-tenant": "t1" },
        query: { limit: "10" },
        body: { name: "Fido" },
      }),
    );
    expect(got.method).toBe("POST");
    expect(got.path).toBe("/pets");
    expect(got.contentType).toBe("application/json");
    expect(got.query).toEqual({ limit: "10" });
    expect(got.body).toEqual({ name: "Fido" });
  });

  it("strips query string from path", () => {
    const got = httpRequestFromFastify(
      fakeReq({ method: "GET", url: "/pets?limit=10&kind=dog", headers: {} }),
    );
    expect(got.path).toBe("/pets");
    expect(got.path).not.toContain("?");
  });

  it.each([
    ["//admin/users", "//admin/users"],
    ["//admin/users?token=abc?def", "//admin/users"],
    ["///admin/users", "///admin/users"],
    ["/admin/../users", "/admin/../users"],
    ["/pets/%2E%2E/users?token=x", "/pets/%2E%2E/users"],
    ["/pets/a%3Fb?token=x", "/pets/a%3Fb"],
    ["http://example.test/admin/users?token=x", "/admin/users"],
    ["https://example.test//admin/users?token=x", "//admin/users"],
    ["http://example.test/admin/../users", "/admin/../users"],
    ["/admin/users#frag", "/admin/users"],
    ["http://example.test?x/admin/users", "/admin/users"],
    ["http://example.test#x/admin/users", "/admin/users"],
  ])("preserves the request path in %s", (url, path) => {
    const query = { token: "abc?def" };
    const got = httpRequestFromFastify(fakeReq({ method: "GET", url, query, headers: {} }));
    expect(got.path).toBe(path);
    expect(got.query).toBe(query);
  });

  it("lowercases header keys defensively", () => {
    const got = httpRequestFromFastify(
      fakeReq({
        method: "GET",
        url: "/x",
        headers: { "X-Custom": "v1", "Content-Type": "application/json" },
      }),
    );
    expect(got.headers).toEqual({ "x-custom": "v1", "content-type": "application/json" });
  });

  it("omits cookies when @fastify/cookie hasn't run", () => {
    const got = httpRequestFromFastify(fakeReq({ method: "GET", url: "/x", headers: {} }));
    expect(got.cookies).toBeUndefined();
  });

  it("propagates cookies when present", () => {
    const got = httpRequestFromFastify(
      fakeReq({
        method: "GET",
        url: "/x",
        headers: {},
        cookies: { sid: "abc" },
      } as Partial<FastifyRequest> & { cookies: Record<string, string> }),
    );
    expect(got.cookies).toEqual({ sid: "abc" });
  });

  it("omits body when undefined (e.g. content-type parser didn't fire)", () => {
    const got = httpRequestFromFastify(
      fakeReq({ method: "POST", url: "/x", headers: { "content-type": "text/plain" } }),
    );
    expect(got.body).toBeUndefined();
    expect(got.contentType).toBe("text/plain");
  });

  it("omits empty query objects", () => {
    const got = httpRequestFromFastify(
      fakeReq({ method: "GET", url: "/x", headers: {}, query: {} }),
    );
    expect(got.query).toBeUndefined();
  });
});
