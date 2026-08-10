/**
 * Web Standards validation: one `Request` in, one `Response` out, with
 * no framework and no adapter package. This is the shape for Next.js
 * route handlers, Hono, Bun.serve, and Deno.serve.
 *
 * `validateFetchRequest` wraps `validateRequest` with body parsing, so
 * the handler gets a parsed, validated body or a list of errors. It is
 * generic on the body type: on success, `r.body` is typed as whatever
 * you declared, which is the payoff over calling `validateRequest` and
 * casting afterwards.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/fetch-handler.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";
import type { ValidationError } from "../packages/core/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/petstore.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });
const validator = createValidator(document);

interface Pet {
  name: string;
  tag?: string;
}

/** RFC 9457 problem+json, the same shape the framework adapters render. */
function problemResponse(errors: ValidationError[]): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      errors: errors.map((e) => ({ code: e.code, path: e.path, message: e.message })),
    }),
    { status: 400, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * Drop this body into a Next.js `route.ts` unchanged; the signature is
 * the platform's, not ours.
 */
async function POST(request: Request): Promise<Response> {
  const r = await validator.validateFetchRequest<Pet>(request);
  if (!r.ok) return problemResponse(r.errors);

  // `r.body` is `Pet` here, already parsed and validated.
  return Response.json({ created: r.body.name }, { status: 201 });
}

const url = "https://example.test/pets";
const json = { "content-type": "application/json" };

const ok = await POST(new Request(url, { method: "POST", headers: json, body: '{"name":"Fido"}' }));
console.log("valid   ->", ok.status, await ok.text());

const bad = await POST(new Request(url, { method: "POST", headers: json, body: '{"tag":"dog"}' }));
console.log("invalid ->", bad.status, await bad.text());

// The response side pairs with it: useful when you call an upstream API
// and want to know whether *it* honored the contract.
const res = await POST(new Request(url, { method: "POST", headers: json, body: '{"name":"Rex"}' }));
const checked = await validator.validateFetchResponse(
  new Request(url, { method: "POST", headers: json }),
  res,
);
console.log("response conforms ->", checked.ok ? "ok" : "FAIL");
