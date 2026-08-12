/**
 * Example: per-scheme auth dispatch driven by the spec's `security:`
 * declaration.
 *
 * oaverify's `validateSecurity` modes check only credential shape;
 * verifying credentials is the application's job. This recipe keeps
 * that job declarative: it walks the matched operation's security
 * requirements via `validator.getOperation` and fans out to one
 * handler per scheme name. OpenAPI semantics apply: each requirement
 * object is AND across its scheme keys, the outer array is OR across
 * requirements, and the first requirement that fully passes wins.
 *
 * Mount the dispatcher as middleware before `validateRequests` (or
 * your inline validator middleware) and reject (401 / 403 per your
 * policy) on `{ ok: false }` before validation runs. The validator's
 * own shape check is then redundant; leave `validateSecurity` at its
 * default `"off"`. The same dispatcher works under every adapter;
 * only the request-shape extraction changes
 * (`httpRequestFromExpress`, `httpRequestFromFastify`).
 *
 * This file is documentation, not library API. Copy it into your
 * project and replace the handlers with your real verifiers.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/security-dispatch.ts
 */

import { fileURLToPath } from "node:url";
import type { HttpRequest, SecurityRequirementObject } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator, type Validator } from "../packages/validator/src/index.ts";

type DispatchResult = { ok: true; user?: unknown } | { ok: false; reason: string };

/** One verifier per scheme name declared in `components.securitySchemes`. */
export type SchemeHandler = (req: HttpRequest, scopes: string[]) => Promise<DispatchResult>;

export function createSecurityDispatcher(
  validator: Validator,
  documentSecurity: SecurityRequirementObject[] | undefined,
  handlers: Record<string, SchemeHandler>,
): (req: HttpRequest) => Promise<DispatchResult> {
  return async (req) => {
    const op = validator.getOperation({ method: req.method, path: req.path });
    // Fall back to document-level security when the operation omits it.
    const requirements = op?.operation.security ?? documentSecurity ?? [];
    if (requirements.length === 0) return { ok: true };
    for (const requirement of requirements) {
      let allPass = true;
      let lastUser: unknown;
      for (const [scheme, scopes] of Object.entries(requirement)) {
        const handler = handlers[scheme];
        if (handler === undefined) {
          allPass = false;
          break;
        }
        const result = await handler(req, scopes);
        if (!result.ok) {
          allPass = false;
          break;
        }
        lastUser = result.user;
      }
      if (allPass) return { ok: true, user: lastUser };
    }
    return { ok: false, reason: "no security requirement satisfied" };
  };
}

// ---- Demo: dispatch two requests against specs/uploads.yaml ------

function bearerToken(req: HttpRequest): string | undefined {
  const raw = req.headers?.["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const specPath = fileURLToPath(new URL("./specs/uploads.yaml", import.meta.url));
  const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });
  const validator = createValidator(document);

  const dispatch = createSecurityDispatcher(validator, document.security, {
    // Stand-in for a real verifier (JWT library, API-key lookup, ...).
    bearerAuth: async (req) =>
      bearerToken(req) === "secret-token"
        ? { ok: true, user: { name: "demo" } }
        : { ok: false, reason: "bad or missing bearer token" },
  });

  const base: HttpRequest = { method: "POST", path: "/uploads" };
  console.log(
    "with token:   ",
    await dispatch({ ...base, headers: { authorization: "Bearer secret-token" } }),
  );
  console.log("without token:", await dispatch(base));
}
