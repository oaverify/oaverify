import { type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { httpRequestFromFastify } from "../src/extract.js";
import { validateRequests } from "../src/middleware.js";

function petSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
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
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function fakeReply(): FastifyReply & {
  header: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply = { header: vi.fn(), code: vi.fn(), type: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.type.mockReturnValue(reply);
  return reply as unknown as ReturnType<typeof fakeReply>;
}

function fakeRequest(overrides: Partial<FastifyRequest>): FastifyRequest {
  return { url: "/pets", ...overrides } as unknown as FastifyRequest;
}

describe("validateRequests", () => {
  const v = createValidator(petSpec());

  it("rejects a predicate-mode validator at construction", () => {
    const predicate = createValidator(petSpec(), { output: "predicate" });
    expect(() => validateRequests(predicate as never)).toThrow(/predicate-mode/);
  });

  it("resolves without sending for a valid request", async () => {
    const hook = validateRequests(v);
    const reply = fakeReply();
    await hook.call(
      undefined as never,
      fakeRequest({
        method: "POST",
        url: "/pets",
        headers: { "content-type": "application/json" },
        body: { name: "Fido" },
      }),
      reply,
    );
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("renders a problem-details response for an invalid request", async () => {
    const hook = validateRequests(v);
    const reply = fakeReply();
    await hook.call(
      undefined as never,
      fakeRequest({
        method: "POST",
        url: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      reply,
    );
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.type).toHaveBeenCalledWith("application/problem+json");
    const body = reply.send.mock.calls[0]?.[0];
    expect(body.title).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("invokes a custom onError without writing a response itself", async () => {
    const onError = vi.fn();
    const hook = validateRequests(v, { onError });
    const reply = fakeReply();
    await hook.call(
      undefined as never,
      fakeRequest({
        method: "POST",
        url: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      reply,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [errors, ctx] = onError.mock.calls[0]!;
    expect(Array.isArray(errors)).toBe(true);
    expect((errors as ValidationError[]).length).toBeGreaterThan(0);
    expect(ctx).toMatchObject({ reply });
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("uses a custom toHttpRequest extractor when supplied", async () => {
    const toHttpRequest = vi.fn((req: FastifyRequest) => {
      const httpReq = httpRequestFromFastify(req);
      const fancy = (req as FastifyRequest & { verifiedBody?: unknown }).verifiedBody;
      if (fancy !== undefined) httpReq.body = fancy;
      return httpReq;
    });
    const hook = validateRequests(v, { toHttpRequest });
    const reply = fakeReply();
    await hook.call(
      undefined as never,
      fakeRequest({
        method: "POST",
        url: "/pets",
        headers: { "content-type": "application/json" },
        verifiedBody: { name: "Fido" },
      } as Partial<FastifyRequest> & { verifiedBody: unknown }),
      reply,
    );
    expect(toHttpRequest).toHaveBeenCalledTimes(1);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("propagates a thrown extractor error (Fastify's promise chain catches it)", async () => {
    const boom = new Error("extractor boom");
    const toHttpRequest = vi.fn(() => {
      throw boom;
    });
    const hook = validateRequests(v, { toHttpRequest });
    const reply = fakeReply();
    await expect(
      hook.call(
        undefined as never,
        fakeRequest({ method: "GET", url: "/pets", headers: {} }),
        reply,
        () => {},
      ),
    ).rejects.toBe(boom);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("awaits an async onError before resolving", async () => {
    let asyncWorkComplete = false;
    const onError = vi.fn(async (_err, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      asyncWorkComplete = true;
      ctx.reply.code(422).send({ kind: "custom" });
    });
    const hook = validateRequests(v, { onError });
    const reply = fakeReply();
    await hook.call(
      undefined as never,
      fakeRequest({
        method: "POST",
        url: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      reply,
    );
    expect(asyncWorkComplete).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(422);
  });

  it("propagates a rejected onError promise (Fastify chain)", async () => {
    const boom = new Error("async logger died");
    const onError = vi.fn(async () => {
      throw boom;
    });
    const hook = validateRequests(v, { onError });
    const reply = fakeReply();
    await expect(
      hook.call(
        undefined as never,
        fakeRequest({
          method: "POST",
          url: "/pets",
          headers: { "content-type": "application/json" },
          body: {},
        }),
        reply,
        () => {},
      ),
    ).rejects.toBe(boom);
  });
});
