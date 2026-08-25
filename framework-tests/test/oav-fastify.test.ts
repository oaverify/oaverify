import { type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import {
  httpRequestFromFastify,
  renderProblemDetails,
  ResponseValidationError,
  validateRequests,
  validateResponses,
} from "@oaverify/internal-oav-fastify";
import { createValidator } from "@oaverify/internal-validator";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-server integration tests against Fastify. Uses
 * `fastify.inject()` (Fastify-native synthetic-request API) instead
 * of `app.listen(0)` + native fetch; `inject` is so idiomatic in
 * Fastify-land that bending the cross-adapter native-fetch
 * convention here earns its keep.
 */

function petSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/pets": {
        post: {
          parameters: [
            { name: "x-tenant", in: "header", required: true, schema: { type: "string" } },
          ],
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
        get: {
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("oav-fastify integration: default validateRequests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook("preValidation", validateRequests(validator));
    app.post("/pets", async () => ({ ok: true, kind: "post" }));
    app.get("/pets", async () => ({ ok: true, kind: "get" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("valid request reaches the handler", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({ name: "Fido" }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, kind: "post" });
  });

  it("invalid request returns 400 problem+details", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers["content-type"]).toMatch(/application\/problem\+json/);
    const body = r.json() as { title: string; issues: unknown[] };
    expect(body.title).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("wrong verb returns 405 with Allow header", async () => {
    const r = await app.inject({ method: "DELETE", url: "/pets" });
    expect(r.statusCode).toBe(405);
    const allow = (r.headers.allow as string | undefined) ?? "";
    expect(allow).toMatch(/POST/);
    expect(allow).toMatch(/GET/);
  });

  it("unknown path returns 404, and the body agrees", async () => {
    const r = await app.inject({ method: "GET", url: "/nope" });
    expect(r.statusCode).toBe(404);
    // RFC 9457 3.1.2: the body's `status` is the code the response carries.
    expect(r.json()).toMatchObject({ status: 404 });
  });

  it("missing required header returns 400 problem+details", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "Fido" }),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === "header-param")).toBe(true);
  });

  it("unmatched Content-Type returns 415", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "text/plain", "x-tenant": "acme" },
      payload: "not json",
    });
    expect(r.statusCode).toBe(415);
  });
});

describe("oav-fastify integration: custom onError", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        onError: (_err, ctx) => {
          ctx.reply.code(422).send({ kind: "custom-envelope" });
        },
      }),
    );
    app.post("/pets", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("custom onError runs and writes a custom envelope; handler not reached", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ kind: "custom-envelope" });
  });
});

describe("oav-fastify integration: report-only onError", () => {
  let app: FastifyInstance;
  const seen: ValidationError[][] = [];

  beforeAll(async () => {
    // The observation mode docs/integration.md documents: log every
    // violation, reject nothing. The Fastify shape is the mirror of
    // Express's: the hook resolves on its own once `onError` returns,
    // so a report-only handler passes traffic through by NOT sending a
    // reply. Touching `reply` is what stops the request.
    const validator = createValidator(petSpec(), { maxErrors: Number.POSITIVE_INFINITY });
    app = Fastify();
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        onError: (errors) => {
          seen.push(errors);
        },
      }),
    );
    app.post("/pets", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("report-only onError logs and the invalid request still reaches the handler", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    // An observation period wants the whole list, which is why the
    // validator above raises the default maxErrors of 1.
    expect(seen[0]!.length).toBeGreaterThan(1);
  });
});

describe("oav-fastify integration: async onError", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        onError: async (err, ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          renderProblemDetails(err, ctx);
        },
      }),
    );
    app.post("/pets", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("an async onError writes the response, and the hook awaits it", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { title: string };
    expect(body.title).toBe("Validation failed");
  });
});

