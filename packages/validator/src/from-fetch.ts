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
import { getOwn, markLowercaseKeys, setSpecKey } from "@oaverify/internal-core";

/**
 * The default {@link FetchBodyOptions.maxTotalBytes} cap, 1 MiB.
 *
 * Finite by default, unlike `maxErrors` / `maxDepth` / the stream
 * validator's schema-bound limits. Those bound work the caller's own
 * schema asks for; this one bounds a buffer the reader introduces by
 * draining a socket into a string, which is the category
 * `@oaverify/stream` already defaults finite
 * (`maxMemberPrefixBytes`, `maxMemberDropBytes`).
 *
 * @public
 */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Byte-budget options for the Fetch body reader, shared by
 * {@link readBodyFromFetch}, {@link httpRequestFromFetch} and
 * {@link httpResponseFromFetch}.
 *
 * @public
 */
export interface FetchBodyOptions {
  /**
   * Refuse a body larger than this many bytes, before it is read in
   * full. Defaults to {@link DEFAULT_MAX_TOTAL_BYTES} (1 MiB); pass
   * `Number.POSITIVE_INFINITY` for an unbounded read.
   *
   * Enforced at two points. A `Content-Length` over the cap is refused
   * without reading, which saves the read rather than providing the
   * bound: the sender controls that header. The running byte count
   * over the stream is the bound.
   *
   * Over-cap raises {@link FetchBodyTooLargeError} from the extraction
   * helpers, and an error leaf (`body-too-large`, HTTP 413) from
   * `validateFetchRequest` / `validateFetchResponse`.
   *
   * A finite cap reads the body through a counting stream instead of
   * the platform's native `text()` / `formData()` fast path. An
   * infinite cap skips the instrumentation entirely.
   *
   * Same option name and meaning as `@oaverify/stream`'s
   * `StreamValidatorOptions.maxTotalBytes`. Must be a positive integer
   * or `Number.POSITIVE_INFINITY`.
   */
  maxTotalBytes?: number;
}

/**
 * Options shared by the `validateFetchRequest` family and
 * {@link httpRequestFromFetch}: the `readBody` override, plus the
 * inherited byte budget.
 *
 * @public
 */
export interface FetchRequestOptions extends FetchBodyOptions {
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
 * Thrown by the default body reader when a payload does not parse as
 * the media type it declares: JSON that fails `JSON.parse`, multipart
 * that `formData()` rejects. The body is attacker-controlled, so
 * `validateFetchRequest` / `validateFetchResponse` catch this and
 * return an invalid result with a `body` leaf error instead of letting
 * the exception escape.
 *
 * A custom {@link FetchRequestOptions.readBody} can throw this to opt
 * into the same conversion; any other error it throws propagates
 * unchanged, since an IO failure is not a validation verdict.
 *
 * @public
 */
export class FetchBodyParseError extends Error {
  /** The declared media type the payload failed to parse as. */
  readonly mediaType: string;

  constructor(mediaType: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`body could not be parsed as ${mediaType}: ${detail}`, { cause });
    this.name = "FetchBodyParseError";
    this.mediaType = mediaType;
  }
}

/**
 * Thrown by the default body reader when a payload exceeds the
 * configured {@link FetchBodyOptions.maxTotalBytes}. Like
 * {@link FetchBodyParseError}, the body is attacker-controlled, so
 * `validateFetchRequest` / `validateFetchResponse` catch this and
 * return an invalid result with a `body-too-large` leaf instead of
 * letting the exception escape.
 *
 * Named for the condition, following its sibling above.
 * `@oaverify/stream` exports a `MaxTotalBytesError` for the same cap
 * on a different engine; the names are deliberately distinct so a
 * consumer importing both packages has two catchable classes rather
 * than one ambiguous one.
 *
 * @public
 */
export class FetchBodyTooLargeError extends Error {
  /** The `maxTotalBytes` cap that was exceeded. */
  readonly limit: number;
  /**
   * Which enforcement point fired. `"declared"` means the refusal came
   * from the `Content-Length` header, before any read; `"read"` means
   * the running count over the stream passed the cap.
   */
  readonly reason: "declared" | "read";
  /**
   * The byte count, read under {@link FetchBodyTooLargeError.reason}:
   * a length the sender claimed, or one this reader observed. The two
   * are not interchangeable, which is why the reason travels with it.
   */
  readonly bytes: number;

