import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { validateRequests } from "@oaverify/internal-oav-fastify";
import { createValidator } from "@oaverify/internal-validator";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Fastify request paths over HTTP (#1189)", () => {
  let app: FastifyInstance;
  let port: number;
  const handled: string[] = [];

  beforeAll(async () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/admin/users": {
          get: {
            parameters: [
              { name: "token", in: "query", required: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
        "/users": { get: { responses: { "200": { description: "ok" } } } },
      },
    };
    app = Fastify({ routerOptions: { ignoreDuplicateSlashes: true } });
    app.addHook("preValidation", validateRequests(createValidator(spec)));
    for (const path of ["/admin/users", "/users"]) {
      app.get(path, async () => {
        handled.push(path);
        return { handler: path };
      });
    }
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  async function request(path: string): Promise<{ status: number | undefined; body: unknown }> {
    // Send the request target verbatim so the client cannot normalize it.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ hostname: "127.0.0.1", port, path }, resolve).on("error", reject);
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    return {
      status: response.statusCode,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  }

  it.each(["/admin/users", "//admin/users", "http://example.test/admin/users"])(
    "%s cannot reach the handler without its required parameter",
    async (path) => {
      const before = handled.length;
      const response = await request(path);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        issues: [{ code: "query-param", path: ["query", "token"] }],
      });
      expect(handled).toHaveLength(before);
    },
  );

  it.each(["/admin/users", "//admin/users", "http://example.test/admin/users"])(
    "%s reaches the intended handler with its required parameter",
    async (path) => {
      const before = handled.length;
      expect(await request(`${path}?token=present`)).toEqual({
        status: 200,
        body: { handler: "/admin/users" },
      });
      expect(handled.slice(before)).toEqual(["/admin/users"]);
    },
  );

  it("still accepts the operation that requires no parameter", async () => {
    expect(await request("/users")).toEqual({ status: 200, body: { handler: "/users" } });
  });
});
