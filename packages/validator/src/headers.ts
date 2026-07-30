/**
 * Read a header from a framework-neutral header record. The adapter
 * helpers normalize keys to lowercase, so the common path is one lookup;
 * hand-built records still get HTTP's case-insensitive semantics.
 *
 * @internal
 */
export function getHeaderValue(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | string[] | undefined {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  // `Object.hasOwn`, not a bare index. A header parameter named after an
  // `Object.prototype` member ("constructor", "toString", ...) would
  // otherwise resolve to the inherited function and read as present,
  // satisfying a `required` check the client never satisfied.
  if (Object.hasOwn(headers, lowered)) {
    const direct = headers[lowered];
    if (direct !== undefined) return direct;
  }
  // Already own-only: `Object.entries` skips the prototype chain.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Own-property read for a framework-supplied query or cookie record.
 * Same reason as the `Object.hasOwn` guard in {@link getHeaderValue}: an
 * inherited member must never satisfy a presence check.
 *
 * @internal
 */
export function getOwn<T>(bag: Record<string, T> | undefined, name: string): T | undefined {
  if (bag === undefined) return undefined;
  return Object.hasOwn(bag, name) ? bag[name] : undefined;
}
