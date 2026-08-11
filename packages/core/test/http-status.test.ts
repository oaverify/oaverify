import { describe, expect, it } from "vitest";
import { createBranchError, createLeafError } from "../src/errors.js";
import { allowHeaderFor, DEFAULT_HTTP_STATUS_MAP, httpStatusFor } from "../src/http-status.js";

// Mirrors the tree shape the validator produces: "route"/"method" are
// returned as a top-level leaf; everything else is wrapped in a
// "request" (or "response") branch.

describe("httpStatusFor", () => {
  it("returns 404 for a top-level route error", () => {
    const err = createLeafError("route", [], "no match", { method: "GET", path: "/x" });
    expect(httpStatusFor(err)).toBe(404);
  });

  it("returns 405 for a top-level method error", () => {
    const err = createLeafError("method", [], "verb not allowed", {
      method: "PATCH",
      pathPattern: "/pets",
      allowed: ["GET", "POST"],
    });
    expect(httpStatusFor(err)).toBe(405);
  });

  it("returns 415 for a content-type leaf nested under a request wrapper", () => {
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("content-type", ["body"], "Content-Type not accepted", {
        contentType: "text/plain",
        accepted: ["application/json"],
      }),
    ]);
    expect(httpStatusFor(err)).toBe(415);
  });

  it("returns 401 for a security leaf nested under a request wrapper", () => {
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("security", ["security"], "missing credential", {}),
    ]);
    expect(httpStatusFor(err)).toBe(401);
  });

  it("returns 500 for a status leaf nested under a response wrapper", () => {
    const err = createBranchError("response", [], "response validation failed", [
      createLeafError("status", [], "no response declared for 418", { status: 418 }),
    ]);
    expect(httpStatusFor(err)).toBe(500);
  });

  it("returns 400 for anything else: schema violations, missing required, etc.", () => {
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("required", ["body"], "missing name", { missing: "name" }),
      createLeafError("type", ["body", "age"], "must be number", {
        expected: ["number"],
        actual: "string",
      }),
    ]);
    expect(httpStatusFor(err)).toBe(400);
  });

  it("prefers 415 over 400 when a content-type leaf coexists with schema leaves", () => {
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("content-type", ["body"], "Content-Type not accepted", {
        contentType: "text/plain",
        accepted: ["application/json"],
      }),
      createLeafError("required", ["body"], "missing name", { missing: "name" }),
    ]);
    expect(httpStatusFor(err)).toBe(415);
  });

  it("prefers 401 (security) over 415 (content-type) when both leaves are present", () => {
    // HTTP gate semantics: auth is the stricter gate ("we can't even tell
    // what you're asking for"), and 401 should surface ahead of 415. In
    // practice the validator short-circuits on security before checking
    // content-type, so both rarely coexist, but the helper's priority
    // guarantees the behavior regardless.
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("content-type", ["body"], "Content-Type not accepted", {
        contentType: "text/plain",
        accepted: ["application/json"],
      }),
      createLeafError("security", ["security"], "missing credential", {}),
    ]);
    expect(httpStatusFor(err)).toBe(401);
  });

  it("prefers 401 (security) over 500 (status) when both leaves are present", () => {
    // Same gate ladder: auth runs before any response-status check, so
    // 401 must win even when a status mismatch is also present in the
    // tree (e.g. composed validations bubbled up together).
    const err = createBranchError("response", [], "response validation failed", [
      createLeafError("status", ["status"], "no matching status", { status: 200 }),
      createLeafError("security", ["security"], "missing credential", {}),
    ]);
    expect(httpStatusFor(err)).toBe(401);
  });

  it("applies overrides for individual slots", () => {
    const err = createBranchError("request", [], "request validation failed", [
      createLeafError("required", ["body"], "missing name", { missing: "name" }),
    ]);
    expect(httpStatusFor(err, { default: 422 })).toBe(422);
  });

  it("applies overrides without affecting unrelated slots", () => {
    const route = createLeafError("route", [], "no match", { method: "GET", path: "/x" });
    expect(httpStatusFor(route, { default: 422 })).toBe(404);
  });

  it("exposes DEFAULT_HTTP_STATUS_MAP for introspection", () => {
    expect(DEFAULT_HTTP_STATUS_MAP).toEqual({
      route: 404,
      method: 405,
      "body-too-large": 413,
      "content-type": 415,
      security: 401,
      status: 500,
      default: 400,
    });
  });
});

describe("allowHeaderFor", () => {
  it("returns the allowed-methods list as a comma-separated string for a method error", () => {
    const err = createLeafError("method", [], "verb not allowed", {
      method: "PATCH",
      pathPattern: "/pets",
      allowed: ["GET", "HEAD", "POST"],
    });
    expect(allowHeaderFor(err)).toBe("GET, HEAD, POST");
  });

  it("returns undefined when the error is not a method error", () => {
    const err = createLeafError("route", [], "no match", { method: "GET", path: "/x" });
    expect(allowHeaderFor(err)).toBeUndefined();
  });

  it("returns undefined when the method error has no allowed array (shouldn't happen in practice)", () => {
    const err = createLeafError("method" as "route", [], "verb not allowed", {
      method: "PATCH",
      path: "/pets",
    });
    expect(allowHeaderFor(err)).toBeUndefined();
  });
});