describe("oav-fastify integration: custom toHttpRequest", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook("preHandler", async (request) => {
      (request as FastifyRequest & { verifiedBody?: unknown }).verifiedBody = { name: "Fido" };
    });
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        toHttpRequest: (request) => {
          const httpReq = httpRequestFromFastify(request);
          const fancy = (request as FastifyRequest & { verifiedBody?: unknown }).verifiedBody;
          if (fancy !== undefined) httpReq.body = fancy;
          return httpReq;
        },
      }),
    );
    // preHandler runs after preValidation; need to set verifiedBody earlier.
    app.addHook("onRequest", async (request) => {
      (request as FastifyRequest & { verifiedBody?: unknown }).verifiedBody = { name: "Fido" };
    });
    app.post("/pets", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("custom toHttpRequest extractor reaches the validator", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("oav-fastify integration: Fastify specifics", () => {
  let app: FastifyInstance;
  const captured: Error[] = [];

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        toHttpRequest: () => {
          // Fastify is async-native: thrown errors propagate via the
          // promise chain to Fastify's setErrorHandler without explicit
          // try/catch in our hook.
          throw new Error("extractor exploded");
        },
      }),
    );
    app.setErrorHandler((err: Error, _request, reply) => {
      captured.push(err);
      reply.code(500).send({ error: err.message });
    });
    app.post("/pets", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("thrown extractor errors propagate to Fastify's setErrorHandler via the promise chain", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({ name: "Fido" }),
    });
    expect(r.statusCode).toBe(500);
    const body = r.json() as { error: string };
    expect(body.error).toBe("extractor exploded");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe("extractor exploded");
  });
});

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

describe("oav-fastify integration: validateResponses serialization fidelity", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const spec = widgetSpec();
    const widget = spec.paths!["/widgets/{id}"] as {
      get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> };
    };
    widget.get.responses["200"]!.content["application/json"]!.schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, createdAt: { type: "string" } },
      additionalProperties: false,
    };
    const validator = createValidator(spec);
    app = Fastify();
    app.addHook("onSend", validateResponses(validator));
    app.get("/widgets/:id", async (request) => {
      const { id } = request.params as { id: string };
      if (id === "date") return { id: "ok", createdAt: new Date() };
      if (id === "tojson") {
        class Thing {
          id = "ok";
          internal = "not in spec";
          toJSON() {
            return { id: this.id };
          }
        }
        return new Thing();
      }
      return { id };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a Date serializing to a declared string field is valid", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/date" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { createdAt: string };
    expect(typeof body.createdAt).toBe("string");
  });

  it("toJSON output is what gets validated, not the live instance", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/tojson" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "ok" });
  });
});

describe("oav-fastify integration: default validateResponses", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    app = Fastify();
    app.addHook("onSend", validateResponses(validator));
    app.setErrorHandler((err: Error, _request, reply) => {
      if (err instanceof ResponseValidationError) {
        reply.code(err.statusCode).send({ responseInvalid: true, count: err.errors.length });
        return;
      }
      reply.code(500).send({ error: err.message });
    });
    app.get("/widgets/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === "bad") return { id: 123 }; // id must be a string
      if (id === "teapot") {
        reply.code(418); // undeclared status
        return { id: "ok" };
      }
      if (id === "empty") {
        return reply.header("content-type", "application/json").send();
      }
      if (id === "empty-undeclared") {
        return reply.code(202).header("content-type", "application/json").send();
      }
      return { id };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a valid response body passes through unchanged", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/ok" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "ok" });
  });

  it("an invalid response body forwards a 500 to the error handler", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/bad" });
    expect(r.statusCode).toBe(500);
    const body = r.json() as { responseInvalid: boolean; count: number };
    expect(body.responseInvalid).toBe(true);
    expect(body.count).toBeGreaterThan(0);
  });

  it("an undeclared response status is a finding (500)", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/teapot" });
    expect(r.statusCode).toBe(500);
  });

  it("an empty JSON-typed response with a declared status passes", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/empty" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("");
  });

  it("an empty JSON-typed response with an undeclared status is a finding", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/empty-undeclared" });
    expect(r.statusCode).toBe(500);
  });
});

