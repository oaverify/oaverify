import { createBranchError, createLeafError } from "@oaverify/internal-core";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { renderProblemDetails } from "../src/render.js";

function fakeRes(): Response & {
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    type: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  return res as unknown as ReturnType<typeof fakeRes>;
}

function fakeReq(originalUrl = "/pets"): Request {
  return { originalUrl } as unknown as Request;
}

describe("renderProblemDetails", () => {
  it("writes status, content-type, and a problem-details body", () => {
    const err = createLeafError("type", ["body", "age"], "must be number", {
      expected: ["number"],
      actual: "string",
    });
    const res = fakeRes();
    renderProblemDetails([err], { req: fakeReq(), res, next: vi.fn() });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith("application/problem+json");
    const body = res.json.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      type: "about:blank",
      title: "Validation failed",
      status: 400,
      instance: "/pets",
    });
    expect(body.detail).toBe("body.age must be number");
    expect(body.issues).toHaveLength(1);
  });

  it("sets the Allow header on a 405 (method-not-allowed)", () => {
    const err = createLeafError("method", [], "method not allowed", {
      method: "DELETE",
      pathPattern: "/pets",
      allowed: ["GET", "POST"],
    });
    const res = fakeRes();
    renderProblemDetails([err], { req: fakeReq(), res, next: vi.fn() });
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("does not set Allow on errors that aren't 405s", () => {
    const err = createBranchError("request", [], "request invalid", [
      createLeafError("type", ["body", "age"], "must be number"),
    ]);
    const res = fakeRes();
    renderProblemDetails([err], { req: fakeReq(), res, next: vi.fn() });
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
