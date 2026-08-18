/**
 * Express reads `next(falsy)` as "carry on routing", so a failure carrying
 * a falsy reason would be dropped and the request would continue as though
 * nothing had happened. Substitute an `Error` and keep the original reason
 * as its `cause`.
 *
 * Express 5's router substitutes for a promise a layer *returns*, which
 * covers neither adapter's direct `next(reason)` call, so both need this
 * (#881).
 *
 * @param site - What produced the value, so the message names it.
 * @internal
 */
export function forwardable(reason: unknown, site: "onError" | "toHttpRequest"): unknown {
  return reason || new Error(`oaverify: ${site} failed with a falsy value`, { cause: reason });
}
