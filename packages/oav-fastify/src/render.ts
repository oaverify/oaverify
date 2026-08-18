import {
  allowHeaderFor,
  httpStatusFor,
  toProblemDetails,
  type ValidationError,
} from "@oaverify/internal-core";
import type { FastifyContext } from "./types.js";

/**
 * The default `onError` for {@link validateRequests}. Renders the
 * failing leaves as an RFC 9457 `application/problem+json` response:
 * status from {@link httpStatusFor}, `Allow` header from
 * {@link allowHeaderFor} on a 405, body from {@link toProblemDetails}
 * (whose `detail` is the first failing leaf).
 *
 * Exported standalone for two cases:
 *
 * 1. You want oaverify's rendering as the fallback in your own hook:
 *    call this directly when you don't want to handle the error
 *    yourself.
 * 2. You want a slightly different renderer: use this as the
 *    starting point and adjust (e.g. swap the body, override the
 *    status, add headers). An overridden status goes to
 *    `toProblemDetails` too, per RFC 9457 3.1.2.
 *
 * Pairs with sibling `renderProblemDetails` in `@oaverify/express4` /
 * `@oaverify/express5`. Same logic, framework-native API.
 *
 * @public
 */
export function renderProblemDetails(errors: ValidationError[], ctx: FastifyContext): void {
  const allow = allowHeaderFor(errors);
  if (allow !== undefined) ctx.reply.header("Allow", allow);
  // One status, asked once, used twice: RFC 9457 3.1.2 requires the
  // body's `status` to be the code the response actually carries.
  const status = httpStatusFor(errors);
  ctx.reply
    .code(status)
    .type("application/problem+json")
    .send(toProblemDetails(errors, { status, instance: ctx.request.url }));
}
