/**
 * The `returnValues` channel: the deserialized request parameter values
 * that `validateRequest` already computes in order to validate, handed
 * back to the caller instead of discarded.
 *
 * The types are here rather than in `@oaverify/internal-schema` on
 * purpose. `ValidationResult` and `TreeValidationResult` are the JSON
 * Schema compiler's result shapes; they know nothing about HTTP, and a
 * bag keyed by `path` / `query` / `header` / `cookie` does not belong on
 * them. The value channel is an HTTP-validator concept and stays in this
 * package.
 */
import type { TreeValidationResult, ValidationResult } from "@oaverify/internal-schema";

/**
 * Deserialized request parameter values, grouped by the HTTP location
 * the parameter was declared in.
 *
 * The grouping mirrors the coordinates the validator already uses in
 * error paths: a caller reading `errors[0].path` of `["query", "tags"]`
 * and a caller reading `value.query.tags` are addressing the same
 * parameter the same way.
 *
 * **Presence rule.** A parameter appears here when this validation call
 * reached it, deserialized it, and its schema accepted the result. That
 * one rule holds on both `valid: true` and `valid: false`, so a present
 * key always means "this value is spec-valid" and never means "this
 * parsed, go check the errors first".
 *
 * A key is therefore absent when the parameter was not declared, was not
 * supplied, failed its schema, or was never reached because a
 * request-level check short-circuited first (see
 * {@link ValidatorOptions.returnValues} for which checks do that).
 * `errors` says which.
 *
 * Values are typed `unknown` because the validator has no per-operation
 * types for them; narrow with your own type guard, or wait for a typed
 * schema adapter.
 *
 * @public
 */
export interface RequestValues {
  /** Path parameters, keyed by declared name. */
  readonly path: Readonly<Record<string, unknown>>;
  /** Query parameters, keyed by declared name. */
  readonly query: Readonly<Record<string, unknown>>;
  /**
   * Header parameters, keyed by the declared name **verbatim from the
   * spec**. Header lookup against the request is case-insensitive; the
   * key here is the spelling the document used, so it is predictable
   * from the document alone.
   */
  readonly headers: Readonly<Record<string, unknown>>;
  /** Cookie parameters, keyed by declared name. */
  readonly cookies: Readonly<Record<string, unknown>>;
}

/**
 * The accumulator `validateParameter` writes into while validating.
 * Same shape as {@link RequestValues} without the `readonly`, so the
 * public type stays read-only while the internal one can be filled.
 *
 * @internal
 */
export interface MutableRequestValues {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  cookies: Record<string, unknown>;
}

/**
 * A fresh, empty accumulator. Allocated per `validateRequest` call, and
 * only when `returnValues` is on.
 *
 * The four maps are null-prototype: parameter names come from the spec,
 * but a spec is data, and a parameter named `__proto__` or `constructor`
 * would otherwise write through to `Object.prototype` semantics on
 * assignment. Same reasoning as `setSpecKey` in `deserialize.ts`.
 *
 * @internal
 */
export function emptyRequestValues(): MutableRequestValues {
  return {
    path: Object.create(null) as Record<string, unknown>,
    query: Object.create(null) as Record<string, unknown>,
    headers: Object.create(null) as Record<string, unknown>,
    cookies: Object.create(null) as Record<string, unknown>,
  };
}

/**
 * A flat-output `validateRequest` result carrying the value channel.
 * Returned when `createValidator` is called with `returnValues: true`
 * and the default `output: "flat"`.
 *
 * `value` sits on the intersection, so it is present and typed on both
 * branches of the `valid` union. Narrowing on `result.valid` changes
 * what the error fields look like and never removes `value`.
 *
 * @public
 */
export type ValuesValidationResult = ValidationResult & { value: RequestValues };

/**
 * The `output: "tree"` counterpart of {@link ValuesValidationResult}.
 *
 * @public
 */
export type TreeValuesValidationResult = TreeValidationResult & { value: RequestValues };
