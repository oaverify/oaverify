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
  const direct = headers[lowered];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}
