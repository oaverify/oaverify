/**
 * Local `$ref` resolution against a resolved document root. Shared by the
 * classifier (which throws on an unresolvable ref) and the spine (which
 * follows refs at validation time). External refs are expected to have
 * been inlined by `resolveSpec()` upstream; only local forms resolve
 * here.
 *
 * @packageDocumentation
 */

import {
  pointerFromFragment,
  resolveJsonPointer,
  type SchemaObject,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { walkSubschemas } from "@oaverify/internal-schema";

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
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
    try {
      return resolveJsonPointer(root, pointerFromFragment(ref.slice(1))) as SchemaOrBoolean;
    } catch {
      return undefined;
    }
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
