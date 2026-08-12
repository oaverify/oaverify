import type { Request, RequestHandler } from "express";
import { collectLeaves, type HttpRequest, type ValidationError } from "@oaverify/internal-core";
import type { TreeValidator, Validator } from "@oaverify/internal-validator";
import { httpRequestFromExpress } from "./extract.js";
import { renderProblemDetails } from "./render.js";
import type { ErrorHandler, ExpressContext } from "./types.js";

/**
 * Options for {@link validateRequests}. The same option shape is
 * used by every adapter in the family (`@oaverify/express5`,
 * `@oaverify/fastify`); only the framework-typed argument differs.
 *
 * @public
 */
export interface ValidateRequestsOptions {
  /**
   * Custom extractor from the Express request to oaverify's
   * {@link HttpRequest} shape. Default: {@link httpRequestFromExpress}.
   * Override when your stack populates non-standard fields the
   * validator needs (e.g. a proxy that puts the verified body on
   * `req.verifiedBody`).
   */
  toHttpRequest?: (req: Request) => HttpRequest;
  /**
   * Called when {@link Validator.validateRequest} returns an error.
   * Default: {@link renderProblemDetails}, which writes an RFC 9457
   * `application/problem+json` response with status from
   * {@link httpStatusFor}.
   *
   * Pass your own to render a custom envelope, map to a different
   * status, or call `ctx.next(err)` to delegate to the host's error
   * middleware. May be async; the middleware handles the returned
   * promise rather than awaiting it, so completion is not waited on.
   * Thrown errors and rejected promises forward via `next(err)`.
   *
   * The middleware does not call `next()` after `onError` returns;
   * the callback owns the response.
   */
  onError?: ErrorHandler<ExpressContext>;
}

/**
 * Build an Express 4 request-handler that runs every request through
 * a {@link Validator} and either calls `next()` (valid) or invokes
 * the configured `onError` (invalid). The default `onError` writes
 * an RFC 9457 problem-details response.
 *
 * Plural (`validateRequests`, not `validateRequest`) because the
 * middleware intercepts every request; the singular form is the
 * Validator's own per-call method.
 *
 * Express 4 is sync at the framework level: thrown exceptions and
 * rejected promises don't auto-propagate to the error handler. The
 * middleware forwards both via `next(err)` so the host app's error
 * middleware sees them.
 *
 * Same factory shape across the sibling `@oaverify/express5` /
 * `@oaverify/fastify` adapters.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { validateRequests } from "@oaverify/express4";
 *
 * const app = express();
 * app.use(express.json());
 * app.use(validateRequests(validator));
 * ```
 *
 * @public
 */
export function validateRequests(
  validator: Validator | TreeValidator,
  options: ValidateRequestsOptions = {},
): RequestHandler {
  // A predicate validator returns a bare boolean, so there are no errors
  // to render. Fail loudly at construction rather than emitting empty 400s.
  if (validator.output === "predicate") {
    throw new Error(
      'validateRequests: a predicate-mode validator (output: "predicate") cannot render ' +
        'problem-details responses. Build the validator with output: "flat" (default) or "tree".',
    );
  }
  const toHttpRequest = options.toHttpRequest ?? httpRequestFromExpress;
  const onError = options.onError ?? renderProblemDetails;

  return (req, res, next) => {
    let httpReq;
    try {
      httpReq = toHttpRequest(req);
    } catch (e) {
      next(e);
      return;
    }
    const result = validator.validateRequest(httpReq);
    if (result.valid) {
      next();
      return;
    }
    const errors: ValidationError[] =
      "errors" in result ? result.errors : collectLeaves(result.error);
    // onError may be sync or async. The middleware does not await it
    // (Express 4 middleware returns synchronously); the returned
    // promise is handled only so a rejection forwards to next(err)
    // and the host's error middleware sees it.
    Promise.resolve(onError(errors, { req, res, next })).catch(next);
  };
}
