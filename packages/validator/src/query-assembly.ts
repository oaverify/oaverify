/**
 * Query-parameter assembly helpers. OpenAPI allows a single
 * object-typed query parameter to be spread across multiple top-level
 * query keys (`style: form + explode: true` default, or `style:
 * deepObject`). Before the schema compiler can validate such a
 * parameter, the pieces have to be re-assembled into a single object.
 *
 * Extracted from validator.ts so the rules are unit-testable in
 * isolation; the end-to-end validator tests only ever see the
 * reassembled value through the schema error leaves, so edge cases
 * in the assembly logic were invisible to structural assertions.
 *
 * @packageDocumentation
 */

import type { ParameterObject, SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * Peek at the `type` keyword of a schema, returning the first string
 * type name (2020-12 allows an array). Returns `undefined` for boolean
 * schemas, absent types, or unexpected shapes.
 *
 * @internal
 */
export function extractSchemaType(schema: SchemaOrBoolean | undefined): string | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  const t = (schema as { type?: unknown }).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t))
    return (t as unknown[]).find((x) => typeof x === "string") as string | undefined;
  return undefined;
}

/**
 * Peek at the `properties` map of an object schema. Returns
 * `undefined` if the schema isn't a JSON-object-valued schema with a
 * well-formed `properties` record.
 *
 * @internal
 */
export function extractObjectProperties(
  schema: SchemaOrBoolean | undefined,
): Record<string, SchemaOrBoolean> | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  const props = (schema as { properties?: unknown }).properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return undefined;
  return props as Record<string, SchemaOrBoolean>;
}

/**
 * Coerce a raw query-string scalar into the JS type a numeric or
 * boolean schema expects. Strings and unknown types pass through.
 *
 * @internal
 */
export function coerceQueryScalar(value: string | undefined, schema: SchemaOrBoolean): unknown {
  if (value === undefined) return undefined;
  if (typeof schema === "boolean") return value;
  const type = extractSchemaType(schema);
  if (type === "integer" || type === "number") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  return value;
}

/**
 * Gather `name[key]=value` pairs from the top-level query into an
 * object: the `style: deepObject` assembly. Single-level only:
 * OpenAPI 3.0–3.2 do not define nested semantics, so `obj[a][b]=v`
 * yields a property literally named `a][b`.
 *
 * @internal
 */
export function assembleDeepObject(
  name: string,
  query: Record<string, string | string[]> | undefined,
): Record<string, unknown> | undefined {
  if (query === undefined) return undefined;
  const prefix = `${name}[`;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(query)) {
    if (!k.startsWith(prefix) || !k.endsWith("]")) continue;
    const propName = k.slice(prefix.length, -1);
    out[propName] = Array.isArray(v) ? v[0] : v;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Reassemble a `style: form + explode: true` object query param:
 * each declared property appears as its own top-level key.
 *
 * @internal
 */
export function assembleFormExplodedObject(
  schema: SchemaOrBoolean | undefined,
  query: Record<string, string | string[]> | undefined,
): Record<string, unknown> | undefined {
  if (query === undefined) return undefined;
  const props = extractObjectProperties(schema);
  if (props === undefined) return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [propName, propSchema] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(query, propName)) continue;
    const raw = query[propName];
    out[propName] = coerceQueryScalar(Array.isArray(raw) ? raw[0] : raw, propSchema);
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Dispatch an object-typed query parameter to the appropriate
 * assembler (`deepObject` or `form+explode`). Returns `undefined`
 * when the parameter isn't object-typed; caller should fall through
 * to the standard scalar/array deserialization path.
 *
 * When the parameter IS object-typed but no matching query keys are
 * present, returns `{ value: undefined }` so the caller can treat it
 * as absent.
 *
 * @internal
 */
export function assembleObjectQueryParam(
  p: ParameterObject,
  query: Record<string, string | string[]> | undefined,
): { value: unknown } | undefined {
  if (p.in !== "query") return undefined;
  const schemaType = extractSchemaType(p.schema);
  if (schemaType !== "object") return undefined;
  const style = p.style ?? "form";
  const explode = p.explode ?? style === "form";
  if (style === "deepObject") {
    return { value: assembleDeepObject(p.name, query) };
  }
  if (style === "form" && explode) {
    return { value: assembleFormExplodedObject(p.schema, query) };
  }
  return undefined;
}
