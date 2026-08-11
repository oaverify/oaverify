import { formatSummary, formatText, toJsonObject } from "./format.js";
import type { ValidationError } from "./errors.js";

/**
 * Single source of truth for the CLI's `--format` flag. The
 * {@link OutputFormat} union and the Commander parser validator both
 * derive from this tuple; add a new name here and extend
 * {@link formatError} to wire it up end-to-end.
 *
 * @public
 */
export const KNOWN_OUTPUT_FORMATS = ["text", "json", "summary"] as const;

/**
 * Supported built-in output formats.
 *
 * `"summary"` pairs the format name with {@link formatSummary}, the
 * renderer behind it. It was named `"flat"` until 3.8.0, which used the
 * same word that `ValidatorOptions.output: "flat"` uses for an
 * unrelated result shape (the errors-list shape vs a tree); the alias
 * was removed in 7.0.0.
 *
 * @public
 */
export type OutputFormat = (typeof KNOWN_OUTPUT_FORMATS)[number];

/**
 * Type guard: narrows an arbitrary string to {@link OutputFormat} iff
 * it appears in {@link KNOWN_OUTPUT_FORMATS}.
 *
 * @public
 */
export function isOutputFormat(value: string): value is OutputFormat {
  return (KNOWN_OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * A programmatic renderer: any function that turns a
 * {@link ValidationError} tree into a string.
 *
 * @public
 */
export type ErrorRenderer = (err: ValidationError) => string;

/**
 * Format a {@link ValidationError} tree as a string in the requested style.
 *
 * `renderer` may be one of the built-in format names
 * ({@link OutputFormat}) or a caller-supplied function, which lets
 * library consumers plug in SARIF / RFC 7807 / JUnit renderers without
 * forking the dispatch switch.
 *
 * @remarks
 * Takes a single error tree, unlike {@link formatText},
 * {@link formatSummary}, and {@link toJsonObject}, which also accept the
 * flat `ValidationError[]` the default validator returns. `formatError`
 * stays tree-only because a custom {@link ErrorRenderer} is typed
 * `(err: ValidationError) => string`, and widening that would break
 * existing renderers. For the default flat output, call those helpers
 * directly, or wrap the list with {@link createBranchError} before passing
 * it here.
 *
 * @param error - The error tree.
 * @param renderer - A built-in format name or a custom render function.
 * @param maxDepth - Optional max depth (applies to `"text"` format only).
 * @returns The rendered string.
 *
 * @public
 */
export function formatError(
  error: ValidationError,
  renderer: OutputFormat | ErrorRenderer,
  maxDepth?: number,
): string {
  if (typeof renderer === "function") return renderer(error);
  switch (renderer) {
    case "json":
      return JSON.stringify(toJsonObject(error), null, 2);
    case "summary":
      return formatSummary(error, { select: "all" });
    case "text":
    default:
      return formatText(error, maxDepth !== undefined ? { maxDepth } : {});
  }
}
