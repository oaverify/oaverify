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
import { HTTP_METHODS } from "@oaverify/internal-core";
import type { StreamValidatorOptions } from "../options.js";
import { resolveRef } from "../ref-resolve.js";

/** HTTP methods an OpenAPI Path Item Object may carry an operation under. */
export const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

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
 * Preserve top-level document pointers outside the carried components.
 * Their targets were accepted by the original document-root dereference.
 * Keep each hop's siblings as a separate conjunct when inlining is needed.
 */
function inlineDocumentRefChain(doc: OpenAPIDocument, schema: SchemaObject): SchemaOrBoolean {
  const carried = { ...schema, components: doc.components } as SchemaObject;
  const siblings: SchemaObject[] = [];
  const seen = new Set<SchemaObject>();
  let current: SchemaOrBoolean = schema;
  let needsInlining = false;
  while (isObjectSchema(current) && typeof current.$ref === "string") {
    if (seen.has(current)) return schema;
    seen.add(current);
    const target = resolveRef(doc as unknown as SchemaObject, current.$ref);
    if (target === undefined) return schema;
    // Extraction retains the stream engine's document-root ref model;
    // relative refs are not rebound to an enclosing $id (see #1090).
    if (resolveRef(carried, current.$ref) === undefined) needsInlining = true;
    const { $ref: _ref, ...own } = current;
    if (Object.keys(own).length > 0) siblings.push(own);
    current = target;
  }
  if (!needsInlining) return schema;
  if (siblings.length === 0) return current;
  if (!isObjectSchema(current)) return { allOf: [current, ...siblings] };
  return { ...current, allOf: [...(current.allOf ?? []), ...siblings] };
}

/**
 * Shape a body schema for classification, carrying the document's
 * `components` so internal refs resolve. Modern schemas retain their ref
 * siblings. Top-level refs outside components are inlined as conjunctions
 * against the document. Classifier error paths and analyzer positions can
 * therefore name generated `allOf` branches, describing the extracted schema.
 * Under 3.0, dereference first so sibling suppression cannot discard the
 * carried container. Boolean schemas pass through unchanged.
 */
export function carryComponents(
  doc: OpenAPIDocument,
  bodySchema: SchemaOrBoolean,
  openApiVersion: StreamValidatorOptions["openApiVersion"],
): SchemaOrBoolean {
  const resolvedBody =
    openApiVersion === "3.0"
      ? derefTopLevelSchemaRef(doc, bodySchema)
      : isObjectSchema(bodySchema)
        ? inlineDocumentRefChain(doc, bodySchema)
        : bodySchema;
  return isObjectSchema(resolvedBody) && doc.components !== undefined
    ? ({ ...resolvedBody, components: doc.components } as SchemaObject)
    : resolvedBody;
}
