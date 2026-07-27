import type { FastifyRequest } from "fastify";
import type { HttpRequest } from "@oaverify/internal-core";

/**
 * Convert a Fastify `FastifyRequest` to oav's framework-agnostic
 * {@link HttpRequest} shape. Read what's already on the request;
 * do not touch the body parser or any async source; bodies are
 * assumed already-parsed by Fastify's content-type parsers
 * (which run before `preValidation`).
 *
 * Header keys are already lowercased by Fastify (per HTTP spec); we
 * pass them through. The path is extracted from `request.url` (which
 * includes the query string); query string is dropped from the
 * `path` field and routed to `query` separately.
 *
 * Cookies are read from `request.cookies` if `@fastify/cookie` has
 * populated them, otherwise omitted.
 *
 * Pairs with sibling `httpRequestFromExpress` in `oav-express4` /
 * `oav-express5`: same name pattern as oav's existing
 * {@link httpRequestFromFetch}. The Fetch variant alone is async and
 * returns `{ httpRequest, body }` (it has to read the body stream);
 * the framework variants, this one included, are sync and return a
 * bare `HttpRequest`.
 *
 * @public
 */
export function httpRequestFromFastify(request: FastifyRequest): HttpRequest {
  // request.url is /path?query; extract pathname.
  const url = new URL(request.url, "http://localhost");
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[key.toLowerCase()] = value;
  }

  const result: HttpRequest = {
    method: request.method.toUpperCase(),
    path: url.pathname,
    headers,
  };

  // Fastify parses query into an object; surface it directly.
  const query = request.query as Record<string, string | string[]> | undefined;
  if (query !== undefined && Object.keys(query).length > 0) result.query = query;

  const contentType = request.headers["content-type"];
  if (typeof contentType === "string") result.contentType = contentType;
  if (request.body !== undefined) result.body = request.body;

  // @fastify/cookie populates request.cookies; absent otherwise.
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  if (cookies !== undefined) result.cookies = cookies;
  return result;
}
