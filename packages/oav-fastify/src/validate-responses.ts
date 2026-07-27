import type { FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";
import {
  collectLeaves,
  type HttpRequest,
  type HttpResponse,
  type ValidationError,
} from "@oaverify/internal-core";
import type { TreeValidator, Validator } from "@oaverify/internal-validator";
import { httpRequestFromFastify } from "./extract.js";
import { ResponseValidationError } from "./response-error.js";
import type { ErrorHandler, FastifyContext } from "./types.js";

/**
 * Options for {@link validateResponses}. The same option shape is used
 * by every adapter in the family (`oav-express4`, `oav-express5`); only
 * the framework-typed argument differs.
 *
 * @public
 */
export interface ValidateResponsesOptions {
  /**
   * Custom extractor from the Fastify request to oav's
   * {@link HttpRequest} shape, used only to match the operation the
   * response answers (method + path). Default:
   * {@link httpRequestFromFastify}.
   */
  toHttpRequest?: (request: FastifyRequest) => HttpRequest;
  /**
   * Predicate gating which response statuses are validated. Return
   * `true` to validate, `false` to pass the response through untouched.
   * Default: validate every status. Use it to scope validation (e.g.
   * `(s) => s < 500` to skip server-error pages, or `(s) => s < 300` for
   * success-only). A response whose status the spec doesn't declare is a
   * finding (the validator emits a `status` leaf); narrow this predicate
   * to ignore statuses you don't want checked.
   */
  statuses?: (status: number) => boolean;
  /**
   * Called when {@link Validator.validateResponse} returns an error.
   * Default: throw a {@link ResponseValidationError}, which Fastify
   * routes to its error handler (a failing response is a server bug, so
   * it surfaces as a 500 rather than being rendered here).
   *
   * Pass your own to log-and-continue, or throw a custom error for
   * Fastify's handler to render. May be async; the hook awaits it.
   * Returning normally lets the original (invalid) payload go out, so a
   * handler that wants to suppress the response must throw.
   */
  onError?: ErrorHandler<FastifyContext>;
}

const defaultOnError: ErrorHandler<FastifyContext> = (errors) => {
  throw new ResponseValidationError(errors);
};

// reply.getHeaders() reports numeric values (Content-Length, or any
// reply.header(name, number)) as numbers; the validator's header
// deserializer expects strings.
function responseHeaders(reply: FastifyReply): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value : String(value);
  }
  return headers;
}

// Marks a request whose response has already been validated, so the
// error reply Fastify renders after a throwing onError is not itself
// re-validated into a loop.
const VALIDATED = Symbol("oav.responseValidated");

/**
 * Build a Fastify `onSend` hook that validates every outgoing response
 * against the spec. Unlike the Express adapters it wraps nothing: the
 * `onSend` hook receives the serialized payload natively, so the core
 * `validateResponse` stays a pure function and no response method is
 * monkey-patched.
 *
 * Opt-in and explicit: register it only where you want response
 * checking (typically on in development, off in production). On failure
 * the configured `onError` runs (default: throw a
 * {@link ResponseValidationError} to Fastify's error handler as a 500).
 *
 * Response status and declared headers are checked for every reply,
 * regardless of media type: a 204, a redirect, or a text error page
 * still has a status the spec may not declare and headers it may
 * require. The body is validated only when the payload is a parseable
 * JSON string; non-JSON, unparseable, buffer, and stream payloads pass
 * their bodies through untouched (status and headers still checked). A
 * per-request guard means the error handler's own response (rendered in
 * reaction to a failure) is not re-validated, so there is no loop.
 *
 * @example
 * ```ts
 * import { validateRequests, validateResponses } from "@oaverify/fastify";
 *
 * app.addHook("preValidation", validateRequests(validator));
 * if (process.env.NODE_ENV !== "production") {
 *   app.addHook("onSend", validateResponses(validator));
 * }
 * ```
 *
 * @public
 */
export function validateResponses(
  validator: Validator | TreeValidator,
  options: ValidateResponsesOptions = {},
): onSendHookHandler {
  if (validator.output === "predicate") {
    throw new Error(
      'validateResponses: a predicate-mode validator (output: "predicate") cannot report which ' +
        'response fields failed. Build the validator with output: "flat" (default) or "tree".',
    );
  }
  const toHttpRequest = options.toHttpRequest ?? httpRequestFromFastify;
  const shouldValidate = options.statuses ?? (() => true);
  const onError = options.onError ?? defaultOnError;

  return async (request, reply, payload) => {
    const marker = request as FastifyRequest & { [VALIDATED]?: boolean };
    if (marker[VALIDATED] === true) return payload;
    marker[VALIDATED] = true;

    if (!shouldValidate(reply.statusCode)) return payload;

    const contentType = String(reply.getHeader("content-type") ?? "");
    // Split-phase. Status and declared headers are checked for every
    // response: a 204, a redirect, or a text error page still has a status
    // the spec may not declare and headers it may require, none of which
    // depend on the body's media type. The body is parsed and validated
    // only when it is a parseable JSON string; for non-JSON, unparseable,
    // buffer, or stream payloads `body` stays undefined and the core
    // validator skips body validation (and the response Content-Type
    // check, which is gated on a present body).
    let body: unknown;
    if (typeof payload === "string" && /\bjson\b/i.test(contentType)) {
      try {
        body = JSON.parse(payload);
      } catch {
        // Unparseable JSON: leave body undefined; status/headers still get
        // checked, and the malformed body is sent through unchanged.
      }
    }

    const httpReq = toHttpRequest(request);
    const httpRes: HttpResponse = {
      status: reply.statusCode,
      contentType,
      headers: responseHeaders(reply),
      body,
    };
    const result = validator.validateResponse(httpReq, httpRes);
    if (result.valid) return payload;
    const errors: ValidationError[] =
      "errors" in result ? result.errors : collectLeaves(result.error);
    // Fastify awaits the hook; a throwing onError propagates to the
    // error handler. If onError returns without throwing, the original
    // payload is sent unchanged.
    await onError(errors, { request, reply });
    return payload;
  };
}
