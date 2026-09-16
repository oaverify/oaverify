/**
 * Shared OAS 3.0 `$ref` sibling rules.
 *
 * @internal
 */

/**
 * Sibling keys retained alongside `$ref` under OAS 3.0: metadata-only,
 * no validation effect. Anything else is silently dropped under
 * `refSuppressesSiblings: true`.
 *
 * OAS 3.0 does not permit these, it ignores everything: the Reference
 * Object says it "cannot be extended with additional properties, and
 * any properties added SHALL be ignored". They are kept because neither
 * asserts anything, so retaining them cannot change a verdict, and
 * dropping author-written prose is a worse default than carrying it.
 * (`summary` beside a `$ref` is a 3.1 Reference Object field rather
 * than a 3.0 one; it is retained under both for the same reason.)
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
