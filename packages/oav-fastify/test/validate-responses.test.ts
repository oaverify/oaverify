import { type OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
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

function fakeReply(statusCode = 200, contentType = "application/json"): FastifyReply {
  const headers: Record<string, string> = { "content-type": contentType };
  return {
    statusCode,
    getHeader: (n: string) => headers[n.toLowerCase()],
    getHeaders: () => headers,
  } as unknown as FastifyReply;
}

function fakeRequest(): FastifyRequest {
  return { method: "GET", url: "/widgets/42", headers: {} } as unknown as FastifyRequest;
}

const v = createValidator(widgetSpec());

// The hook ignores `this`; the cast satisfies the onSendHookHandler call shape.
function run(
  hook: ReturnType<typeof validateResponses>,
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) {
  return (
    hook as unknown as (
      req: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
    ) => Promise<unknown>
  )(request, reply, payload);
}

describe("validateResponses (Fastify)", () => {
  it("rejects a predicate-mode validator at construction", () => {
    const predicate = createValidator(widgetSpec(), { output: "predicate" });
    expect(() => validateResponses(predicate as never)).toThrow(/predicate-mode/);
  });

  it("returns a valid payload unchanged", async () => {
    const payload = JSON.stringify({ id: "ok" });
    await expect(run(validateResponses(v), fakeRequest(), fakeReply(), payload)).resolves.toBe(
      payload,
    );
  });

  it("throws a ResponseValidationError for an invalid payload", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(), JSON.stringify({ id: 123 })),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it("treats an undeclared status as a finding by default", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(418), JSON.stringify({ id: "ok" })),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it("skips statuses the predicate excludes", async () => {
    const payload = JSON.stringify({ anything: true });
    await expect(
      run(
        validateResponses(v, { statuses: (s) => s < 500 }),
        fakeRequest(),
        fakeReply(500),
        payload,
      ),
    ).resolves.toBe(payload);
  });

  it("passes non-JSON payloads through untouched", async () => {
    const payload = "<html>not json</html>";
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(200, "text/html"), payload),
    ).resolves.toBe(payload);
  });

  it("passes a malformed JSON payload through untouched", async () => {
    const payload = "{not valid json";
    await expect(run(validateResponses(v), fakeRequest(), fakeReply(), payload)).resolves.toBe(
      payload,
    );
  });

  it("checks the status of an empty payload with a JSON content type", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(418), null),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it("an empty payload with a declared status passes", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(200), null),
    ).resolves.toBeNull();
  });

  it("passes a Buffer payload through untouched", async () => {
    const payload = Buffer.from(JSON.stringify({ id: 123 }));
    await expect(run(validateResponses(v), fakeRequest(), fakeReply(), payload)).resolves.toBe(
      payload,
    );
  });

  it("does not re-validate the error handler's own response (no loop)", async () => {
    const hook = validateResponses(v);
    const request = fakeRequest();
    await expect(
      run(hook, request, fakeReply(), JSON.stringify({ id: 123 })),
    ).rejects.toBeInstanceOf(ResponseValidationError);
    // Fastify renders the error reply through onSend again with the same request.
    const errorPayload = JSON.stringify({ statusCode: 500, error: "Internal Server Error" });
    await expect(run(hook, request, fakeReply(500), errorPayload)).resolves.toBe(errorPayload);
  });

  it("stringifies numeric header values before validating declared response headers", async () => {
    const spec = widgetSpec();
    const get = spec.paths!["/widgets/{id}"]!.get as unknown as {
      responses: Record<string, { headers?: unknown }>;
    };
    get.responses["200"]!.headers = {
      "X-Request-Id": { required: true, schema: { type: "string" } },
    };
    const hv = createValidator(spec);
    // Node allows numeric header values (reply.header("X-Request-Id",
    // 42)) and getHeaders() reports them as numbers; the hook must hand
    // the validator strings or a string-typed header misfires.
    const headers: Record<string, unknown> = {
      "content-type": "application/json",
      "x-request-id": 42,
    };
    const reply = {
      statusCode: 200,
      getHeader: (n: string) => headers[n.toLowerCase()],
      getHeaders: () => headers,
    } as unknown as FastifyReply;
    const payload = JSON.stringify({ id: "ok" });
    await expect(run(validateResponses(hv), fakeRequest(), reply, payload)).resolves.toBe(payload);
  });

  // Status and header validation are independent of the body's media
  // type: a 204, a redirect, or a text error page still has a status the
  // spec may not declare and headers it may require. The adapter must
  // not skip those checks just because the body isn't parseable JSON.
  it("flags an undeclared status on a non-JSON response", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(418, "text/html"), "<html>teapot</html>"),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it("flags an undeclared status on an empty (no-content) response", async () => {
    await expect(
      run(validateResponses(v), fakeRequest(), fakeReply(204, ""), null),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it("flags a missing required header on a non-JSON response", async () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/widgets/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "302": {
                description: "redirect",
                headers: { Location: { required: true, schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const hv = createValidator(spec);
    // 302, text/html body, no Location header set.
    await expect(
      run(
        validateResponses(hv),
        fakeRequest(),
        fakeReply(302, "text/html"),
        "<html>see other</html>",
      ),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  function fakeReplyWith(statusCode: number, headers: Record<string, string>): FastifyReply {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
      statusCode,
      getHeader: (n: string) => lower[n.toLowerCase()],
      getHeaders: () => lower,
    } as unknown as FastifyReply;
  }

  it("passes a non-JSON response whose status is declared and headers satisfied", async () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/widgets/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "302": {
                description: "redirect",
                headers: { Location: { required: true, schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const hv = createValidator(spec);
    const payload = "<html>see other</html>";
    await expect(
      run(
        validateResponses(hv),
        fakeRequest(),
        fakeReplyWith(302, { "content-type": "text/html", location: "/elsewhere" }),
        payload,
      ),
    ).resolves.toBe(payload);
  });

  it("invokes a custom onError with the failing leaves and context", async () => {
    const onError = vi.fn();
    const reply = fakeReply();
    const payload = JSON.stringify({ id: 123 });
    // onError returns normally, so the (invalid) payload is sent unchanged.
    await expect(
      run(validateResponses(v, { onError }), fakeRequest(), reply, payload),
    ).resolves.toBe(payload);
    expect(onError).toHaveBeenCalledTimes(1);
    const [errors, ctx] = onError.mock.calls[0]!;
    expect(Array.isArray(errors)).toBe(true);
    expect(ctx).toMatchObject({ reply });
  });
});
