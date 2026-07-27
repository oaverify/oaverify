import type { Request } from "express";
import type { HttpRequest } from "@oaverify/internal-core";

/**
 * Convert an Express 4 `Request` to oaverify's framework-agnostic
 * {@link HttpRequest} shape. Read what's already on `req`; do not
 * touch the body parser or any async source; bodies are assumed
 * already-parsed by `express.json()` (or equivalent) upstream of
 * the validator middleware.
 *
 * Header keys are lowercased to match oaverify's convention. The path is
 * `req.path` (no query string). `Content-Type` is parsed off the
 * `content-type` header (charset and boundary preserved verbatim;
 * the validator strips them itself).
 *
 * Cookies are read from `req.cookies` if `cookie-parser` populated
 * them, otherwise omitted.
 *
 * Pairs with sibling `httpRequestFromExpress` in `@oaverify/express5` and
 * `httpRequestFromFastify` in `@oaverify/fastify`: same name pattern as
 * oaverify's existing {@link httpRequestFromFetch}. The Fetch variant
 * alone is async and returns `{ httpRequest, body }` (it has to read
 * the body stream); the framework variants, this one included, are
 * sync and return a bare `HttpRequest`.
 *
 * @public
 */
export function httpRequestFromExpress(req: Request): HttpRequest {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[key.toLowerCase()] = value;
  }

  // express's Request typing widens query/body to any; carry through
  // as-is and let the validator narrow.
  const query = req.query as Record<string, string | string[]> | undefined;

  const result: HttpRequest = {
    method: req.method.toUpperCase(),
    path: req.path,
    headers,
  };
  if (query !== undefined) result.query = query;
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") result.contentType = contentType;
  if (req.body !== undefined) result.body = req.body;
  // cookie-parser populates req.cookies; absent otherwise.
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (cookies !== undefined) result.cookies = cookies;
  return result;
}
