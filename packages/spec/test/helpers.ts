/**
 * Shared narrowing helpers for the spec test suite.
 */
/**
 * Narrow past a `$ref` union. OpenAPI containers type most members as
 * `ReferenceObject | T`; these specs are already resolved, so the ref
 * branch is unreachable -- but say so explicitly rather than casting,
 * so a genuinely unresolved ref fails loudly here.
 */
export function notRef<T extends object>(node: T): Exclude<T, { $ref: string }> {
  if ("$ref" in node) {
    throw new Error(`expected a resolved object, got $ref ${String(node.$ref)}`);
  }
  return node as Exclude<T, { $ref: string }>;
}
