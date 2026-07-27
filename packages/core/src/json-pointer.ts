import type { JsonValue } from "./types.js";

/**
 * Resolve an RFC 6901 JSON Pointer fragment (the part AFTER a leading
 * `#`) against a root document. Percent-encoded octets are decoded
 * before `~0`/`~1` per RFC 6901 §5.
 *
 * Behavior:
 *   - `""` or `"/"` returns the root (the whole-document pointer).
 *   - Any other pointer MUST start with `/`.
 *   - Stray `%` characters that aren't a valid `%XX` escape are
 *     preserved rather than decoded.
 *   - Numeric pointer segments traverse arrays by index.
 *   - Missing targets and pointers that walk into a primitive throw
 *     `Error`; use a `try`/`catch` at call sites that expect the
 *     reference to optionally exist.
 *
 * Shared by `@oaverify/internal-schema`'s internal `$ref` resolver and `@oaverify/internal-spec`'s
 * document stitcher; having one implementation means a single place
 * for any future RFC edge-case fix.
 *
 * @public
 */
export function resolveJsonPointer(root: unknown, pointer: string): JsonValue {
  if (pointer === "" || pointer === "/") return root as JsonValue;
  // RFC 6901 §6: percent-decoding happens on the whole pointer first,
  // then ~0/~1 decoding per §4. Only well-formed %XX escapes are decoded
  // so stray '%' chars in keys are preserved.
  const decoded = pointer.replace(/%[0-9A-Fa-f]{2}/g, (m) => decodeURIComponent(m));
  if (!decoded.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${pointer}`);
  }
  const parts = decoded
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") {
      throw new Error(`JSON pointer ${pointer} traverses a primitive at ${part}`);
    }
    const asArr = Array.isArray(cur);
    const key = asArr ? Number.parseInt(part, 10) : part;
    cur = (cur as Record<string, unknown>)[key as never];
    if (cur === undefined) {
      throw new Error(`JSON pointer ${pointer} not found (at ${part})`);
    }
  }
  return cur as JsonValue;
}
