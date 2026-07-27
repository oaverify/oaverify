import {
  allowHeaderFor,
  httpStatusFor,
  toProblemDetails,
  type ValidationError,
} from "@oaverify/internal-core";
import type { ExpressContext } from "./types.js";

/**
 * The default `onError` for {@link validateRequests}. Renders the
 * failing leaves as an RFC 9457 `application/problem+json` response:
 * status from {@link httpStatusFor}, `Allow` header from
 * {@link allowHeaderFor} on a 405, body from {@link toProblemDetails}
 * (whose `detail` is the first failing leaf).
 *
 * Exported standalone for two cases:
 *
 * 1. You want oav's rendering as the fallback in your own
 *    middleware: call this directly when you don't want to handle
 *    the error yourself.
 * 2. You want a slightly different renderer: use this as the
 *    starting point and adjust (e.g. swap the body, override the
 *    status, add headers).
 *
 * @public
 */
export function renderProblemDetails(errors: ValidationError[], ctx: ExpressContext): void {
  const allow = allowHeaderFor(errors);
  if (allow !== undefined) ctx.res.setHeader("Allow", allow);
  ctx.res
    .status(httpStatusFor(errors))
    .type("application/problem+json")
    .json(toProblemDetails(errors, { instance: ctx.req.originalUrl }));
}
