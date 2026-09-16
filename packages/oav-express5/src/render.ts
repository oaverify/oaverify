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
 * 1. You want oaverify's rendering as the fallback in your own
 *    middleware: call this directly when you don't want to handle
 *    the error yourself.
 * 2. You want a slightly different renderer: use this as the
 *    starting point and adjust (e.g. swap the body, override the
 *    status, add headers). An overridden status goes to
 *    `toProblemDetails` too, per RFC 9457 3.1.2.
 *
 *
 * @specCites RFC 9457, https://www.rfc-editor.org/rfc/rfc9457
 * @specBoundary under-asserts https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2
 * A request rejected for missing or malformed credentials receives HTTP 401
 * without the required `WWW-Authenticate` header. That header tells the
 * client how to authenticate. The adapter knows the security scheme names
 * but lacks the details needed to build a challenge. Applications must
 * supply the header in their `onError` handler (#1087).
 * @specBoundary chooses https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1
 * Every error response uses `title: "Validation failed"`, regardless of its
 * HTTP status. The response's `about:blank` problem type means a generic
 * HTTP error; RFC 9457 recommends using the status phrase, such as `Bad
 * Request`, as its title. oaverify uses one validation-specific title and
 * lists individual errors in the `issues` field.
 *
 * @public
 */
export function renderProblemDetails(errors: ValidationError[], ctx: ExpressContext): void {
  const allow = allowHeaderFor(errors);
  if (allow !== undefined) ctx.res.setHeader("Allow", allow);
  // One status, asked once, used twice: RFC 9457 3.1.2 requires the
  // body's `status` to be the code the response actually carries.
  const status = httpStatusFor(errors);
  ctx.res
    .status(status)
    .type("application/problem+json")
    .json(toProblemDetails(errors, { status, instance: ctx.req.originalUrl }));
}
