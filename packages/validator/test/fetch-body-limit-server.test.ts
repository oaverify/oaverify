import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenAPIDocument, ValidationError } from "@oaverify/internal-core";
import { httpStatusFor } from "@oaverify/internal-core";
import { expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * `maxTotalBytes` (#430) against a real socket, which the unit suite in
 * `fetch-max-total-bytes.test.ts` cannot reach.
 *
 * Two things only a server run covers. A locally constructed `Request`
 * carries no `Content-Length`, so the pre-check branch is unreachable
 * in-process without setting the header by hand; here a real client
 * populates it. And a chunked upload with no declared length arrives
 * as genuine multi-chunk stream pressure rather than a hand-built
 * `ReadableStream`.
 *
 * The handler shape mirrors what a Node-hosted Hono or Next.js adapter
 * does: wrap the incoming socket stream in a WHATWG `Request`, hand it
 * to `validateFetchRequest`, and answer from `httpStatusFor`.
 */

const spec: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/items": {
      post: {
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

it("bounds a real upload over a real socket, by declared length and by count", async () => {
  const validator = createValidator(spec, { maxTotalBytes: 1024 });

  // The shape a Hono/Next Node adapter uses: build a WHATWG Request
  // from the incoming socket stream.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const request = new Request(`http://localhost${req.url ?? "/"}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const result = await validator.validateFetchRequest(request);
      if (result.ok) {
        res.writeHead(200).end("ok");
        return;
      }
      const errors = (result as { errors: ValidationError[] }).errors;
      res.writeHead(httpStatusFor(errors), { "content-type": "application/json" });
      res.end(JSON.stringify({ code: errors[0]?.code, params: errors[0]?.params }));
    })();
  });
  // Bind and dial 127.0.0.1 explicitly rather than "localhost". A
  // runner whose resolver answers ::1 first, on a host with no IPv6
  // route, hangs the connect instead of failing it, which is a test
  // timeout with nothing in it that names the cause.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Under the cap: passes.
    const ok = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(ok.status).toBe(200);

    // Honest Content-Length over the cap: the pre-check fires.
    const declared = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "x".repeat(4096) }),
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({
      code: "body-too-large",
      params: { reason: "declared" },
    });

    // Chunked, no Content-Length: only the streamed count can catch it.
    const chunked = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('{"a":"'));
          for (let i = 0; i < 40; i++) controller.enqueue(enc.encode("x".repeat(256)));
          controller.enqueue(enc.encode('"}'));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(chunked.status).toBe(413);
    expect(await chunked.json()).toMatchObject({
      code: "body-too-large",
      params: { reason: "read" },
    });
  } finally {
    // fetch keeps its sockets pooled, and `close()` waits for every
    // connection to end, so closing without this waits on a keep-alive
    // socket that nothing is going to close.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 30_000);
