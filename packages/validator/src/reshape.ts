/**
 * Result reshaping, factored out of `validator.ts` so it can be
 * re-exported through `@oaverify/internal-validator/codegen-runtime` without dragging the
 * validator's full module graph (`@oaverify/internal-spec` -> `node:fs`, etc.) into
 * `oaverify compile-spec`'s standalone esbuild bundle. The only runtime
 * dependency here is `@oaverify/internal-core`'s `collectLeaves`.
 *
 * The validator builds a nested error tree internally and reshapes it to
 * the requested `output` / `maxErrors` at its public boundary; the emitted
 * standalone module reuses these same functions so its AOT output's result
 * shape stays identical to `createValidator`.
 */
import {
  collectLeaves,
  createBranchError,
  createLeafError,
  type ValidationError,
} from "@oaverify/internal-core";
import type { TreeValidationResult, ValidationResult } from "@oaverify/internal-schema";

/**
 * Depth-first prune of an error tree to at most `max` leaves, dropping
 * branches that become empty. Returns the trimmed root. Used to enforce
 * the per-call `maxErrors` total in tree output.
 */
function trimTreeToLeaves(root: ValidationError, max: number): ValidationError {
  let remaining = max;
  const visit = (node: ValidationError): ValidationError | null => {
    if (node.children.length === 0) {
      if (remaining <= 0) return null;
      remaining -= 1;
      return node;
    }
    const kept: ValidationError[] = [];
    for (const child of node.children) {
      const v = visit(child);
      if (v !== null) kept.push(v);
    }
    if (kept.length === 0) return null;
    return { ...node, children: kept };
  };
  return visit(root) ?? root;
}

/**
 * Reshape the validator's internal error tree (`ValidationError | null`)
 * into the requested output, applying the per-call `maxErrors` total.
 * `truncated` reports that the cap was reached (more problems may exist).
 *
 * Exported through `@oaverify/internal-validator/codegen-runtime` so `oaverify compile-spec`'s
 * emitted standalone module reshapes its hand-built tree the same way,
 * keeping the AOT output's result shape identical to this validator's.
 *
 * @internal
 */
export function reshapeResult(
  tree: ValidationError | null,
  output: "flat" | "tree" | "predicate",
  maxErrors: number,
): ValidationResult | TreeValidationResult | boolean {
  if (output === "predicate") return tree === null;
  if (tree === null) return { valid: true };
  const finite = Number.isFinite(maxErrors);
  const leaves = collectLeaves(tree);
  const truncated = finite && leaves.length >= maxErrors;
  if (output === "tree") {
    const error = finite && leaves.length > maxErrors ? trimTreeToLeaves(tree, maxErrors) : tree;
    return { valid: false, error, truncated };
  }
  return { valid: false, errors: finite ? leaves.slice(0, maxErrors) : leaves, truncated };
}

/**
 * Map a reshaped validation result onto the Fetch-wrapper return shape:
 * `{ ok: true, body }` on success, or `{ ok: false }` plus the failure
 * fields (`errors`/`error` + `truncated`, or nothing in predicate mode).
 *
 * A `returnValues` result carries its `value` channel through both
 * branches. The failure branch gets it from the rest-spread; the success
 * branch has to copy it, and doing that here is what keeps the two
 * agreeing. Patched on by each caller instead, one caller forgetting is
 * enough to produce a result whose type promises a channel it does not
 * have.
 *
 * `value` is absent from the output exactly when it is absent from
 * `result`, so the default path allocates the same object literal it
 * always did and the `oaverify compile-spec` emitted module (which never
 * produces a result carrying `value`) is unaffected.
 *
 * Exported through `@oaverify/internal-validator/codegen-runtime` for the `oaverify compile-spec`
 * emitted module's `validateFetch*` wrappers (same reason as
 * {@link reshapeResult}).
 *
 * @internal
 */
export function toFetchResult<T>(
  result: (ValidationResult | TreeValidationResult) | boolean,
  body: unknown,
): {
  ok: boolean;
  body?: T;
  errors?: ValidationError[];
  error?: ValidationError;
  truncated?: boolean;
  value?: unknown;
} {
  if (result === true) return { ok: true, body: body as T };
  if (result === false) return { ok: false };
  if (result.valid) {
    return "value" in result
      ? { ok: true, body: body as T, value: (result as { value?: unknown }).value }
      : { ok: true, body: body as T };
  }
  const { valid: _valid, ...failure } = result;
  return { ok: false, ...failure };
}

