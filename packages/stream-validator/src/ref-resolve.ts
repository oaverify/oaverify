/**
 * Local `$ref` resolution against a resolved document root. Shared by the
 * classifier (which throws on an unresolvable ref) and the spine (which
 * follows refs at validation time). External refs are expected to have
 * been inlined by `resolveSpec()` upstream; only local forms resolve
 * here.
 *
 * @packageDocumentation
 */

import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { walkSubschemas } from "@oaverify/internal-schema";

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

// Percent-decode a fragment segment, tolerating a malformed `%` (leave it
// as-is rather than throwing).
function percentDecode(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve a local `$ref` against `root`. Supports the root pointer
 * (`#` / empty), JSON-pointer fragments (`#/$defs/Foo`), and plain
 * `$anchor` / `$dynamicAnchor` lookups (`#name`). Returns the target
 * node, or `undefined` if it cannot be resolved locally (an external or
 * dangling ref).
 *
 * @public
 */
export function resolveRef(root: SchemaObject, ref: string): SchemaOrBoolean | undefined {
  if (ref === "#" || ref === "") return root;
  if (ref.startsWith("#/")) {
    // A fragment is a URI: percent-decode each segment, then unescape the
    // JSON Pointer `~1` / `~0` (parity with @oaverify/internal-schema, which resolves
    // e.g. `#/$defs/Record%3Cstring%2CPerson%3E`).
    const segments = ref
      .slice(2)
      .split("/")
      .map((s) => percentDecode(s).replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur: unknown = root;
    for (const seg of segments) {
      if (Array.isArray(cur)) cur = cur[Number(seg)];
      else if (isObjectSchema(cur)) cur = (cur as Record<string, unknown>)[seg];
      else return undefined;
    }
    return cur === undefined ? undefined : (cur as SchemaOrBoolean);
  }
  if (ref.startsWith("#")) {
    const anchor = ref.slice(1);
    let found: SchemaOrBoolean | undefined;
    walkSubschemas(root, (s) => {
      if (found !== undefined) return false;
      if (isObjectSchema(s) && (s.$anchor === anchor || s.$dynamicAnchor === anchor)) {
        found = s;
        return false;
      }
      return undefined;
    });
    return found;
  }
  // An external / absolute ref that resolveSpec() did not inline.
  return undefined;
}
