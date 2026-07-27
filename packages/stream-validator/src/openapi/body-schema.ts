/**
 * Engine-free helpers for pulling a body schema out of a resolved OpenAPI
 * document and shaping it for classification: HTTP-method recognition,
 * version detection, local `$ref` following, and carrying the document's
 * `components` container so internal refs resolve.
 *
 * Kept separate from `operation.ts` (which builds a `StreamValidator` and so
 * imports the engine) so the analyzer can reuse the same extraction without
 * pulling the streaming engine into its dependency subgraph. See the
 * `./analyzer` subpath export.
 *
 * @packageDocumentation
 */

import type { OpenAPIDocument, SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import type { StreamValidatorOptions } from "../options.js";
import { resolveRef } from "../ref-resolve.js";

/** HTTP methods an OpenAPI Path Item Object may carry an operation under. */
export const HTTP_METHODS = new Set<string>([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]);

/**
 * Map an OpenAPI version string (`"3.0.3"`) to the engine's normalization
 * selector. Unknown prefixes return undefined (treated as raw JSON Schema,
 * or overridden via `options.openApiVersion`).
 */
export function versionFromDoc(openapi: string): StreamValidatorOptions["openApiVersion"] {
  if (openapi.startsWith("3.0")) return "3.0";
  if (openapi.startsWith("3.1")) return "3.1";
  if (openapi.startsWith("3.2")) return "3.2";
  return undefined;
}

export function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

/**
 * Follow a (possibly `$ref`'d) container object (a `requestBody` or a
 * `response`) to its object form. A local `#/components/...` ref is a normal
 * shape `resolveSpec` leaves in place, so resolve it here; an external ref
 * should have been inlined upstream, so surface a clear error if one
 * survived. `what` names the container in the error (`requestBody` /
 * `response`); `where` names the operation.
 */
export function resolveLocalRef<T = Record<string, unknown>>(
  doc: OpenAPIDocument,
  node: unknown,
  what: string,
  where: string,
): T {
  let current = node;
  for (let hops = 0; hops < 32; hops++) {
    if (current === null || typeof current !== "object") break;
    const ref = (current as { $ref?: unknown }).$ref;
    if (typeof ref !== "string") return current as T;
    if (!ref.startsWith("#")) {
      throw new Error(
        `external ${what} ref "${ref}" for ${where} not resolved; run resolveSpec() over the document first`,
      );
    }
    const target = resolveRef(doc as unknown as SchemaObject, ref);
    if (target === undefined) {
      throw new Error(`${what} ref "${ref}" for ${where} does not resolve`);
    }
    current = target;
  }
  throw new Error(`${what} $ref chain for ${where} exceeded 32 hops (possible cycle)`);
}

/**
 * Follow a top-level body `$ref` to its non-`$ref` node form. A bare-`$ref`
 * body schema (`{ $ref }`) cannot carry a `components` sibling: 3.0
 * `$ref`-sibling suppression (`normalizeOas30`) drops the sibling, leaving
 * the internal ref with nothing to resolve against. Dereferencing first
 * leaves a non-`$ref` root the container can sit beside, and internal refs
 * inside the target still resolve through the carried `components`. Returns
 * the schema unchanged when the top-level node is not a `$ref`, or when the
 * ref does not resolve locally (the classifier then throws a clear
 * `unresolvable $ref`).
 */
export function derefTopLevelSchemaRef(
  doc: OpenAPIDocument,
  schema: SchemaOrBoolean,
): SchemaOrBoolean {
  let current = schema;
  for (let hops = 0; hops < 32; hops++) {
    if (!isObjectSchema(current) || typeof current.$ref !== "string") return current;
    const target = resolveRef(doc as unknown as SchemaObject, current.$ref);
    if (target === undefined) return schema;
    current = target;
  }
  return schema;
}

/**
 * Shape a body schema for classification: dereference a top-level `$ref` and
 * carry the document's `components` so internal refs resolve. A boolean
 * schema needs nothing and is returned as-is.
 */
export function carryComponents(
  doc: OpenAPIDocument,
  bodySchema: SchemaOrBoolean,
): SchemaOrBoolean {
  const resolvedBody = derefTopLevelSchemaRef(doc, bodySchema);
  return isObjectSchema(resolvedBody) && doc.components !== undefined
    ? ({ ...resolvedBody, components: doc.components } as SchemaObject)
    : resolvedBody;
}