/**
 * The fetch-shaped verdict for a request body that could not be parsed.
 *
 * An unparseable payload is a validation verdict, not an exception: the
 * body is attacker-controlled, and a `JSON.parse` throwing out of a
 * `validateFetchRequest` turns garbage input into a 500 for every caller
 * that did not wrap the await. Every fetch entry point converts a
 * `FetchBodyParseError` through here, and lets anything else propagate.
 *
 * Takes the error structurally rather than importing
 * `FetchBodyParseError`, so this module keeps its one runtime dependency
 * and stays cheap for `oaverify compile-spec`'s bundle. Callers own the
 * `instanceof` check; this owns the shape of the answer.
 *
 * Pass `value` when the caller runs with `returnValues`. The body fails
 * before any request validation, so no parameter was reached and the
 * right answer is an empty channel rather than an absent one: the type
 * on a values validator declares `value` on both branches. Callers that
 * have no channel (the response side, and `returnValues` off) omit it,
 * and the key stays absent.
 *
 * @internal
 */
export function fetchBodyParseFailure<T>(
  err: { readonly message: string; readonly mediaType: string },
  output: "flat" | "tree" | "predicate",
  maxErrors: number,
  direction: FetchBodyDirection,
  value?: unknown,
): ReturnType<typeof toFetchResult<T>> {
  return fetchBodyFailure<T>(
    createLeafError("body", ["body"], err.message, { mediaType: err.mediaType }),
    output,
    maxErrors,
    direction,
    value,
  );
}

/**
 * The fetch-shaped verdict for a body refused as over-large.
 *
 * The sibling of {@link fetchBodyParseFailure}, for the same reason:
 * an oversized body is attacker-controlled input rather than an IO
 * fault, so it is a verdict, and a `FetchBodyTooLargeError` escaping a
 * `validateFetchRequest` would turn a client's mistake into a 500.
 *
 * The leaf carries `reason` and `bytes` alongside `limit` so a
 * consumer can tell a `Content-Length` it was handed from a count this
 * reader took. Same structural-argument reason as the sibling: no
 * import of `FetchBodyTooLargeError` here.
 *
 * @internal
 */
export function fetchBodyTooLargeFailure<T>(
  err: {
    readonly message: string;
    readonly limit: number;
    readonly reason: "declared" | "read";
    readonly bytes: number;
  },
  output: "flat" | "tree" | "predicate",
  maxErrors: number,
  direction: FetchBodyDirection,
  value?: unknown,
): ReturnType<typeof toFetchResult<T>> {
  return fetchBodyFailure<T>(
    createLeafError("body-too-large", ["body"], err.message, {
      limit: err.limit,
      reason: err.reason,
      bytes: err.bytes,
    }),
    output,
    maxErrors,
    direction,
    value,
  );
}

/**
 * Which side of the exchange a body failure came from, and what the
 * wrapping branch needs to name it.
 *
 * The response side carries its status, which the `Response` object
 * has. The request side carries the method and no `pathPattern`: the
 * body is read during extraction, before routing, so there is no
 * matched template yet. See `BuiltInErrorParams["request"]` for why
 * that is absent rather than filled with the concrete path.
 *
 * @internal
 */
export type FetchBodyDirection =
  | { readonly kind: "request"; readonly method: string }
  | { readonly kind: "response"; readonly status: number };

/**
 * Shared tail of the two body-failure verdicts above.
 *
 * The leaf is wrapped in the same `request` / `response` branch every
 * other error from these entry points carries. Without it these two
 * were the only verdicts that discarded their direction even in tree
 * mode, which left a consumer unable to tell a client's oversized
 * upload from an upstream's oversized reply: the leaves are identical
 * and `httpStatusFor` cannot recover the difference (it maps
 * `body-too-large` to 413, a request-side answer, by design).
 *
 * Flat output still reduces to the same leaf list as before, since
 * reshaping collects leaves and drops branches. The direction is
 * recoverable in tree mode only, which is why `httpStatusFor` does not
 * try to use it.
 */
function fetchBodyFailure<T>(
  leaf: ValidationError,
  output: "flat" | "tree" | "predicate",
  maxErrors: number,
  direction: FetchBodyDirection,
  value: unknown,
): ReturnType<typeof toFetchResult<T>> {
  const wrapped =
    direction.kind === "request"
      ? createBranchError(
          "request",
          [],
          `${direction.method.toUpperCase()}: request validation failed`,
          [leaf],
          { method: direction.method },
        )
      : createBranchError("response", [], "response validation failed", [leaf], {
          status: direction.status,
        });
  const reshaped = reshapeResult(wrapped, output, maxErrors);
  if (value !== undefined) {
    (reshaped as { value?: unknown }).value = value;
  }
  return toFetchResult<T>(reshaped, undefined);
}
