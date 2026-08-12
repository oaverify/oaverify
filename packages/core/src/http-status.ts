import { collectLeaves, type ValidationError } from "./errors.js";

/**
 * Default mapping from {@link ValidationError} shape to HTTP status
 * code. Consumers can override any key via the second argument to
 * {@link httpStatusFor}.
 *
 * @public
 */
export interface HttpStatusMap {
  /** Router couldn't match the request path to any declared route. */
  route: number;
  /** Path matched but the requested method isn't declared on it. */
  method: number;
  /** Request `Content-Type` isn't in the declared `requestBody.content` set. */
  "content-type": number;
  /** Declared security scheme's credential location is missing or malformed. */
  security: number;
  /**
   * Response (response-side only): spec declares no entry for the
   * received status.
   *
   * The one response-side code this map covers, and 500 is a
   * serviceable guess rather than a derivation: a gateway that would
   * rather answer 502 should say so. See the request-side note on
   * {@link httpStatusFor}.
   */
  status: number;
  /**
   * Body refused for exceeding the reader's `maxTotalBytes` cap.
   *
   * 413 reads the leaf as a request: the sender is told the payload is
   * too large. See {@link httpStatusFor} for why the response-side
   * reading is not something this map tries to serve.
   */
  "body-too-large": number;
  /** Anything else: schema violations, missing required fields, etc. */
  default: number;
}

/**
 * Default HTTP status mapping used by {@link httpStatusFor}.
 *
 * @public
 */
export const DEFAULT_HTTP_STATUS_MAP: HttpStatusMap = {
  route: 404,
  method: 405,
  "content-type": 415,
  security: 401,
  status: 500,
  "body-too-large": 413,
  default: 400,
};

/**
 * Map a {@link ValidationError} to an HTTP status code to answer a
 * client with.
 *
 * **Request-side.** It answers "what do I tell this client about the
 * request they sent". Every status it returns reads the failure that
 * way, including `body-too-large` as 413.
 *
 * It is not the helper for a `validateResponse` /
 * `validateFetchResponse` result, and there is no sibling that is. Two
 * reasons, and the second is why none is coming:
 *
 * 1. The default `output: "flat"` reduces the tree to its leaves, so
 *    the `request` / `response` branch that records the direction is
 *    gone before this function sees it. No inspection can recover it.
 * 2. Nothing in the leaf determines the answer anyway. A gateway
 *    holding a response that violates its own contract might answer
 *    502, or 500, or serve a stale cache, or pass it through under
 *    report-only. That is policy, not a mapping.
 *
 * For a response-side result, read the leaves and apply your own
 * policy; `output: "tree"` keeps the enclosing `response` branch if
 * you want to key on the direction. The `status` slot is the one
 * response-side code covered here, as a convenience with a guessed
 * default.
 *
 * Handles the tree wrapping that bites consumers who write the
 * obvious switch: `route` and `method` appear as the top-level leaf
 * (router short-circuits), but `content-type`, `security`, and
 * response-side `status` are wrapped inside a top-level
 * `createBranchError("request", ...)` or `"response"` branch. This
 * helper collects the leaves and scans them in priority order, so
 * the wrapping never matters, then resolves to a status from
 * {@link DEFAULT_HTTP_STATUS_MAP} (or the caller's overrides).
 *
 * Resolution order matches the HTTP gate semantics: 404 → 405 →
 * 401 → 415 → 500 → 413 → 400. Authentication outranks content
 * negotiation, so a request that fails both answers 401:
 *
 * ```ts
 * import { httpStatusFor } from "@oaverify/core";
 *
 * const result = validator.validateRequest(httpRequest);
 * if (!result.valid) {
 *   res.status(httpStatusFor(result.errors)).json(toProblemDetails(result.errors));
 * }
 * ```
 *
 * Override any slot, e.g. APIs that use 422 for schema errors:
 *
 * ```ts
 * httpStatusFor(error, { default: 422 });
 * ```
 *
 * @public
 */
export function httpStatusFor(
  error: ValidationError | readonly ValidationError[],
  overrides?: Partial<HttpStatusMap>,
): number {
  const map =
    overrides === undefined
      ? DEFAULT_HTTP_STATUS_MAP
      : { ...DEFAULT_HTTP_STATUS_MAP, ...overrides };
  // Accepts either a nested error tree or the flat leaf list the default
  // (flat) validator returns. Scan leaves in HTTP-gate priority order
  // (404 -> 405 -> 401 -> 415 -> 500 -> 413 -> 400); `route` / `method` fire as
  // standalone leaves, the rest as leaves anywhere in the report.
  const leaves = Array.isArray(error) ? error : collectLeaves(error as ValidationError);
  if (leaves.some((l) => l.code === "route")) return map.route;
  if (leaves.some((l) => l.code === "method")) return map.method;
  if (leaves.some((l) => l.code === "security")) return map.security;
  if (leaves.some((l) => l.code === "content-type")) return map["content-type"];
  if (leaves.some((l) => l.code === "status")) return map.status;
  // Above `default` because a refused body short-circuits the read:
  // nothing else was validated, so any other leaf beside it would be
  // reporting on data we never saw.
  if (leaves.some((l) => l.code === "body-too-large")) return map["body-too-large"];
  return map.default;
}

/**
 * Return the comma-separated value for an `Allow` response header
 * when the error is a 405 (RFC 9110 §15.5.6 requires it), or
 * `undefined` otherwise.
 *
 * ```ts
 * const allow = allowHeaderFor(error);
 * if (allow !== undefined) res.setHeader("Allow", allow);
 * res.status(httpStatusFor(error)).json(toProblemDetails(error));
 * ```
 *
 * @public
 */
export function allowHeaderFor(
  error: ValidationError | readonly ValidationError[],
): string | undefined {
  const leaves = Array.isArray(error) ? error : collectLeaves(error as ValidationError);
  const method = leaves.find((l) => l.code === "method");
  if (method === undefined) return undefined;
  const allowed = (method.params as { allowed?: unknown }).allowed;
  if (!Array.isArray(allowed)) return undefined;
  return allowed.join(", ");
}
