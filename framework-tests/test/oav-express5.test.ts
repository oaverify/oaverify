import { type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import {
  httpRequestFromExpress,
  renderProblemDetails,
  ResponseValidationError,
  validateRequests,
  validateResponses,
  type ValidateResponsesOptions,
} from "@oaverify/internal-oav-express5";
import { createValidator } from "@oaverify/internal-validator";
import express, { type Express, type Request } from "express-5";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-server integration tests against Express 5. Same scenario
 * names as oav-express4's integration suite (cross-adapter test
 * parity is part of the contract); the implementations differ only
 * where Express 5's promise-native middleware diverges from
 * Express 4's sync model.
 *
 * `express-5` is an npm alias for express@5 (see this directory's
 * package.json). End users `import express from "express"`; the alias
 * exists only so both express majors can be installed side-by-side
 * in one isolated sub-package.
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

async function listenOnZero(app: Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("oav-express5 integration: default validateRequests", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    const app = express();
    app.use(express.json());
    app.use(validateRequests(validator));
    app.post("/pets", (_req, res) => {
      res.json({ ok: true, kind: "post" });
    });
    app.get("/pets", (_req, res) => {
      res.json({ ok: true, kind: "get" });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("valid request reaches the handler", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({ name: "Fido" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; kind: string };
    expect(body).toEqual({ ok: true, kind: "post" });
  });

  it("invalid request returns 400 problem+details", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const body = (await r.json()) as { title: string; issues: unknown[] };
    expect(body.title).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("wrong verb returns 405 with Allow header", async () => {
    const r = await fetch(`${baseUrl}/pets`, { method: "DELETE" });
    expect(r.status).toBe(405);
    const allow = r.headers.get("allow") ?? "";
    expect(allow).toMatch(/POST/);
    expect(allow).toMatch(/GET/);
  });

  it("unknown path returns 404, and the body agrees", async () => {
    const r = await fetch(`${baseUrl}/nope`, { method: "GET" });
    expect(r.status).toBe(404);
    // RFC 9457 3.1.2: the body's `status` is the code the response carries.
    expect(await r.json()).toMatchObject({ status: 404 });
  });

  it("missing required header returns 400 problem+details", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fido" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === "header-param")).toBe(true);
  });

  // Pins the empty-POST row in docs/migration-from-eov.md, which is answered
  // by the body parser rather than by the adapter. Express 5's express.json()
  // leaves req.body undefined when it declines to parse, so the adapter sees no
  // body and answers body-required, the same answer either major gives with no
  // parser mounted. The Express 4 sibling test expects 415 from the same
  // request: its parser leaves req.body as {}, so a body appears to be present.
  it("empty POST with no Content-Type returns 400 with express.json() mounted", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "x-tenant": "acme" },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === "body")).toBe(true);
  });

  it("unmatched Content-Type returns 415", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-tenant": "acme" },
      body: "not json",
    });
    expect(r.status).toBe(415);
  });
});

describe("oav-express5 integration: custom onError", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    const app = express();
    app.use(express.json());
    app.use(
      validateRequests(validator, {
        onError: (_err, ctx) => {
          ctx.res.status(422).json({ kind: "custom-envelope" });
        },
      }),
    );
    app.post("/pets", (_req, res) => {
      res.json({ ok: true });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("custom onError runs and writes a custom envelope; handler not reached", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { kind: string };
    expect(body.kind).toBe("custom-envelope");
  });
});

