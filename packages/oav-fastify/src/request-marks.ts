import type { FastifyRequest } from "fastify";

/**
 * Marks a request that {@link validateRequests} refused, so
 * {@link validateResponses} can tell the refusal apart from a route
 * handler's own output.
 *
 * `Symbol.for`, not a module-local symbol, for the reason
 * `markLowercaseKeys` uses one: the two hooks can arrive from different
 * installs of this package (npm dedup is not guaranteed), and a
 * registered symbol keeps its identity across them. A missed mark would
 * turn a 400 into a 500, so failing open is not acceptable here.
 *
 * Fastify-only. The Express adapters solve the same problem with mount
 * order: `validateResponses` patches `res.send`, so mounting it after
 * `validateRequests` puts the refusal outside what it wraps. `onSend`
 * is a lifecycle hook rather than a chain position, so it sees every
 * reply however it is registered and there is no order that helps.
 */
const REQUEST_REFUSED = Symbol.for("oaverify.requestRefused");

/** Record that the request validator refused this request. */
export function markRequestRefused(request: FastifyRequest): void {
  (request as FastifyRequest & { [REQUEST_REFUSED]?: boolean })[REQUEST_REFUSED] = true;
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
