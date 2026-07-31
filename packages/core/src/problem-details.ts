import { collectLeaves, type PathSegment, type ValidationError } from "./errors.js";
import { escapePointerSegment } from "./json-pointer.js";
import { formatSummary } from "./format.js";

/**
 * A single validation issue flattened for client consumption. Produced
 * by {@link collectIssues} and embedded in {@link ProblemDetails.issues}.
 *
 * Maps 1:1 to a leaf in the {@link ValidationError} tree: you get the
 * same `code`, `message`, and `params`, plus the path in two forms:
 * the raw segments array (good for programmatic filtering) and an
 * RFC 6901 JSON Pointer (good for display and tools that follow the
 * JSON:API / RFC 9457 conventions).
 *
 * @public
 */
export interface ValidationIssue {
  /** Stable error identifier (e.g. `"type"`, `"required"`, `"content-type"`). */
  code: string;
  /** Raw path segments to the offending data location. */
  path: PathSegment[];
  /** RFC 6901 JSON Pointer form of `path`, e.g. `"/body/pets/3/name"`. */
  pointer: string;
  /** Human-readable description. */
  message: string;
  /**
   * Machine-readable details for this issue; shape per-code
   * documented in {@link BuiltInErrorParams}. Most code-specific
   * shapes include request-derived fields (e.g. `pattern.actual`,
   * `additionalProperties.unexpected`) or schema-derived metadata
   * (e.g. `enum.allowed`, `maximum.maximum`). See the security note
   * on {@link toProblemDetails} when serving untrusted clients.
   */
  params: Record<string, unknown>;
}

/**
 * [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) "Problem
 * Details for HTTP APIs" response envelope with a typed `issues`
 * array as an extension member. Render as `application/problem+json`.
 *
 * @public
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. Defaults to `"about:blank"`. */
  type: string;
  /** Short human-readable summary. Defaults to `"Validation failed"`. */
  title: string;
  /** HTTP status code for the response. Defaults to `400`. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail: string;
  /** Optional URI reference for this occurrence (typically the request URL). */
  instance?: string;
  /**
   * Flattened validation failures, one per leaf in the underlying
   * {@link ValidationError} tree.
   */
  issues: ValidationIssue[];
}

/**
 * Options for {@link toProblemDetails}.
 *
 * @public
 */
export interface ProblemDetailsOptions {
  /** URI identifying the problem type. Default: `"about:blank"`. */
  type?: string;
  /** Short title. Default: `"Validation failed"`. */
  title?: string;
  /** HTTP status code. Default: `400`. */
  status?: number;
  /** URI reference identifying this specific occurrence (e.g. the request URL). */
  instance?: string;
  /**
   * Override the human-readable `detail`. Defaults to
   * {@link formatSummary}(error): a single line describing the first
   * failing leaf (e.g. `"body.users[0].email must match format \"email\""`).
   * The default summary interpolates the offending value for codes
   * such as `enum`, `format`, and `pattern`; APIs serving untrusted
   * clients should pass an explicit structural summary
   * (e.g. `` `${issues.length} validation error(s)` ``) so leaf data
   * does not appear in `detail`. See the security note on
   * {@link toProblemDetails} for the corresponding `issues[*].params`
   * concern.
   */
  detail?: string;
}

/**
 * Flatten a {@link ValidationError} tree to a list of leaves annotated
 * with an RFC 6901 JSON Pointer. Useful when you want a client-friendly
 * issues array but don't need the {@link ProblemDetails} envelope.
 *
 * Leaf-only by design: branch-level `params` (e.g. `oneOf`'s `matchCount`)
 * are not in the result. Access the raw {@link ValidationError} if you
 * need the tree.
 *
 * @public
 */
export function collectIssues(
  error: ValidationError | readonly ValidationError[],
): ValidationIssue[] {
  const leaves = Array.isArray(error) ? error : collectLeaves(error as ValidationError);
  return leaves.map((leaf) => ({
    code: leaf.code,
    path: leaf.path,
    pointer: toJsonPointer(leaf.path),
    message: leaf.message,
    params: leaf.params,
  }));
}

/**
 * Convert a {@link ValidationError} tree to an RFC 9457 "Problem
 * Details for HTTP APIs" response body. Render as
 * `application/problem+json` in your HTTP layer.
 *
 * **Data exposure.** By design, the rendered response echoes input
 * values and schema metadata. `detail` defaults to a one-line
 * summary of the first failing leaf, which interpolates the
 * offending value for codes such as `enum`, `format`, and `pattern`.
 * Each `issues[*].params` carries the leaf's machine-readable
 * detail (see {@link BuiltInErrorParams}), including request-derived
 * fields (`pattern.actual`, `additionalProperties.unexpected`,
 * `required.missing`) and schema-derived metadata (`enum.allowed`,
 * `pattern.pattern`, `maximum.maximum`). This is the right default
 * for trusted clients and developer-facing APIs. APIs serving
 * untrusted clients, or APIs validating request bodies that contain
 * PII, should override `detail` with a structural summary (e.g.
 * `` `${pd.issues.length} validation error(s)` ``) and may want to
 * clear `issues[*].params` before sending. See the "Redacting field
 * values from problem-details responses" recipe in
 * `docs/integration.md`.
 *
 * @example
 * ```ts
 * // Express 5
 * const result = validator.validateRequest(httpRequest);
 * if (!result.valid) {
 *   res.status(400)
 *      .type("application/problem+json")
 *      .json(toProblemDetails(result.errors, { instance: req.originalUrl }));
 * }
 * ```
 *
 * @public
 */
export function toProblemDetails(
  error: ValidationError | readonly ValidationError[],
  options: ProblemDetailsOptions = {},
): ProblemDetails {
  const issues = collectIssues(error);
  // `detail` summarises the first failing leaf. For a flat leaf list
  // that's the list head; for a tree it's the first leaf in tree order.
  const summarySource = Array.isArray(error) ? error[0] : (error as ValidationError);
  const result: ProblemDetails = {
    type: options.type ?? "about:blank",
    title: options.title ?? "Validation failed",
    status: options.status ?? 400,
    detail: options.detail ?? (summarySource !== undefined ? formatSummary(summarySource) : ""),
    issues,
  };
  if (options.instance !== undefined) result.instance = options.instance;
  return result;
}

/**
 * Convert a path-segment array to an RFC 6901 JSON Pointer string.
 * Returns `""` for an empty path. `~` and `/` in segments are escaped
 * to `~0` and `~1`.
 */
function toJsonPointer(path: PathSegment[]): string {
  if (path.length === 0) return "";
  return path.map((seg) => "/" + escapePointerSegment(String(seg))).join("");
}
