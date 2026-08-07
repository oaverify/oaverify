import type { JsonValue } from "./types.js";

/**
 * Turn a URI fragment into the JSON Pointer it encodes, per RFC 6901
 * §6: percent-decode the whole fragment, and evaluate the result as a
 * pointer.
 *
 * The two steps are separate operations on different inputs, and
 * conflating them is a bug rather than a shortcut. A `$ref` value is a
 * URI reference whose fragment is percent-encoded; a JSON Pointer
 * string is not. `/a%2Fb` as a *fragment* addresses `a` then `b`, and
 * as a *pointer* addresses the single key `a%2Fb`. So decoding belongs
 * here, at the boundary, and {@link resolveJsonPointer} does none.
 *
 * Decoding the whole string at once is what makes a multi-byte sequence
 * work: `%C3%A9` is one character in two escapes, and decoding each
 * escape on its own throws `URIError` on the first half. The fallback
 * runs only when the string as a whole will not decode, and then
 * decodes each *run* of escapes together (still multi-byte safe) while
 * leaving a stray `%` as written, since a bare `%` is legal in a key
 * and refusing the whole reference over it would be worse.
 *
 * @public
 */
export function pointerFromFragment(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/**
 * Evaluate an RFC 6901 JSON Pointer against a root document (§4).
 *
 * Takes a **JSON Pointer**, not a URI fragment. It does no
 * percent-decoding: `%2F` is two ordinary characters inside a key, and
 * `~1` is how a `/` inside a key is written. A caller holding a `$ref`
 * has a fragment rather than a pointer and converts first, with
 * {@link pointerFromFragment} or {@link pointerFromRefFragment}.
 *
 * Behavior:
 *   - `""` returns the root, and is the only pointer that does. `"/"`
 *     is one reference token whose value is the empty string, so it
 *     addresses the member keyed `""` (§3). A document with an
 *     empty-string key is rare and legal, and treating `"/"` as the
 *     root would resolve a present pointer to the wrong node.
 *   - Any other pointer MUST start with `/`.
 *   - Arrays are indexed by the §4 `array-index` token only: `0`, or
 *     digits with no leading zero. `01`, `1abc`, and `-` all throw.
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
/** RFC 6901 §4 `array-index`: `0`, or digits with no leading zero. */
const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;

export function resolveJsonPointer(root: unknown, pointer: string): JsonValue {
  if (pointer === "") return root as JsonValue;
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${pointer}`);
  }
  const parts = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") {
      throw new Error(`JSON pointer ${pointer} traverses a primitive at ${part}`);
    }
    const asArr = Array.isArray(cur);
    if (asArr && !ARRAY_INDEX_RE.test(part)) {
      // §4: an array reference token is `0` or a digit run with no
      // leading zero. `parseInt` read `1abc`, `01`, and ` 1` all as
      // index 1, so a malformed token resolved to a real element
      // instead of failing, and two different pointers named one node.
      throw new Error(`JSON pointer ${pointer} not found (at ${part}: not an array index)`);
    }
    const key = asArr ? Number.parseInt(part, 10) : part;
    cur = (cur as Record<string, unknown>)[key as never];
    if (cur === undefined) {
      throw new Error(`JSON pointer ${pointer} not found (at ${part})`);
    }
  }
  return cur as JsonValue;
}

/**
 * Escape one token for use as an RFC 6901 pointer segment: `~` becomes
 * `~0`, `/` becomes `~1` (§3). Percent-encoding is deliberately not
 * applied; see {@link pointerFromRefFragment} for the form every
 * pointer this library reports is in.
 *
 * @public
 */
export function escapePointerSegment(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Turn a local `$ref` into the pointer it names, or `undefined` when it
 * names no position in this document.
 *
 * A `$ref` is a URI reference, so its fragment may carry percent-escapes
 * that a JSON Pointer does not: `#/components/schemas/My%20Schema`
 * addresses the key `My Schema`. The decode happens here, once, via
 * {@link pointerFromFragment}; the pointer this returns is ready to
 * hand to {@link resolveJsonPointer} and must not be decoded again.
 *
 * Reported pointers are therefore in the **decoded** form, with `~0` and
 * `~1` retained. That is the form {@link escapePointerSegment} produces,
 * so a pointer built by walking and a pointer taken from a `$ref` are
 * the same grammar and can be compared and concatenated. Skipping the
 * decode would leave two grammars behind one field name, which is the
 * defect this whole surface exists to remove.
 *
 * `undefined` for an anchor (`#/$defs/x` is a pointer, `#foo` is not),
 * an external URI, or a relative reference: those name a schema, and
 * some of them name it precisely, but none of them name a position in
 * *this* document, and a synthesized pointer that does not resolve is
 * worse than no pointer at all.
 *
 * @public
 */
export function pointerFromRefFragment(ref: string): string | undefined {
  if (!ref.startsWith("#/")) return undefined;
  return pointerFromFragment(ref.slice(1));
}
