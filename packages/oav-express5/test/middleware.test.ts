import { type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { httpRequestFromExpress } from "../src/extract.js";
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

function fakeRes(): Response & {
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res = { setHeader: vi.fn(), status: vi.fn(), type: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  return res as unknown as ReturnType<typeof fakeRes>;
}

function fakeReq(overrides: Partial<Request>): Request {
  return { originalUrl: "/pets", ...overrides } as unknown as Request;
}

describe("validateRequests", () => {
  const v = createValidator(petSpec());

  it("rejects a predicate-mode validator at construction", () => {
    const predicate = createValidator(petSpec(), { output: "predicate" });
    expect(() => validateRequests(predicate as never)).toThrow(/predicate-mode/);
  });

  it("calls next() for a valid request without writing a response", async () => {
    const mw = validateRequests(v);
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await mw(
      fakeReq({
        method: "POST",
        path: "/pets",
        headers: { "content-type": "application/json" },
        body: { name: "Fido" },
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("renders a problem-details response for an invalid request", async () => {
    const mw = validateRequests(v);
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await mw(
      fakeReq({
        method: "POST",
        path: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith("application/problem+json");
    const body = res.json.mock.calls[0]?.[0];
    expect(body.title).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("invokes a custom onError without writing a response itself", async () => {
    const onError = vi.fn();
    const mw = validateRequests(v, { onError });
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await mw(
      fakeReq({
        method: "POST",
        path: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      res,
      next,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [errors, ctx] = onError.mock.calls[0]!;
    expect(Array.isArray(errors)).toBe(true);
    expect((errors as ValidationError[]).length).toBeGreaterThan(0);
    expect(ctx).toMatchObject({ res, next });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("uses a custom toHttpRequest extractor when supplied", async () => {
    const toHttpRequest = vi.fn((req: Request) => {
      const httpReq = httpRequestFromExpress(req);
      const fancy = (req as Request & { verifiedBody?: unknown }).verifiedBody;
      if (fancy !== undefined) httpReq.body = fancy;
      return httpReq;
    });
    const mw = validateRequests(v, { toHttpRequest });
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await mw(
      fakeReq({
        method: "POST",
        path: "/pets",
        headers: { "content-type": "application/json" },
        verifiedBody: { name: "Fido" },
      } as Partial<Request> & { verifiedBody: unknown }),
      res,
      next,
    );
    expect(toHttpRequest).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("propagates a thrown extractor error (Express 5's promise-native chain)", async () => {
    const boom = new Error("extractor boom");
    const toHttpRequest = vi.fn(() => {
      throw boom;
    });
    const mw = validateRequests(v, { toHttpRequest });
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    // Express 5 awaits the returned promise; thrown errors reach the
    // error chain via the promise rejection. The middleware itself
    // doesn't try/catch; Express does.
    await expect(
      mw(fakeReq({ method: "GET", path: "/pets", headers: {} }), res, next),
    ).rejects.toBe(boom);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("awaits an async onError before resolving", async () => {
    let asyncWorkComplete = false;
    const onError = vi.fn(async (_err, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      asyncWorkComplete = true;
      ctx.res.status(422).json({ kind: "custom" });
    });
    const mw = validateRequests(v, { onError });
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await mw(
      fakeReq({
        method: "POST",
        path: "/pets",
        headers: { "content-type": "application/json" },
        body: {},
      }),
      res,
      next,
    );
    expect(asyncWorkComplete).toBe(true);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(next).not.toHaveBeenCalled();
  });

  it("propagates a rejected onError promise (Express 5 chain)", async () => {
    const boom = new Error("async logger died");
    const onError = vi.fn(async () => {
      throw boom;
    });
    const mw = validateRequests(v, { onError });
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await expect(
      mw(
        fakeReq({
          method: "POST",
          path: "/pets",
          headers: { "content-type": "application/json" },
          body: {},
        }),
        res,
        next,
      ),
    ).rejects.toBe(boom);
  });
});
