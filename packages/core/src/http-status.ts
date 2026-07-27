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
  /** Response (response-side only): spec declares no entry for the received status. */
  status: number;
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
  default: 400,
};

/**
 * Map a {@link ValidationError} to an HTTP status code.
 *
 * Handles the tree wrapping that bites consumers who write the
 * obvious switch: `route` and `method` appear as the top-level leaf
 * (router short-circuits), but `content-type`, `security`, and
 * response-side `status` are wrapped inside a top-level
 * `createBranchError("request", ...)` or `"response"` branch. This
 * helper inspects the top-level code for the unwrapped cases and
 * falls back to a leaf scan for the wrapped ones, then resolves to
 * a status from {@link DEFAULT_HTTP_STATUS_MAP} (or the caller's
 * overrides).
 *
 * Resolution order matches the HTTP gate semantics: 404 → 405 →
 * 415 → 401 → 500 → 400:
 *
 * ```ts
 * import { httpStatusFor } from "oaverify";
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
  // (404 -> 405 -> 415 -> 401 -> 500 -> 400); `route` / `method` fire as
  // standalone leaves, the rest as leaves anywhere in the report.
  const leaves = Array.isArray(error) ? error : collectLeaves(error as ValidationError);
  if (leaves.some((l) => l.code === "route")) return map.route;
  if (leaves.some((l) => l.code === "method")) return map.method;
  if (leaves.some((l) => l.code === "security")) return map.security;
  if (leaves.some((l) => l.code === "content-type")) return map["content-type"];
  if (leaves.some((l) => l.code === "status")) return map.status;
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
