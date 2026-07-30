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
 * Fast path for spec-declared header names that cannot collide with
 * `Object.prototype` after lowercasing. Keeps case-insensitive fallback
 * for hand-built records.
 *
 * @internal
 */
export function getHeaderValueFast(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | string[] | undefined {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  const direct = headers[lowered];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

export { getOwn } from "@oaverify/internal-core";
