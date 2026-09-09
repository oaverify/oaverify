/**
 * Shared OAS 3.0 `$ref` sibling rules.
 *
 * @internal
 */

/**
 * Sibling keys explicitly permitted alongside `$ref` under OAS 3.0
 * (Schema Object §4.7.24.2): metadata-only, no validation effect.
 * Anything else is silently dropped under `refSuppressesSiblings: true`.
 *
 * @internal
 */
export const OAS30_REF_SIBLINGS_ALLOWED: ReadonlySet<string> = new Set([
  "$ref",
  "description",
  "summary",
]);

/**
 * Whether a key is ignored because the active dialect uses OAS 3.0
 * `$ref` sibling suppression.
 *
 * @internal
 */
export function refSiblingIsDiscarded(
  schema: Record<string, unknown>,
  key: string,
  refSuppressesSiblings: boolean,
): boolean {
  return refSuppressesSiblings && "$ref" in schema && !OAS30_REF_SIBLINGS_ALLOWED.has(key);
}
