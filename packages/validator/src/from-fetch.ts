/**
 * Bridge between Web Standards {@link Request} / {@link Response}
 * objects and the validator's framework-agnostic
 * {@link HttpRequest} / {@link HttpResponse} shapes. Used by
 * `validateFetchRequest` / `validateFetchResponse` to support
 * route-level handlers in Next.js App Router, Hono, Bun, Deno, and
 * any other runtime whose HTTP primitives are `Request` / `Response`.
 *
 * The content-type dispatcher recognizes JSON (`application/json` and
 * `*+json`), URL-encoded forms, multipart/form-data, and text/*. For
 * anything else, the raw bytes come through as a `Uint8Array`; the
 * validator's `format: "binary"` opaque-body bypass accepts any value
 * when the body schema declares it that way.
 *
 * @packageDocumentation
 */

import type { HttpRequest, HttpResponse } from "@oaverify/internal-core";

/**
 * Options shared by the `validateFetchRequest` family and
 * {@link httpRequestFromFetch}. Currently just the `readBody`
 * override.
 *
 * @public
 */
export interface FetchRequestOptions {
  /**
   * Replace the default body reader with a user-supplied function.
   * Useful for streaming large uploads to disk without buffering, for
   * plugging in a streaming multipart parser (busboy, formidable,
   * `@mjackson/multipart-parser`), or for handling a content type the
   * default dispatcher doesn't know about.
   *
   * The callback receives the original `Request` with its body stream
   * intact. Return whatever shape the spec's `requestBody` schema
   * expects; `format: "binary"` fields pass through the validator
   * unchanged, so opaque placeholders (a temp-file path, a Buffer
   * handle, etc.) are valid.
   *
   * If you want default behavior for most content types and custom
   * behavior for one or two, import {@link readBodyFromFetch} and
   * delegate to it from inside your callback.
   *
   * @example
   * ```ts
   * await validator.validateFetchRequest(request, {
   *   readBody: async (req) => {
   *     if (req.headers.get("content-type")?.startsWith("multipart/")) {
   *       const fields = await streamMultipartToDisk(req); // your parser
   *       return { file: fields.file.path, caption: fields.caption };
   *     }
   *     return readBodyFromFetch(req);
   *   },
   * });
   * ```
   */
  readBody?: (request: Request) => Promise<unknown>;
}

/**
 * Read and parse a Web Standards `Request` into the
 * framework-agnostic {@link HttpRequest} shape the validator expects,
 * plus the parsed body for the caller to consume.
 *
 * The request body is a one-shot stream; after this helper returns,
 * `request.body` is exhausted. Callers that need to re-read the body
 * should use `request.clone()` before calling.
 *
 * Shape note: this is the one `httpRequestFrom*` extractor that is
 * async and returns `{ httpRequest, body }` (reading the stream is
 * async, and the parsed body is surfaced for the caller to consume).
 * The framework siblings (`httpRequestFromExpress`,
 * `httpRequestFromFastify`) read an already-parsed body and so are
 * sync, returning a bare `HttpRequest`.
 *
 * @public
 */
export async function httpRequestFromFetch(
  request: Request,
  options?: FetchRequestOptions,
): Promise<{
  httpRequest: HttpRequest;
  body: unknown;
}> {
  const url = new URL(request.url);
  const headers = headersToRecord(request.headers);
  const contentType = request.headers.get("content-type") ?? undefined;
  const query = objectFromSearchParams(url.searchParams);
  const method = request.method.toUpperCase();
  const body =
    options?.readBody !== undefined
      ? await options.readBody(request)
      : await readBody(request, contentType, method);

  const httpRequest: HttpRequest = {
    method,
    path: url.pathname,
    query,
    headers,
    ...(contentType !== undefined && { contentType }),
    ...(body !== undefined && { body }),
  };
  return { httpRequest, body };
}

