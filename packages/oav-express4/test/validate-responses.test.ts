import { type OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ResponseValidationError } from "../src/response-error.js";
import { validateResponses } from "../src/validate-responses.js";

function widgetSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/widgets/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                    additionalProperties: false,
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

interface FakeRes {
  res: Response;
  sent: ReturnType<typeof vi.fn>;
}

// Models the Express flow the wrapper relies on: res.json serializes,
// defaults the content type, and re-dispatches through res.send.
function fakeRes(statusCode = 200, headers: Record<string, unknown> = {}): FakeRes {
  const sent = vi.fn();
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const res = {
    statusCode,
    headersSent: false,
    getHeader: (n: string) => lower[n.toLowerCase()],
    getHeaders: () => lower,
    json(body: unknown) {
      lower["content-type"] ??= "application/json";
      return this.send(JSON.stringify(body));
    },
    send(...args: unknown[]) {
      sent(...args);
      this.headersSent = true;
      return this;
    },
  };
  return { res: res as unknown as Response, sent };
}

function fakeReq(): Request {
  return {
    method: "GET",
    path: "/widgets/42",
    headers: {},
    originalUrl: "/widgets/42",
  } as unknown as Request;
}

const v = createValidator(widgetSpec());

function mount(res: Response, next: ReturnType<typeof vi.fn>, options = {}): void {
  validateResponses(v, options)(fakeReq(), res, next as unknown as NextFunction);
}

function erroredWith(next: ReturnType<typeof vi.fn>): ResponseValidationError | undefined {
  const call = next.mock.calls.find((c) => c[0] instanceof ResponseValidationError);
  return call?.[0] as ResponseValidationError | undefined;
}