describe("oav-fastify integration: validateResponses log-and-continue", () => {
  let app: FastifyInstance;
  const logged: number[] = [];

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    app = Fastify();
    app.addHook(
      "onSend",
      validateResponses(validator, {
        // Log the finding but let the (invalid) payload go out unchanged.
        onError: (errors) => {
          logged.push(errors.length);
        },
      }),
    );
    app.get("/widgets/:id", async () => ({ id: 123 }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("custom onError records the finding and still sends the body", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/anything" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: 123 });
    expect(logged.length).toBe(1);
    expect(logged[0]).toBeGreaterThan(0);
  });
});

describe("oav-fastify integration: validateResponses with requireResponseBody", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec(), { requireResponseBody: true });
    app = Fastify();
    app.addHook("onSend", validateResponses(validator));
    app.setErrorHandler((err: Error, _request, reply) => {
      if (err instanceof ResponseValidationError) {
        reply.code(err.statusCode).send({ responseInvalid: true });
        return;
      }
      reply.code(500).send({ error: err.message });
    });
    app.get("/widgets/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === "empty") {
        return reply.header("content-type", "application/json").send(); // 200 declares content; body absent
      }
      return { id };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("an empty body on a content-declaring status is a finding (500)", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/empty" });
    expect(r.statusCode).toBe(500);
    expect((r.json() as { responseInvalid: boolean }).responseInvalid).toBe(true);
  });

  it("a present body still passes", async () => {
    const r = await app.inject({ method: "GET", url: "/widgets/ok" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "ok" });
  });

  it("HEAD against the GET operation stays exempt even with an absent body", async () => {
    const r = await app.inject({ method: "HEAD", url: "/widgets/empty" });
    expect(r.statusCode).toBe(200);
  });
});

describe("oav-fastify integration: both hooks mounted together", () => {
  /**
   * `onSend` runs for every reply, including ones no route handler
   * produced. Without scoping, mounting both hooks (which is what the
   * README's two recipes do) turned every request-validation 400 and
   * every Fastify 404 into a 500.
   *
   * The Express adapters avoid this by mount order: `validateResponses`
   * patches `res.send`, so mounting it after `validateRequests` leaves
   * the refusal outside what it wraps. `onSend` is a lifecycle hook, so
   * no registration order helps and the adapter has to scope itself.
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    app = Fastify();
    app.addHook("preValidation", validateRequests(validator));
    app.addHook("onSend", validateResponses(validator));
    app.post("/pets", async (_req, reply) => reply.code(200).send({ id: "1", name: "rex" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a refused request keeps its 400 instead of becoming a 500", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: { wrong: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers["content-type"]).toContain("application/problem+json");
  });

  it("an unmatched route keeps Fastify's 404", async () => {
    const r = await app.inject({ method: "GET", url: "/no-such-path" });
    expect(r.statusCode).toBe(404);
  });

  it("a valid request is still response-validated", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: { name: "rex" },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("oav-fastify integration: report-only request onError plus response validation", () => {
  /**
   * The refusal skip covers the window in which `onError` might send,
   * and no longer. A report-only `onError` records the errors and
   * returns without sending, so the route handler runs after all and
   * its response is ordinary handler output.
   *
   * A mark that outlived the refusal would pass that response through
   * unchecked, which is the failure this pins.
   */
  let app: FastifyInstance;
  const seen: ValidationError[][] = [];

  beforeAll(async () => {
    // petSpec declares no response schema, so a wrong body would pass
    // for the wrong reason. This one constrains the response too.
    const spec = petSpec();
    spec.paths!["/pets"]!.post!.responses = {
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          },
        },
      },
    };
    const validator = createValidator(spec);
    app = Fastify();
    app.addHook(
      "preValidation",
      validateRequests(validator, {
        onError: (errors) => {
          seen.push(errors);
        },
      }),
    );
    app.addHook("onSend", validateResponses(validator));
    // `id` is a number where the spec says string, so the response is
    // invalid whether or not the request was.
    app.post("/pets", async (_req, reply) => reply.code(200).send({ id: 123 }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("still validates the response of a request it only reported on", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/pets",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      payload: JSON.stringify({ wrong: 1 }),
    });
    expect(r.statusCode).toBe(500);
    // The request errors were still reported, not swallowed.
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("oav-fastify integration: validateResponses alone still reports an undeclared path", () => {
  // The skip is scoped to replies no handler produced, so it must not
  // swallow a finding about a route Fastify matched. With only the
  // response hook mounted, an undocumented path reaches the handler and
  // its response has no operation to be checked against.
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.addHook("onSend", validateResponses(createValidator(petSpec())));
    app.get("/undocumented", async (_req, reply) => reply.code(200).send({ hi: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports a route the spec does not declare", async () => {
    const r = await app.inject({ method: "GET", url: "/undocumented" });
    expect(r.statusCode).toBe(500);
  });
});