  constructor(limit: number, reason: "declared" | "read", bytes: number) {
    super(`body exceeded maxTotalBytes=${limit} (${reason} ${bytes} bytes)`);
    this.name = "FetchBodyTooLargeError";
    this.limit = limit;
    this.reason = reason;
    this.bytes = bytes;
  }
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
  // A custom `readBody` gets the untouched `Request` and so owns its
  // own byte budget; `maxTotalBytes` bounds the default reader only.
  // Wrapping the argument would silently change the object a caller
  // asked to receive intact.
  const body =
    options?.readBody !== undefined
      ? await options.readBody(request)
      : await readBody(request, contentType, method, options?.maxTotalBytes);

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
 * Applies {@link FetchBodyOptions.maxTotalBytes} (default 1 MiB),
 * raising {@link FetchBodyTooLargeError} over the cap. This is the
 * delegation target documented on
 * {@link FetchRequestOptions.readBody}, so a custom reader that
 * forwards here inherits the bound for the content types it forwards.
 *
 * @public
 */
export async function readBodyFromFetch(
  request: Request,
  options?: FetchBodyOptions,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? undefined;
  const method = request.method.toUpperCase();
  return readBody(request, contentType, method, options?.maxTotalBytes);
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
 * Takes {@link FetchBodyOptions} rather than
 * {@link FetchRequestOptions}: the byte budget applies to an upstream
 * response as much as to a request, while the `readBody` override has
 * no response-side counterpart to override.
 *
 * @public
 */
export async function httpResponseFromFetch(
  response: Response,
  options?: FetchBodyOptions,
): Promise<{
  httpResponse: HttpResponse;
  body: unknown;
}> {
  const headers = headersToRecord(response.headers);
  const contentType = response.headers.get("content-type") ?? undefined;
  // Response body parsing: reuse the same media-type dispatch as
  // requests. Method is irrelevant; there's no GET/HEAD skip; a
  // spec-declared response body is readable regardless.
  const body = await readBody(response, contentType, "POST", options?.maxTotalBytes);

  const httpResponse: HttpResponse = {
    status: response.status,
    headers,
    ...(contentType !== undefined && { contentType }),
    ...(body !== undefined && { body }),
  };
  return { httpResponse, body };
}

function headersToRecord(h: Headers): Record<string, string | string[]> {
  // Every key below is lowercased, which earns the mark: header
  // lookups skip their case-insensitive fallback scan on a miss.
  const out = markLowercaseKeys<Record<string, string | string[]>>({});
  for (const [key, value] of h.entries()) {
    const lower = key.toLowerCase();
    // Own-property read and write: a request header literally named
    // "constructor" would otherwise read the inherited function as a
    // prior value and produce [Function, value].
    const prior = getOwn(out, lower);
    if (prior === undefined) {
      setSpecKey(out, lower, value);
    } else if (Array.isArray(prior)) {
      prior.push(value);
    } else {
      setSpecKey(out, lower, [prior, value]);
    }
  }
  return out;
}

function objectFromSearchParams(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    setSpecKey(out, key, values.length === 1 ? (values[0] ?? "") : values);
  }
  return out;
}

/**
 * The `Content-Length` the sender declared, when it is a usable
 * number. A missing or malformed header yields `undefined` rather than
 * a rejection: this pre-check exists to avoid a read it can already
 * rule out, and the streamed count is what actually bounds the body.
 * Refusing on an unparseable header would reject a request the real
 * bound would have accepted.
 */
function declaredLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Re-wrap a message's body stream so bytes are counted as they pass,
 * erroring the stream once the running total exceeds `limit`.
 *
 * The result is always a `Response`, whatever came in: the media-type
 * dispatch below uses only `text()` / `formData()` / `arrayBuffer()`,
 * all of which a `Response` provides, and `formData()` needs the
 * content-type header carried across to parse the multipart boundary.
 *
 * `over` records the count at the moment the cap was passed, and the
 * caller reads that field rather than the error the dispatch throws.
 * On Node 22 the stream error does reach the caller with its identity
 * intact, including out of `formData()`, so an `instanceof` check
 * would work there. It is a bet on every runtime's multipart parser
 * re-raising rather than replacing, which is not something this
 * package tests or controls, and the field costs one assignment.
 *
 * Returns `undefined` for a message with no body stream, which has
 * nothing to count and is left alone.
 */
function countingBody(
  message: Request | Response,
  limit: number,
): { counted: Response; state: { over?: number } } | undefined {
  const source = message.body;
  if (source === null) return undefined;
  const state: { over?: number } = {};
  let seen = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        // Chunk-granular, so the peak is `limit` plus at most one
        // chunk. Erroring here cancels the source, so the read stops.
        state.over = seen;
        controller.error(new FetchBodyTooLargeError(limit, "read", seen));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  const headers = new Headers();
  const contentType = message.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return { counted: new Response(source.pipeThrough(counter), { headers }), state };
}

async function readBody(
  message: Request | Response,
  contentType: string | undefined,
  method: string,
  maxTotalBytes: number | undefined,
): Promise<unknown> {
  // HTTP/1.1 §4.3: bodies on GET / HEAD have no defined semantics.
  // Some clients still attach one; the OpenAPI spec never declares one,
  // so skipping the read matches the `requestBody === undefined` path
  // through validateRequest. Called with method "POST" for responses
  // so this branch is only reached on real bodyless requests.
  if (method === "GET" || method === "HEAD") return undefined;

  const limit = maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  // An infinite cap skips the instrumentation entirely, leaving the
  // platform's native `text()` / `formData()` on the original message.
  if (!Number.isFinite(limit)) return dispatchBody(message, contentType);

  const declared = declaredLength(message.headers);
  if (declared !== undefined && declared > limit) {
    throw new FetchBodyTooLargeError(limit, "declared", declared);
  }

  const counting = countingBody(message, limit);
  if (counting === undefined) return dispatchBody(message, contentType);

  // The cap is interpreted once, here, above the media-type dispatch.
  // Per-branch handling would have to be re-derived by whoever adds
  // the next branch that reads and parses in one call.
  //
  // Size takes precedence over malformedness: the read stopped early,
  // so there is not enough of the payload to support a claim about its
  // syntax. That matters most for multipart, where `formData()` reads
  // and parses in one call and the branch below wraps everything it
  // throws in a `FetchBodyParseError`. Without this, a well-formed
  // upload over the cap would answer 400 "malformed", the client's 413
  // handling would never run, and it would retry the same body.
  let parsed: unknown;
  try {
    parsed = await dispatchBody(counting.counted, contentType);
  } catch (err) {
    if (counting.state.over !== undefined) {
      throw new FetchBodyTooLargeError(limit, "read", counting.state.over);
    }
    throw err;
  }
  // Also checked on the success path, for a parser that swallowed the
  // stream error and resolved with what it had: returning a truncated
  // body as though it were whole is the one outcome worse than either
  // error.
  if (counting.state.over !== undefined) {
    throw new FetchBodyTooLargeError(limit, "read", counting.state.over);
  }
  return parsed;
}

async function dispatchBody(
  message: Request | Response,
  contentType: string | undefined,
): Promise<unknown> {
  if (contentType === undefined) {
    const text = await message.text();
    return text === "" ? undefined : text;
  }
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const text = await message.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new FetchBodyParseError(mediaType, err);
    }
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    const raw = await message.text();
    if (raw === "") return undefined;
    return objectFromSearchParams(new URLSearchParams(raw));
  }
  if (mediaType === "multipart/form-data") {
    let formData: FormData;
    try {
      formData = await message.formData();
    } catch (err) {
      throw new FetchBodyParseError(mediaType, err);
    }
    const out: Record<string, unknown> = {};
    for (const name of new Set(formData.keys())) {
      const values = formData.getAll(name);
      const resolved = await Promise.all(
        values.map(async (v) => (v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : v)),
      );
      setSpecKey(out, name, resolved.length === 1 ? resolved[0] : resolved);
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