describe("validateResponses (Express 4)", () => {
  it("rejects a predicate-mode validator at construction", () => {
    const predicate = createValidator(widgetSpec(), { output: "predicate" });
    expect(() => validateResponses(predicate as never)).toThrow(/predicate-mode/);
  });

  it("sends a valid response body through unchanged", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    res.json({ id: "ok" });
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ id: "ok" }));
    expect(erroredWith(next)).toBeUndefined();
  });

  it("forwards a ResponseValidationError and suppresses the bad body", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    res.json({ id: 123 }); // id must be a string
    expect(sent).not.toHaveBeenCalled();
    const err = erroredWith(next);
    expect(err).toBeInstanceOf(ResponseValidationError);
    expect(err?.statusCode).toBe(500);
    expect(err?.errors.length).toBeGreaterThan(0);
  });

  it("validates the serialized wire body, not the live object", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    res.json({
      id: "ok",
      toJSON() {
        return { id: "ok" };
      },
    });
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ id: "ok" }));
    expect(erroredWith(next)).toBeUndefined();
  });

  it("parses the wire body exactly once", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    const parse = vi.spyOn(JSON, "parse");
    try {
      res.json({ id: "ok" });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("treats an undeclared status as a finding by default", () => {
    const { res, sent } = fakeRes(418);
    const next = vi.fn();
    mount(res, next);
    res.json({ id: "ok" });
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  it("skips statuses the predicate excludes", () => {
    const { res, sent } = fakeRes(500);
    const next = vi.fn();
    mount(res, next, { statuses: (s: number) => s < 500 });
    res.json({ anything: true }); // would fail 200 schema, but 500 is skipped
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ anything: true }));
    expect(erroredWith(next)).toBeUndefined();
  });

  it("validates a JSON string sent via res.send", () => {
    const { res, sent } = fakeRes(200, { "content-type": "application/json" });
    const next = vi.fn();
    mount(res, next);
    res.send(JSON.stringify({ id: 7 })); // id must be a string
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  it("passes non-JSON send payloads through untouched", () => {
    const { res, sent } = fakeRes(200, { "content-type": "text/html" });
    const next = vi.fn();
    mount(res, next);
    res.send("<html>not json</html>");
    expect(sent).toHaveBeenCalledWith("<html>not json</html>");
    expect(erroredWith(next)).toBeUndefined();
  });

  it("passes a malformed JSON payload through untouched", () => {
    const { res, sent } = fakeRes(200, { "content-type": "application/json" });
    const next = vi.fn();
    mount(res, next);
    res.send("{not valid json");
    expect(sent).toHaveBeenCalledWith("{not valid json");
    expect(erroredWith(next)).toBeUndefined();
  });

  it("checks the status of an empty res.json() body", () => {
    const { res, sent } = fakeRes(418);
    const next = vi.fn();
    mount(res, next);
    res.json();
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  it("an empty res.json() body with a declared status passes", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    res.json();
    expect(sent).toHaveBeenCalledWith(undefined);
    expect(erroredWith(next)).toBeUndefined();
  });

  it("checks declared headers on an empty res.json() body", () => {
    const spec = widgetSpec();
    const get = spec.paths!["/widgets/{id}"]!.get as unknown as {
      responses: Record<string, { headers?: unknown }>;
    };
    get.responses["200"]!.headers = {
      "X-Request-Id": { required: true, schema: { type: "string" } },
    };
    const hv = createValidator(spec);
    const { res, sent } = fakeRes(); // header not set
    const next = vi.fn();
    validateResponses(hv)(fakeReq(), res, next as unknown as NextFunction);
    res.json();
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  // Status and header validation are independent of the body's media
  // type. A text error page, a redirect, or an empty body still has a
  // status the spec may not declare and headers it may require.
  it("flags an undeclared status on a non-JSON send", () => {
    const { res, sent } = fakeRes(418, { "content-type": "text/html" });
    const next = vi.fn();
    mount(res, next);
    res.send("<html>teapot</html>");
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  it("flags a missing required header on a non-JSON send", () => {
    const spec = widgetSpec();
    const get = spec.paths!["/widgets/{id}"]!.get as unknown as {
      responses: Record<string, unknown>;
    };
    get.responses["302"] = {
      description: "redirect",
      headers: { Location: { required: true, schema: { type: "string" } } },
    };
    const hv = createValidator(spec);
    const { res, sent } = fakeRes(302, { "content-type": "text/html" }); // no Location
    const next = vi.fn();
    validateResponses(hv)(fakeReq(), res, next as unknown as NextFunction);
    res.send("<html>see other</html>");
    expect(sent).not.toHaveBeenCalled();
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
  });

  it("passes a non-JSON send whose status is declared and headers satisfied", () => {
    const spec = widgetSpec();
    const get = spec.paths!["/widgets/{id}"]!.get as unknown as {
      responses: Record<string, unknown>;
    };
    get.responses["302"] = {
      description: "redirect",
      headers: { Location: { required: true, schema: { type: "string" } } },
    };
    const hv = createValidator(spec);
    const { res, sent } = fakeRes(302, { "content-type": "text/html", location: "/elsewhere" });
    const next = vi.fn();
    validateResponses(hv)(fakeReq(), res, next as unknown as NextFunction);
    res.send("<html>see other</html>");
    expect(sent).toHaveBeenCalledWith("<html>see other</html>");
    expect(erroredWith(next)).toBeUndefined();
  });

  it("forwards multi-arg send calls to Express untouched", () => {
    const { res, sent } = fakeRes(200, { "content-type": "application/json" });
    const next = vi.fn();
    mount(res, next);
    (res.send as (...args: unknown[]) => unknown)(JSON.stringify({ id: 7 }), 201);
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ id: 7 }), 201);
    expect(erroredWith(next)).toBeUndefined();
  });

  it("does not re-validate the error handler's own response (no loop)", () => {
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next);
    res.json({ id: 123 }); // fails -> forwards
    expect(erroredWith(next)).toBeInstanceOf(ResponseValidationError);
    // Simulate the error middleware sending its own (also-invalid) body.
    res.json({ problem: "details" });
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ problem: "details" }));
    expect(next.mock.calls.filter((c) => c[0] instanceof ResponseValidationError)).toHaveLength(1);
  });

  it("stringifies numeric header values before validating declared response headers", () => {
    const spec = widgetSpec();
    const get = spec.paths!["/widgets/{id}"]!.get as unknown as {
      responses: Record<string, { headers?: unknown }>;
    };
    get.responses["200"]!.headers = {
      "X-Request-Id": { required: true, schema: { type: "string" } },
    };
    const hv = createValidator(spec);
    const { res, sent } = fakeRes(200, { "x-request-id": 42 });
    const next = vi.fn();
    validateResponses(hv)(fakeReq(), res, next as unknown as NextFunction);
    res.json({ id: "ok" });
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ id: "ok" }));
    expect(erroredWith(next)).toBeUndefined();
  });

  it("fails the request when mounted twice on one chain", () => {
    const { res } = fakeRes();
    const next1 = vi.fn();
    const next2 = vi.fn();
    mount(res, next1);
    mount(res, next2);
    expect(next1).toHaveBeenCalledWith();
    const err = next2.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/mounted twice/);
  });

  it("invokes a custom onError with the failing leaves and context", () => {
    const onError = vi.fn();
    const { res } = fakeRes();
    const next = vi.fn();
    mount(res, next, { onError });
    res.json({ id: 123 });
    expect(onError).toHaveBeenCalledTimes(1);
    const [errors, ctx] = onError.mock.calls[0]!;
    expect(Array.isArray(errors)).toBe(true);
    expect(ctx).toMatchObject({ res, next });
  });

  it("log-and-continue: an onError that returns normally lets the body go out", () => {
    const onError = vi.fn(); // returns undefined -> normal completion
    const { res, sent } = fakeRes();
    const next = vi.fn();
    mount(res, next, { onError });
    res.json({ id: 123 }); // invalid, but onError doesn't throw
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ id: 123 }));
    expect(erroredWith(next)).toBeUndefined();
  });
});
