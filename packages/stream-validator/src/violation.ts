/**
 * Bridge a {@link SchemaViolation} to `@oaverify/internal-core`'s {@link ValidationError}
 * so streaming output flows into the existing rendering surface
 * (`formatText`, `formatSummary`, `toProblemDetails`, and the framework
 * adapters' `renderProblemDetails`) instead of needing a stream-specific
 * formatter.
 *
 * The two types are deliberate parallels: a violation shares `code` and
 * `path` with an error and adds a stream `byteOffset`. On the BUFFER
 * (delegated) path a violation already carries the in-memory engine's
 * `message` / `params` / `children`, which pass through unchanged. On the
 * forward STREAM path it carries only `code` + `path` + `byteOffset`, so
 * this fills a coarse human-readable `message` from the code (the spine
 * does not synthesize one in the hot path, and there are no params to
 * interpolate a bound from). Either way the stream `byteOffset` rides in
 * `params.byteOffset`, the documented home for machine-readable detail.
 *
 * @packageDocumentation
 */

import type { PathSegment, ValidationError } from "@oaverify/internal-core";
import type { SchemaViolation } from "./spine/index.js";

// Coarse, parameterless gloss per STREAM-path code. The forward spine
// emits a bare code with no params, so these cannot name the failing bound
// (the in-memory delegate's messages, which can, pass through on the
// BUFFER path via `violation.message`). ASCII, lower-case, no trailing
// punctuation, to read uniformly under `formatText` / `formatSummary`.
const STREAM_CODE_MESSAGE: Record<string, string> = {
  type: "value has the wrong type",
  false: "no value is allowed here",
  const: "value is not the allowed constant",
  enum: "value is not one of the allowed values",
  minLength: "string is too short",
  maxLength: "string is too long",
  pattern: "string does not match the required pattern",
  minimum: "number is too small",
  maximum: "number is too large",
  exclusiveMinimum: "number is too small",
  exclusiveMaximum: "number is too large",
  multipleOf: "number is not a multiple of the required divisor",
  required: "a required property is missing",
  minProperties: "object has too few properties",
  maxProperties: "object has too many properties",
  dependentRequired: "a dependent required property is missing",
  dependencies: "a dependency property is missing",
  minItems: "array has too few items",
  maxItems: "array has too many items",
  uniqueItems: "array items are not unique",
  propertyNames: "a property name is not allowed",
  depth: "value is nested too deeply",
  composition: "value does not satisfy the schema composition",
};

/** A coarse human-readable message for a STREAM-path code. */
function messageForCode(code: string): string {
  return STREAM_CODE_MESSAGE[code] ?? `value does not satisfy "${code}"`;
}

function convertOne(violation: SchemaViolation): ValidationError {
  const params: Record<string, unknown> = { ...violation.params, byteOffset: violation.byteOffset };
  return {
    code: violation.code,
    path: [...(violation.path as PathSegment[])],
    message: violation.message ?? messageForCode(violation.code),
    params,
    children: violation.children?.map(convertOne) ?? [],
  };
}

/**
 * Convert a streaming {@link SchemaViolation} (or a list of them, e.g. a
 * verdict's `violations`) to `@oaverify/internal-core`'s {@link ValidationError},
 * carrying the stream `byteOffset` in `params.byteOffset`. Hand the result
 * to any `@oaverify/internal-core` renderer:
 *
 * ```ts
 * import { formatText, toProblemDetails } from "@oaverify/core";
 * import { toValidationError } from "@oaverify/stream";
 *
 * const verdict = await validator.result;
 * if (!verdict.valid) {
 *   const errors = toValidationError(verdict.violations);
 *   console.error(formatText(errors));
 *   res.status(400).json(toProblemDetails(errors));
 * }
 * ```
 *
 * Mirrors `@oaverify/internal-core`'s `toJsonObject`: a single violation in yields a
 * single error; a list yields a list.
 *
 * @public
 */
export function toValidationError(violation: SchemaViolation): ValidationError;
export function toValidationError(violations: readonly SchemaViolation[]): ValidationError[];
export function toValidationError(
  violation: SchemaViolation | readonly SchemaViolation[],
): ValidationError | ValidationError[] {
  return Array.isArray(violation)
    ? violation.map(convertOne)
    : convertOne(violation as SchemaViolation);
}
