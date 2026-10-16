import {
  pointerFromFragment,
  resolveJsonPointer,
  setSpecKey,
  type OpenAPIDocument,
  type PathItem,
} from "@oaverify/internal-core";
import { resolveOperationRef } from "./operation-cache.js";

/** An effective Path Item with its field declarations located. @internal */
export interface ResolvedPathItem {
  readonly item: PathItem;
  /**
   * Field name to the declaring Path Item's pointer. Unreferenced items
   * have an empty map; their fields belong to the supplied entry pointer.
   */
  readonly origins: ReadonlyMap<string, string>;
}

/**
 * Combine the fields declared along a Path Item reference chain.
 * Reference validity and the hop limit match the operation resolver.
 * `pointer` locates the entry; each winning field records the pointer
 * of the Path Item that declares it so findings can address that hop.
 *
 * @internal
 *
 * @specCites OpenAPI 3.1.0 Path Item Object, https://spec.openapis.org/oas/v3.1.0.html#path-item-object
 * @specBoundary resolves https://spec.openapis.org/oas/v3.1.0.html#path-item-object
 * OpenAPI leaves behavior undefined when a field appears both beside a
 * Path Item `$ref` and in its target. Standalone compilation and its
 * parameter-location checks keep the nearest declaration of that field;
 * fields found only in a target are
 * inherited. Arrays such as `parameters` are replaced as a whole.
 */
export function resolvePathItem(
  document: OpenAPIDocument,
  item: PathItem & { $ref?: string },
  pointer = "",
): ResolvedPathItem | undefined {
  const terminal = resolveOperationRef<PathItem>(document, item);
  if (terminal == null) return undefined;
  const origins = new Map<string, string>();
  if (item == null || typeof item.$ref !== "string") return { item: terminal, origins };
  const merged: Record<string, unknown> = {};
  let current: (PathItem & { $ref?: string }) | undefined = item;
  while (current != null) {
    for (const [key, value] of Object.entries(current)) {
      if (key !== "$ref" && !Object.hasOwn(merged, key)) {
        setSpecKey(merged, key, value);
        origins.set(key, pointer);
      }
    }
    if (current === terminal || typeof current.$ref !== "string") break;
    pointer = pointerFromFragment(current.$ref.slice(1));
    current = resolveJsonPointer(document, pointer) as PathItem & { $ref?: string };
  }
  return { item: merged as PathItem, origins };
}