describe("oav-express5 integration: report-only onError", () => {
  let server: Server;
  let baseUrl: string;
  const seen: ValidationError[][] = [];

  beforeAll(async () => {
    // The observation mode docs/integration.md documents: log every
    // violation, reject nothing. On Express the handler owns what
    // happens next, and the middleware does not call `next()` for it,
    // so a report-only handler has to call `next()` itself.
    const validator = createValidator(petSpec(), { maxErrors: Number.POSITIVE_INFINITY });
    const app = express();
    app.use(express.json());
    app.use(
      validateRequests(validator, {
        onError: (errors, ctx) => {
          seen.push(errors);
          ctx.next();
        },
      }),
    );
    app.post("/pets", (_req, res) => {
      res.json({ ok: true });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("report-only onError logs and the invalid request still reaches the handler", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    // An observation period wants the whole list, which is why the
    // validator above raises the default maxErrors of 1.
    expect(seen[0]!.length).toBeGreaterThan(1);
  });
});

describe("oav-express5 integration: async onError", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    const app = express();
    app.use(express.json());
    app.use(
      validateRequests(validator, {
        onError: async (err, ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          renderProblemDetails(err, ctx);
        },
      }),
    );
    app.post("/pets", (_req, res) => {
      res.json({ ok: true });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("an async onError writes the response, and the middleware awaits it", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { title: string };
    expect(body.title).toBe("Validation failed");
  });
});

describe("oav-express5 integration: custom toHttpRequest", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { verifiedBody?: unknown }).verifiedBody = { name: "Fido" };
      next();
    });
    app.use(
      validateRequests(validator, {
        toHttpRequest: (req: Request) => {
          const httpReq = httpRequestFromExpress(req);
          const fancy = (req as Request & { verifiedBody?: unknown }).verifiedBody;
          if (fancy !== undefined) httpReq.body = fancy;
          return httpReq;
        },
      }),
    );
    app.post("/pets", (_req, res) => {
      res.json({ ok: true });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("custom toHttpRequest extractor reaches the validator", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
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

function thingSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" }, createdAt: { type: "string" } },
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

describe("oav-express5 integration: validateResponses serialization fidelity", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(thingSpec());
    const app = express();
    // Settings real apps use; both change the wire body relative to the
    // object handed to res.json.
    app.set("json spaces", 2);
    app.set("json replacer", (key: string, value: unknown) =>
      key === "secret" ? undefined : value,
    );
    app.use(validateResponses(validator));
    app.get("/things", (req, res) => {
      const kind = String(req.query.kind ?? "");
      if (kind === "date") return res.json({ id: "ok", createdAt: new Date() });
      if (kind === "tojson") {
        class Thing {
          id = "ok";
          internal = "not in spec";
          toJSON() {
            return { id: this.id };
          }
        }
        return res.json(new Thing());
      }
      if (kind === "replacer") return res.json({ id: "ok", secret: "stripped on the wire" });
      if (kind === "bad") return res.json({ id: 123 });
      return res.json({ id: "ok" });
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("a Date serializing to a declared string field is valid", async () => {
    const r = await fetch(`${baseUrl}/things?kind=date`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; createdAt: string };
    expect(typeof body.createdAt).toBe("string");
  });

  it("toJSON output is what gets validated, not the live instance", async () => {
    const r = await fetch(`${baseUrl}/things?kind=tojson`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "ok" });
  });

  it("the json replacer setting is applied before validation", async () => {
    const r = await fetch(`${baseUrl}/things?kind=replacer`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "ok" });
  });

  it("pretty-printed output (json spaces) is still validated", async () => {
    const r = await fetch(`${baseUrl}/things?kind=bad`);
    expect(r.status).toBe(500);
  });
});

describe("oav-express5 integration: default validateResponses", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    const app = express();
    app.use(validateResponses(validator));
    app.get("/widgets/:id", (req, res) => {
      if (req.params.id === "bad") return res.json({ id: 123 }); // id must be a string
      if (req.params.id === "teapot") return res.status(418).json({ id: "ok" }); // undeclared status
      return res.json({ id: req.params.id });
    });
    app.use(((err: Error, _req, res, next) => {
      if (err instanceof ResponseValidationError) {
        res.status(err.statusCode).json({ responseInvalid: true, count: err.errors.length });
        return;
      }
      void next;
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("a valid response body passes through unchanged", async () => {
    const r = await fetch(`${baseUrl}/widgets/ok`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "ok" });
  });

  it("an invalid response body forwards a 500 to the host error handler", async () => {
    const r = await fetch(`${baseUrl}/widgets/bad`);
    expect(r.status).toBe(500);
    const body = (await r.json()) as { responseInvalid: boolean; count: number };
    expect(body.responseInvalid).toBe(true);
    expect(body.count).toBeGreaterThan(0);
  });

  it("an undeclared response status is a finding (500)", async () => {
    const r = await fetch(`${baseUrl}/widgets/teapot`);
    expect(r.status).toBe(500);
  });
});

describe("oav-express5 integration: validateResponses log-and-continue", () => {
  let server: Server;
  let baseUrl: string;
  const logged: number[] = [];

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    const app = express();
    app.use(
      validateResponses(validator, {
        // Log the finding and return; the adapter sends the original
        // (invalid) body unchanged.
        onError: (errors) => {
          logged.push(errors.length);
        },
      }),
    );
    app.get("/widgets/:id", (_req, res) => res.json({ id: 123 }));
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("custom onError can record the finding and still send the body", async () => {
    const r = await fetch(`${baseUrl}/widgets/anything`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: 123 });
    expect(logged.length).toBe(1);
    expect(logged[0]).toBeGreaterThan(0);
  });
});

describe("oav-express5 integration: validateResponses send variants", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    const app = express();
    app.use(validateResponses(validator));
    app.get("/widgets/:id", (req, res) => {
      switch (req.params.id) {
        case "empty":
          return res.json();
        case "empty-undeclared":
          res.status(202);
          return res.json();
        case "obj-send":
          return res.send({ id: "ok" });
        case "obj-send-bad":
          return res.send({ id: 123 });
        case "buffer":
          return res.type("json").send(Buffer.from(JSON.stringify({ id: 123 })));
        case "malformed":
          return res.type("json").send("{not json");
        case "sendstatus":
          return res.sendStatus(418);
        case "stream": {
          res.setHeader("content-type", "application/json");
          res.write('{"id":');
          return res.end("123}");
        }
        case "redirect":
          return res.redirect(302, "/widgets/ok");
        case "jsonp":
          return res.jsonp({ id: 123 });
        default:
          return res.json({ id: req.params.id });
      }
    });
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("an empty JSON-typed response with a declared status passes", async () => {
    const r = await fetch(`${baseUrl}/widgets/empty`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("an empty JSON-typed response with an undeclared status is a finding", async () => {
    const r = await fetch(`${baseUrl}/widgets/empty-undeclared`);
    expect(r.status).toBe(500);
  });

  it("an object through res.send is validated (valid passes)", async () => {
    const r = await fetch(`${baseUrl}/widgets/obj-send`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "ok" });
  });

  it("an object through res.send is validated (invalid is a 500)", async () => {
    const r = await fetch(`${baseUrl}/widgets/obj-send-bad`);
    expect(r.status).toBe(500);
  });

  it("a Buffer body passes through unvalidated even with a JSON content type", async () => {
    const r = await fetch(`${baseUrl}/widgets/buffer`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: 123 });
  });

  it("a malformed JSON string passes through untouched", async () => {
    const r = await fetch(`${baseUrl}/widgets/malformed`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("{not json");
  });

  it("res.sendStatus with an undeclared status is a finding (status checked even for non-JSON)", async () => {
    // sendStatus routes through res.send with a text body. The body
    // itself isn't validated (non-JSON), but the status is: 418 isn't
    // declared, so it surfaces as a 500. (res.redirect, by contrast, uses
    // res.end and bypasses the wrapper; see the redirect test below.)
    const r = await fetch(`${baseUrl}/widgets/sendstatus`);
    expect(r.status).toBe(500);
  });

  it("a streamed response (res.write / res.end) bypasses validation", async () => {
    const r = await fetch(`${baseUrl}/widgets/stream`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: 123 });
  });

  it("a redirect passes through untouched", async () => {
    const r = await fetch(`${baseUrl}/widgets/redirect`, { redirect: "manual" });
    expect(r.status).toBe(302);
  });

  it("res.jsonp with a callback goes out as JavaScript, unvalidated", async () => {
    const r = await fetch(`${baseUrl}/widgets/jsonp?callback=cb`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
  });

  it("res.jsonp without a callback is plain JSON and is validated", async () => {
    const r = await fetch(`${baseUrl}/widgets/jsonp`);
    expect(r.status).toBe(500);
  });
});

describe("oav-express5 integration: validateResponses real-world flows", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const spec = widgetSpec();
    const widget = spec.paths!["/widgets/{id}"] as {
      get: { responses: Record<string, unknown> };
    };
    widget.get.responses["500"] = {
      description: "error",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
    };
    const validator = createValidator(spec);
    const app = express();
    app.use(validateResponses(validator));
    app.get("/widgets/:id", (req, res) => {
      switch (req.params.id) {
        case "null-body":
          return res.json(null);
        case "throws":
          throw new Error("boom");
        case "double-send":
          res.json({ id: "first" });
          return res.json({ id: "second" });
        default:
          return res.json({ id: req.params.id });
      }
    });
    app.use(((err: Error, _req, res, next) => {
      if (res.headersSent) return next(err);
      res.status(500).json({ error: err.message });
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("res.json(null) is a finding, rendered through the declared 500", async () => {
    const r = await fetch(`${baseUrl}/widgets/null-body`);
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/failed validation/);
  });

  it("an error middleware response matching the declared 500 passes validation", async () => {
    const r = await fetch(`${baseUrl}/widgets/throws`);
    expect(r.status).toBe(500);
    expect((await r.json()) as unknown).toEqual({ error: "boom" });
  });

  it("the double-send handler bug behaves as without the middleware", async () => {
    const r = await fetch(`${baseUrl}/widgets/double-send`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "first" });
  });

  it("a conditional GET with a matching ETag still gets its 304", async () => {
    const first = await fetch(`${baseUrl}/widgets/ok`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    // The empty cache-control stops undici from suppressing freshness.
    const second = await fetch(`${baseUrl}/widgets/ok`, {
      headers: { "if-none-match": etag!, "cache-control": "" },
    });
    expect(second.status).toBe(304);
  });

  it("a HEAD request validates against the GET operation (RFC 9110 fallback)", async () => {
    const r = await fetch(`${baseUrl}/widgets/ok`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
});

describe("oav-express5 integration: validateResponses double mount", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    const app = express();
    app.use(validateResponses(validator));
    app.use(validateResponses(validator)); // configuration error
    app.get("/widgets/:id", (_req, res) => res.json({ id: "ok" }));
    app.use(((err: Error, _req, res, next) => {
      // Respond through the unwrapped res.end: the first mount's wrapper
      // is still active and would treat this 500 (undeclared in the
      // spec) as a finding of its own.
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
      void next;
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("the second mount fails the request with a clear error", async () => {
    const r = await fetch(`${baseUrl}/widgets/ok`);
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/mounted twice/);
  });
});

describe("oav-express5 integration: Express 5 specifics", () => {
  let server: Server;
  let baseUrl: string;
  const captured: Error[] = [];

  beforeAll(async () => {
    const validator = createValidator(petSpec());
    const app = express();
    app.use(express.json());
    app.use(
      validateRequests(validator, {
        toHttpRequest: () => {
          // Express 5 awaits returned promises; a thrown error propagates
          // through the promise chain to the error middleware below
          // without explicit try/catch in our middleware.
          throw new Error("extractor exploded");
        },
      }),
    );
    app.use(((err: Error, _req, res, next) => {
      captured.push(err);
      res.status(500).json({ error: err.message });
      void next;
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("thrown extractor errors propagate to the host's error middleware via Express 5's promise chain", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({ name: "Fido" }),
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("extractor exploded");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe("extractor exploded");
  });
});

describe("oav-express5 integration: validateResponses with requireResponseBody", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec(), { requireResponseBody: true });
    const app = express();
    app.use(validateResponses(validator));
    app.get("/widgets/:id", (req, res) => {
      if (req.params.id === "empty") return res.json(); // 200 declares content; body absent
      return res.json({ id: req.params.id });
    });
    app.use(((err: Error, _req, res, next) => {
      if (err instanceof ResponseValidationError) {
        res.status(err.statusCode).json({ responseInvalid: true });
        return;
      }
      void next;
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("an empty body on a content-declaring status is a finding (500)", async () => {
    const r = await fetch(`${baseUrl}/widgets/empty`);
    expect(r.status).toBe(500);
    const body = (await r.json()) as { responseInvalid: boolean };
    expect(body.responseInvalid).toBe(true);
  });

  it("a present body still passes", async () => {
    const r = await fetch(`${baseUrl}/widgets/ok`);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ id: "ok" });
  });

  it("HEAD against the GET operation stays exempt even with an absent body", async () => {
    const r = await fetch(`${baseUrl}/widgets/empty`, { method: "HEAD" });
    expect(r.status).toBe(200);
  });
});

describe("oav-express5 integration: the request leg relies on the router, so pin it", () => {
  // This adapter does not substitute on the request leg: it awaits
  // `onError`, and Express 5's router turns a rejected middleware promise
  // into an error itself. That is a third-party guarantee across the
  // whole `express ^5.0.0` peer range, so it is pinned here rather than
  // assumed (#881).
  let server: Server;
  let baseUrl: string;
  let handlerRan = false;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      validateRequests(createValidator(petSpec()), {
        onError: async () => {
          await new Promise((r) => setTimeout(r, 1));
          throw undefined;
        },
      }),
    );
    app.post("/pets", (_req, res) => {
      handlerRan = true;
      res.status(201).json({ reached: true });
    });
    app.use(((_err: unknown, _req, res, _next) => {
      res.status(599).end();
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("the route handler does not run", async () => {
    const r = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": "acme" },
      body: JSON.stringify({}),
    });
    expect(handlerRan).toBe(false);
    expect(r.status).toBe(599);
  });
});

describe("oav-express5 integration: a falsy onError rejection is not read as continue-routing", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const validator = createValidator(widgetSpec());
    const app = express();
    // Express reads next(falsy) as "carry on routing". Before #881 a
    // callback rejecting with a falsy reason dropped the finding here and
    // the request fell through to a 404, on both Express versions.
    app.use(
      validateResponses(validator, {
        onError: async () => {
          await new Promise((r) => setTimeout(r, 1));
          throw undefined;
        },
      }),
    );
    app.get("/widgets/:id", (_req, res) => {
      res.json({ id: 123 }); // id must be a string, so onError runs
    });
    app.use(((_err: unknown, _req, res, _next) => {
      res.status(599).end();
    }) as express.ErrorRequestHandler);
    ({ server, baseUrl } = await listenOnZero(app));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("the rejection reaches the host error chain", async () => {
    const r = await fetch(`${baseUrl}/widgets/w1`);
    expect(r.status).toBe(599);
  });
});

describe("oav-express5 integration: every falsy failure spelling forwards, none is swallowed", () => {
  // A synchronous throw escapes before any promise exists, and a throwing
  // extractor never installs the send wrapper at all, so the response would
  // otherwise go out unchecked. Each case needs its own server: a second
  // validateResponses on one chain trips the double-mount guard, which
  // answers 599 for an unrelated reason.
  const cases: Array<[string, ValidateResponsesOptions]> = [
    [
      "a synchronous falsy throw",
      {
        onError: () => {
          throw undefined;
        },
      },
    ],
    [
      "a falsy throw from the extractor",
      {
        toHttpRequest: () => {
          throw undefined;
        },
      },
    ],
  ];

  for (const [label, options] of cases) {
    it(`${label} reaches the host error chain`, async () => {
      const app = express();
      app.use(validateResponses(createValidator(widgetSpec()), options));
      app.get("/widgets/:id", (_req, res) => {
        res.json({ id: 123 });
      });
      app.use(((_err: unknown, _req, res, _next) => {
        res.status(599).end();
      }) as express.ErrorRequestHandler);
      const { server, baseUrl } = await listenOnZero(app);
      try {
        const r = await fetch(`${baseUrl}/widgets/w1`);
        expect(r.status).toBe(599);
      } finally {
        await closeServer(server);
      }
    });
  }
});
