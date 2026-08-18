import type { FastifyRequest } from "fastify";

/**
 * Marks a request whose reply is being written by the request
 * validator's refusal rather than by a route handler, so
 * {@link validateResponses} can tell the two apart.
 *
 * The mark covers a window rather than the whole request, and the
 * window is what makes it correct. `onSend` runs *during*
 * `reply.send()`, so by the time `validateRequests` regains control
 * after awaiting its `onError` the response hook has already run. The
 * mark therefore goes up before `onError` and comes down after, unless
 * `onError` sent something.
 *
 * That distinction is the whole point: a report-only `onError` records
 * the errors and returns without sending, the route handler runs
 * anyway, and the response it produces is ordinary handler output that
 * must still be validated. A mark that outlived the refusal would
 * silently pass an invalid response.
 *
 * `Symbol.for`, not a module-local symbol, for the reason
 * `markLowercaseKeys` uses one: the two hooks can arrive from different
 * installs of this package (npm dedup is not guaranteed), and a
 * registered symbol keeps its identity across them.
 *
 * Fastify-only. The Express adapters solve the same problem with mount
 * order: `validateResponses` patches `res.send`, so mounting it after
 * `validateRequests` puts the refusal outside what it wraps. `onSend`
 * is a lifecycle hook rather than a chain position, so it sees every
 * reply however it is registered and there is no order that helps.
 */
const REQUEST_REFUSED = Symbol.for("oaverify.requestRefused");

/** Open the refusal window: anything sent from here is the refusal's. */
export function markRequestRefused(request: FastifyRequest): void {
  (request as FastifyRequest & { [REQUEST_REFUSED]?: boolean })[REQUEST_REFUSED] = true;
}

/** Close it again, for a refusal that turned out not to send anything. */
export function unmarkRequestRefused(request: FastifyRequest): void {
  delete (request as FastifyRequest & { [REQUEST_REFUSED]?: boolean })[REQUEST_REFUSED];
}

/** Did the request validator refuse this request? */
export function requestWasRefused(request: FastifyRequest): boolean {
  return (request as FastifyRequest & { [REQUEST_REFUSED]?: boolean })[REQUEST_REFUSED] === true;
}

/**
 * Did Fastify match a route for this request?
 *
 * `routeOptions.url` is the declared route pattern, and is `undefined`
 * exactly when the not-found handler is answering. A response from
 * there has no operation to be checked against, so checking it reports
 * "no route matches", which describes the request rather than anything
 * the application did wrong.
 *
 * This is narrower than suppressing every `route` finding: a handler
 * Fastify routed but the spec does not declare still reports, which is
 * a real thing to tell someone.
 */
export function routeWasMatched(request: FastifyRequest): boolean {
  return request.routeOptions?.url !== undefined;
}
