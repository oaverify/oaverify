import type { FastifyRequest, preValidationAsyncHookHandler } from "fastify";
import { collectLeaves, type HttpRequest, type ValidationError } from "@oaverify/internal-core";
import type { TreeValidator, Validator } from "@oaverify/internal-validator";
import { httpRequestFromFastify } from "./extract.js";
import { markRequestRefused, unmarkRequestRefused } from "./request-marks.js";
import { renderProblemDetails } from "./render.js";
import type { ErrorHandler, FastifyContext } from "./types.js";

/**
 * Options for {@link validateRequests}. The same option shape is
 * used by every adapter in the family (`@oaverify/express4`,
 * `@oaverify/express5`); only the framework-typed argument differs.
 *
 * @public
 */
export interface ValidateRequestsOptions {
  /**
   * Custom extractor from the Fastify request to oaverify's
   * {@link HttpRequest} shape. Default: {@link httpRequestFromFastify}.
   * Override when your stack populates non-standard fields the
   * validator needs (e.g. a proxy that puts the verified body on
   * `request.verifiedBody`).
   */
  toHttpRequest?: (request: FastifyRequest) => HttpRequest;
  /**
   * Called when {@link Validator.validateRequest} returns an error.
   * Default: {@link renderProblemDetails}, which writes an RFC 9457
   * `application/problem+json` response with status from
   * {@link httpStatusFor}.
   *
   * Pass your own to render a custom envelope, map to a different
   * status, or throw to delegate to Fastify's error handler. May be
   * async; the hook awaits it. Thrown errors and rejected promises
   * propagate to Fastify's error handler automatically (no try/catch
   * wrapper needed).
   *
   * The hook does not call `reply.send()` after `onError` returns;
   * the callback owns the response.
   */
  onError?: ErrorHandler<FastifyContext>;
}

/**
 * Build a Fastify `preValidation` hook that runs every request
 * through a {@link Validator} and either resolves (valid) or
 * invokes the configured `onError` (invalid). The default
 * `onError` writes an RFC 9457 problem-details response.
 *
 * Plural (`validateRequests`, not `validateRequest`) because the
 * hook intercepts every request; the singular form is the
 * Validator's own per-call method.
 *
 * Mount on `preValidation` so it runs after Fastify's content-type
 * parsers (which populate `request.body`) but before route
 * handlers and Fastify's own per-route schema validation (which
 * runs in the `validation` step). Both can coexist; Fastify's own
 * per-route schemas run after this hook; oaverify's failures are
 * surfaced first.
 *
 * Pairs with sibling `validateRequests` in `@oaverify/express4` /
 * `@oaverify/express5`. Same factory shape across the family; only the
 * returned framework-native handler differs.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { validateRequests } from "@oaverify/fastify";
 *
 * const app = Fastify();
 * app.addHook("preValidation", validateRequests(validator));
 * ```
 *
 * @public
 */
export function validateRequests(
  validator: Validator | TreeValidator,
  options: ValidateRequestsOptions = {},
): preValidationAsyncHookHandler {
  // A predicate validator returns a bare boolean, so there are no errors
  // to render. Fail loudly at construction rather than emitting empty 400s.
  if (validator.output === "predicate") {
    throw new Error(
      'validateRequests: a predicate-mode validator (output: "predicate") cannot render ' +
        'problem-details responses. Build the validator with output: "flat" (default) or "tree".',
    );
  }
  const toHttpRequest = options.toHttpRequest ?? httpRequestFromFastify;
  const onError = options.onError ?? renderProblemDetails;

  return async (request, reply) => {
    const httpReq = toHttpRequest(request);
    const result = validator.validateRequest(httpReq);
    if (result.valid) return;
    const errors: ValidationError[] =
      "errors" in result ? result.errors : collectLeaves(result.error);
    // The refusal window. `onSend` runs inside `reply.send()`, so if
    // `onError` sends, the response hook has already run by the time
    // this returns; the mark has to be up before the call, not after.
    markRequestRefused(request);
    // Fastify awaits the returned promise; thrown errors / rejected
    // promises propagate to Fastify's error handler. The hook
    // returns once onError settles; Fastify treats a sent reply
    // as "we handled it, skip the route handler."
    await onError(errors, { request, reply });
    // A report-only `onError` records and returns without sending, and
    // the route handler runs after all. Its response is ordinary
    // handler output, so the window closes here. A throwing `onError`
    // never reaches this line, which is right: the error reply Fastify
    // renders for it is still the refusal's, not a handler's.
    if (!reply.sent) unmarkRequestRefused(request);
  };
}
