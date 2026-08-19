/**
 * Parameter assembly helpers. OpenAPI allows a single object-typed
 * parameter to be spread across several wire keys rather than living
 * under one: a query parameter with `style: form + explode: true` (the
 * default) or `style: deepObject`, and from OpenAPI 3.2 a cookie
 * parameter with `style: cookie`, whose exploded form writes one crumb
 * per property. Before the schema compiler can validate such a
 * parameter, the pieces have to be re-assembled into a single object.
 *
 * Extracted from validator.ts so the rules are unit-testable in
 * isolation; the end-to-end validator tests only ever see the
 * reassembled value through the schema error leaves, so edge cases
 * in the assembly logic were invisible to structural assertions.
 *
 * @packageDocumentation
 */

import {
  getOwn,
  setSpecKey,
  type ParameterObject,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { coerceScalar, propertySchemas } from "./deserialize.js";
import { effectiveType } from "./schema-type.js";

/**
 * Peek at the `properties` map of an object schema. Returns
 * `undefined` if the schema isn't a JSON-object-valued schema with a
 * well-formed `properties` record.
 *
 * One reader, in `deserialize.ts` beside the `items` equivalent, because
 * the assembled and the deserialized object paths have to agree on what
 * a declared property type means (#824). This name is the one the
 * assemblers below read with.
 *
 * @internal
 */
export const extractObjectProperties = propertySchemas;

/**
 * Coerce a raw query-string scalar into the JS type a numeric or
 * boolean schema expects. Strings and unknown types pass through.
 *
 * A property of an assembled object parameter is the same lexeme a
 * scalar parameter carries, so it reads by the same rules: this is
 * {@link coerceScalar} plus the absent case. Before #751 it called bare
 * `Number()`, and `?filter[n]=0x1A` validated as 26 against a
 * `type: integer` property that `?n=0x1A` rejected.
 *
 * @internal
 */
export function coerceQueryScalar(value: string | undefined, schema: SchemaOrBoolean): unknown {
  if (value === undefined) return undefined;
  return coerceScalar(value, schema);
}

/**
 * Gather `name[key]=value` pairs from the top-level query into an
 * object: the `style: deepObject` assembly. Single-level only:
 * OpenAPI 3.0–3.2 do not define nested semantics, so `obj[a][b]=v`
 * yields a property literally named `a][b`.
 *
 * Values are coerced with the matching entry in the parameter schema's
 * `properties`, matching what {@link assembleFormExplodedObject} does for
 * the `form` + `explode` shape. A property the schema does not declare
 * stays a string, so an unschema'd `deepObject` assembles as it always did.
 *
 * @internal
 */
export function assembleDeepObject(
  name: string,
  query: Record<string, string | string[]> | undefined,
  schema?: SchemaOrBoolean,
): Record<string, unknown> | undefined {
  if (query === undefined) return undefined;
  const prefix = `${name}[`;
  const props = extractObjectProperties(schema);
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(query)) {
    if (!k.startsWith(prefix) || !k.endsWith("]")) continue;
    const propName = k.slice(prefix.length, -1);
    const raw = Array.isArray(v) ? v[0] : v;
    const propSchema = getOwn(props, propName);
    setSpecKey(out, propName, propSchema === undefined ? raw : coerceQueryScalar(raw, propSchema));
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
    if (!Object.hasOwn(query, propName)) continue;
    const raw = query[propName];
    setSpecKey(out, propName, coerceQueryScalar(Array.isArray(raw) ? raw[0] : raw, propSchema));
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
  const schemaType = effectiveType(p.schema);
  if (schemaType !== "object") return undefined;
  const style = p.style ?? "form";
  const explode = p.explode ?? style === "form";
  if (style === "deepObject") {
    return { value: assembleDeepObject(p.name, query, p.schema) };
  }
  if (style === "form" && explode) {
    return { value: assembleFormExplodedObject(p.schema, query) };
  }
  return undefined;
}

/**
 * The cookie-location sibling of {@link assembleObjectQueryParam}, for
 * OpenAPI 3.2's `style: cookie`. Its exploded form (the default for
 * that style) drops the parameter name and writes one crumb per
 * property, so `Cookie: R=100; G=200` carries the whole of `p`, and
 * nothing is stored under `p` itself.
 *
 * Returns `undefined` when the parameter is not that shape, and the
 * caller falls through to the ordinary by-name lookup. When it is that
 * shape but no declared property arrived, the result is
 * `{ value: undefined }`, which the caller reads as absent.
 *
 * A schema declaring no `properties` is the first of those, not the
 * second: with nothing to name the crumbs, this cannot tell which of
 * them belong to `p`, and claiming the parameter would report every
 * such request missing. The by-name path still reads a crumb literally
 * called `p`, which is what a caller sending one meant, and
 * `deserialize` splits it on the style's own delimiter.
 *
 * `style: form` in a cookie is deliberately not assembled here, on
 * either version. Appendix D says form "is always incorrect" in a
 * cookie for multiple values, so no reading of an exploded form object
 * is the specified one, and guessing at a value is worse than reporting
 * the parameter the caller can see is missing. `style: cookie` is the
 * declaration that asks for this and gets it.
 *
 * @internal
 */
export function assembleObjectCookieParam(
  p: ParameterObject,
  cookies: Record<string, string | string[]> | undefined,
): { value: unknown } | undefined {
  if (p.in !== "cookie") return undefined;
  if (p.style !== "cookie") return undefined;
  if (effectiveType(p.schema) !== "object") return undefined;
  // `cookie` defaults explode to true, the way `form` does; an
  // explicit `explode: false` joins the pairs under the parameter's own
  // name instead, which is the ordinary by-name path.
  if (p.explode === false) return undefined;
  if (extractObjectProperties(p.schema) === undefined) return undefined;
  return { value: assembleFormExplodedObject(p.schema, cookies) };
}
