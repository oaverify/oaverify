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
import { collectLeaves, createLeafError, type ValidationError } from "@oaverify/internal-core";
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
 * Exported through `@oaverify/internal-validator/codegen-runtime` for the `oaverify compile-spec`
 * emitted module's `validateFetch*` wrappers (same reason as
 * {@link reshapeResult}).
 *
 * @internal
 */
export function toFetchResult<T>(
  result: ValidationResult | TreeValidationResult | boolean,
  body: unknown,
): {
  ok: boolean;
  body?: T;
  errors?: ValidationError[];
  error?: ValidationError;
  truncated?: boolean;
} {
  if (result === true) return { ok: true, body: body as T };
  if (result === false) return { ok: false };
  if (result.valid) return { ok: true, body: body as T };
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
 * @internal
 */
export function fetchBodyParseFailure<T>(
  err: { readonly message: string; readonly mediaType: string },
  output: "flat" | "tree" | "predicate",
  maxErrors: number,
): ReturnType<typeof toFetchResult<T>> {
  return toFetchResult<T>(
    reshapeResult(
      createLeafError("body", ["body"], err.message, { mediaType: err.mediaType }),
      output,
      maxErrors,
    ),
    undefined,
  );
}
