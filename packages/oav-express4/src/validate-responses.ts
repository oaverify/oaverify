import type { Request, RequestHandler, Response } from "express";
import {
  collectLeaves,
  type HttpRequest,
  type HttpResponse,
  type ValidationError,
} from "@oaverify/internal-core";
import type { TreeValidator, Validator } from "@oaverify/internal-validator";
import { httpRequestFromExpress } from "./extract.js";
import { ResponseValidationError } from "./response-error.js";
import type { ErrorHandler, ExpressContext } from "./types.js";

/**
 * Options for {@link validateResponses}. The same option shape is used
 * by every adapter in the family (`@oaverify/express5`, `@oaverify/fastify`); only
 * the framework-typed argument differs.
 *
 * @public
 */
export interface ValidateResponsesOptions {
  /**
   * Custom extractor from the Express request to oaverify's
   * {@link HttpRequest} shape, used only to match the operation the
   * response answers (method + path). Default:
   * {@link httpRequestFromExpress}.
   */
  toHttpRequest?: (req: Request) => HttpRequest;
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
   * Default: throw a {@link ResponseValidationError}, which the adapter
   * forwards to the host's error middleware via `next(err)` (a failing
   * response is a server bug, so it surfaces as a 500 rather than being
   * rendered here).
   *
   * The callback decides what happens next:
   * - **Throw** (the default) to forward to the host error handler.
   * - **Return normally** to let the original (invalid) response body go
   *   out anyway. This is the log-and-continue path: log the finding and
   *   return; the body is sent unchanged.
   * - **Render your own response** (`ctx.res.status(...).json(...)`) and
   *   return; once the response is sent the adapter does not also send
   *   the original.
   *
   * May be async; the original body is sent (or not) after it settles.
   */
  onError?: ErrorHandler<ExpressContext>;
}

const defaultOnError: ErrorHandler<ExpressContext> = (errors) => {
  throw new ResponseValidationError(errors);
};

// Marks a response already wrapped by validateResponses; a second mount
// on the same chain would validate every response twice.
const WRAPPED = Symbol("oaverify.validateResponses");

// getHeaders() reports numeric values (Content-Length, or any
// setHeader(name, number)) as numbers; the validator's header
// deserializer expects strings.
function responseHeaders(res: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(res.getHeaders())) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value : String(value);
  }
  return headers;
}

/**
 * Build an Express 4 middleware that validates outgoing responses against
 * the spec. It wraps `res.send`, the point most responses pass through
 * (`res.json` stringifies and re-dispatches through it; `res.sendStatus`
 * sends its status text through it too). Response status and declared
 * headers are checked for every wrapped send, regardless of media type;
 * the body is parsed and validated only when it is a parseable JSON string
 * (the exact wire body, with `toJSON` methods, the app's `json replacer` /
 * `json spaces` settings, and `Date` serialization applied first). A pure
 * `res.end()` (and `res.redirect`, which uses it) bypasses `res.send` and
 * is not covered. On failure the configured `onError` runs (default:
 * throw, forwarded to the host error handler as a 500).
 *
 * Opt-in and explicit: mount it only where you want response checking
 * (typically on in development, off in production), and after
 * `validateRequests`. What is and isn't validated, ordering caveats,
 * cost, and failure-mode recipes are in the package README; the core
 * `validateResponse` stays a pure function that reads its arguments.
 *
 * @example
 * ```ts
 * import { validateRequests, validateResponses } from "@oaverify/express4";
 *
 * app.use(validateRequests(validator));
 * if (process.env.NODE_ENV !== "production") {
 *   app.use(validateResponses(validator));
 * }
 * ```
 *
 * @public
 */
export function validateResponses(
  validator: Validator | TreeValidator,
  options: ValidateResponsesOptions = {},
): RequestHandler {
  if (validator.output === "predicate") {
    throw new Error(
      'validateResponses: a predicate-mode validator (output: "predicate") cannot report which ' +
        'response fields failed. Build the validator with output: "flat" (default) or "tree".',
    );
  }
  const toHttpRequest = options.toHttpRequest ?? httpRequestFromExpress;
  const shouldValidate = options.statuses ?? (() => true);
  const onError = options.onError ?? defaultOnError;

  return (req, res, next) => {
    const marked = res as Response & { [WRAPPED]?: boolean };
    if (marked[WRAPPED] === true) {
      next(
        new Error(
          "validateResponses: res is already wrapped (middleware mounted twice on this route chain); mount it once",
        ),
      );
      return;
    }
    marked[WRAPPED] = true;

    let httpReq: HttpRequest;
    try {
      httpReq = toHttpRequest(req);
    } catch (e) {
      next(e);
      return;
    }

    // Validate at most once per response; the error handler's own reply
    // re-enters this same wrapped send and must not loop.
    let handled = false;

    const check = (body: unknown, contentType: string): ValidationError[] | null => {
      handled = true;
      if (!shouldValidate(res.statusCode)) return null;
      const httpRes: HttpResponse = {
        status: res.statusCode,
        contentType,
        headers: responseHeaders(res),
        body,
      };
      const result = validator.validateResponse(httpReq, httpRes);
      if (result.valid) return null;
      return "errors" in result ? result.errors : collectLeaves(result.error);
    };

    // Run onError; on normal completion send the original body (unless
    // onError already sent one), on throw / rejection forward to the
    // host error handler. Stays synchronous for a sync onError so the
    // response settles in the same tick.
    const handleFailure = (errors: ValidationError[], sendOriginal: () => void): void => {
      const sendIfUnsent = (): void => {
        if (!res.headersSent) sendOriginal();
      };
      try {
        const maybe = onError(errors, { req, res, next });
        if (maybe !== undefined && typeof (maybe as Promise<void>).then === "function") {
          (maybe as Promise<void>).then(sendIfUnsent).catch(next);
        } else {
          sendIfUnsent();
        }
      } catch (e) {
        next(e);
      }
    };

    const originalSend = res.send.bind(res) as (...args: unknown[]) => Response;

    res.send = ((...args: unknown[]): Response => {
      // Multi-arg calls are Express 4's deprecated status/body forms;
      // forward them and let Express disambiguate (an object body comes
      // back through here serialized, and is validated then).
      if (args.length > 1) return originalSend(...args);
      const body = args[0];
      // Split-phase. Status and declared headers are checked for every
      // string / empty send (a text error page, a redirect's HTML body, or
      // res.sendStatus all flow through res.send as a string), independent
      // of the body's media type. The body is parsed and validated only
      // when it is a parseable JSON string; otherwise `parsed` stays
      // undefined and the core validator skips body validation (and the
      // response Content-Type check, gated on a present body). A pure
      // res.end() bypasses res.send and is not covered; see the README.
      if (!handled && (typeof body === "string" || body === undefined)) {
        const contentType = String(res.getHeader("content-type") ?? "");
        let parsed: unknown;
        if (typeof body === "string" && /\bjson\b/i.test(contentType)) {
          try {
            parsed = JSON.parse(body);
          } catch {
            // Unparseable JSON: leave parsed undefined; status/headers
            // still get checked, and the malformed body is sent unchanged.
          }
        }
        const errors = check(parsed, contentType);
        if (errors !== null) {
          handleFailure(errors, () => originalSend(...args));
          return res;
        }
      }
      return originalSend(...args);
    }) as Response["send"];

    next();
  };
}
