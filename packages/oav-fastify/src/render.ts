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
 *
 * @specCites RFC 9457, https://www.rfc-editor.org/rfc/rfc9457
 * @specBoundary under-asserts https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2
 * A request refused for a missing or malformed credential is answered
 * 401 with no `WWW-Authenticate` header, where RFC 9110 says the server
 * generating one MUST send a challenge. The `security` leaf carries the
 * declared scheme names and not the challenge strings, so the adapter
 * cannot build one; an application serving 401 supplies the header in
 * its own `onError` (#1087). 415 and 413 mandate no header: RFC 9110
 * says `Accept` "can be used" on a 415, and requires `Retry-After` only
 * where the condition is temporary, which a fixed byte cap is not.
 * @specBoundary chooses https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1
 * A refused request is answered with `title: "Validation failed"`
 * whatever status it carries, where the registered `about:blank` type
 * asks that the title "SHOULD be the same as the recommended HTTP
 * status phrase for that code". The `issues` extension rides on that
 * type for the same reason: a list of failing leaves is the whole point
 * of the renderer, and inventing a problem-type URI oaverify does not
 * host would be worse than reusing the one that means "no semantics
 * beyond the status".
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