/**
 * The default content-type-driven body reader exposed for composition.
 * Call this from inside a {@link FetchRequestOptions.readBody} callback
 * when you want to handle some content types yourself and delegate the
 * rest to the built-in behavior. Recognizes JSON, `*+json`,
 * URL-encoded forms, `multipart/form-data`, and `text/*`; anything
 * else comes through as a `Uint8Array`.
 *
 * Consumes `request.body`. GET / HEAD requests return `undefined`
 * without reading.
 *
 * @public
 */
export async function readBodyFromFetch(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? undefined;
  const method = request.method.toUpperCase();
  return readBody(request, contentType, method);
}

/**
 * Read and parse a Web Standards `Response` into the
 * framework-agnostic {@link HttpResponse} shape, plus the parsed
 * body. Mirrors {@link httpRequestFromFetch}; same content-type
 * dispatch rules, same one-shot-stream warning.
 *
 * The only `httpResponseFrom*` extractor, by design: the framework
 * adapters intercept responses inside `validateResponses` (a
 * `res.send` wrap on Express, an `onSend` hook on Fastify), so a
 * standalone response extractor exists only where responses arrive
 * as first-class values, the Fetch world.
 *
 * @public
 */
export async function httpResponseFromFetch(response: Response): Promise<{
  httpResponse: HttpResponse;
  body: unknown;
}> {
  const headers = headersToRecord(response.headers);
  const contentType = response.headers.get("content-type") ?? undefined;
  // Response body parsing: reuse the same media-type dispatch as
  // requests. Method is irrelevant; there's no GET/HEAD skip; a
  // spec-declared response body is readable regardless.
  const body = await readBody(response, contentType, "POST");

  const httpResponse: HttpResponse = {
    status: response.status,
    headers,
    ...(contentType !== undefined && { contentType }),
    ...(body !== undefined && { body }),
  };
  return { httpResponse, body };
}

function headersToRecord(h: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of h.entries()) {
    const lower = key.toLowerCase();
    const prior = out[lower];
    if (prior === undefined) {
      out[lower] = value;
    } else if (Array.isArray(prior)) {
      prior.push(value);
    } else {
      out[lower] = [prior, value];
    }
  }
  return out;
}

function objectFromSearchParams(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return out;
}

async function readBody(
  message: Request | Response,
  contentType: string | undefined,
  method: string,
): Promise<unknown> {
  // HTTP/1.1 §4.3: bodies on GET / HEAD have no defined semantics.
  // Some clients still attach one; the OpenAPI spec never declares one,
  // so skipping the read matches the `requestBody === undefined` path
  // through validateRequest. Called with method "POST" for responses
  // so this branch is only reached on real bodyless requests.
  if (method === "GET" || method === "HEAD") return undefined;
  if (contentType === undefined) {
    const text = await message.text();
    return text === "" ? undefined : text;
  }
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const text = await message.text();
    if (text === "") return undefined;
    return JSON.parse(text);
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    const raw = await message.text();
    if (raw === "") return undefined;
    return objectFromSearchParams(new URLSearchParams(raw));
  }
  if (mediaType === "multipart/form-data") {
    const formData = await message.formData();
    const out: Record<string, unknown> = {};
    for (const name of new Set(formData.keys())) {
      const values = formData.getAll(name);
      const resolved = await Promise.all(
        values.map(async (v) => (v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : v)),
      );
      out[name] = resolved.length === 1 ? resolved[0] : resolved;
    }
    return out;
  }
  if (mediaType.startsWith("text/")) {
    const text = await message.text();
    return text === "" ? undefined : text;
  }
  // Unknown media type: return raw bytes. Spec-declared `format: "binary"`
  // bodies pass through the body-schema transform's opaque-body bypass;
  // anything else will surface a schema error the caller can act on.
  const buf = await message.arrayBuffer();
  if (buf.byteLength === 0) return undefined;
  return new Uint8Array(buf);
}
