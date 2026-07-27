import { createBranchError, createLeafError } from "@oaverify/internal-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { renderProblemDetails } from "../src/render.js";

function fakeReply(): FastifyReply & {
  header: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply = {
    header: vi.fn(),
    code: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.type.mockReturnValue(reply);
  return reply as unknown as ReturnType<typeof fakeReply>;
}

function fakeRequest(url = "/pets"): FastifyRequest {
  return { url } as unknown as FastifyRequest;
}

describe("renderProblemDetails", () => {
  it("writes status, content-type, and a problem-details body", () => {
    const err = createLeafError("type", ["body", "age"], "must be number", {
      expected: ["number"],
      actual: "string",
    });
    const reply = fakeReply();
    renderProblemDetails(err, { request: fakeRequest(), reply });
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.type).toHaveBeenCalledWith("application/problem+json");
    const body = reply.send.mock.calls[0]?.[0];
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
    const reply = fakeReply();
    renderProblemDetails(err, { request: fakeRequest(), reply });
    expect(reply.code).toHaveBeenCalledWith(405);
    expect(reply.header).toHaveBeenCalledWith("Allow", "GET, POST");
  });

  it("does not set Allow on errors that aren't 405s", () => {
    const err = createBranchError("request", [], "request invalid", [
      createLeafError("type", ["body", "age"], "must be number"),
    ]);
    const reply = fakeReply();
    renderProblemDetails(err, { request: fakeRequest(), reply });
    expect(reply.header).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
  });
});
