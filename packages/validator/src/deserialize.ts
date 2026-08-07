import {
  getOwn,
  setSpecKey,
  type ParameterObject,
  type ParameterStyle,
  type ReferenceObject,
  type SchemaObject,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";

/**
 * Deserialize a raw parameter string (from URL/header/cookie) into the
 * typed value implied by the parameter's schema + style/explode options.
 *
 * @remarks
 * Supported styles:
 * - path: `simple` (default), `label`, `matrix`
 * - query: `form` (default), `deepObject` (limited), `spaceDelimited`, `pipeDelimited`
 * - header: `simple` (default)
 * - cookie: `form` (default)
 *
 * @param raw - The raw value(s) provided for this parameter (string, array, or undefined).
 * @param parameter - The parameter definition.
 * @returns The deserialized value, ready for schema validation.
 *
 * @example
 * ```ts
 * deserialize("1,2,3", {
 *   name: "ids",
 *   in: "query",
 *   schema: { type: "array", items: { type: "integer" } },
 * });
 * // [1, 2, 3]. Without `items`, they stay strings.
 * ```
 *
 * @public
 */
export function deserialize(
  raw: string | string[] | undefined,
  parameter: ParameterObject,
): unknown {
  if (raw === undefined) return undefined;
  const style = parameter.style ?? defaultStyle(parameter.in);
  const explode = parameter.explode ?? style === "form";
  const schema = parameter.schema;
  const type = extractType(schema);

  if (Array.isArray(raw)) {
    if (type === "array") {
      const items = itemSchema(schema);
      return raw.map((v) => coerceScalar(v, items));
    }
    if (type === "object") return raw[0];
    return coerceScalar(raw[0] ?? "", schema);
  }

  if (type === "array") {
    if (raw === "") return [];
    const separator = arraySeparator(style, explode);
    const items = itemSchema(schema);
    return raw.split(separator).map((v) => coerceScalar(stripStyle(v, style), items));
  }

  if (type === "object") {
    if (style === "deepObject") return raw;
    if (explode) {
      const pairs = raw.split("&").map((kv) => kv.split("="));
      const out: Record<string, unknown> = {};
      for (const pair of pairs) setSpecKey(out, pair[0] ?? "", pair[1] ?? "");
      return out;
    }
    const parts = raw.split(",");
    const out: Record<string, unknown> = {};
    for (let i = 0; i < parts.length - 1; i += 2) {
      setSpecKey(out, parts[i] ?? "", parts[i + 1] ?? "");
    }
    return out;
  }

  return coerceScalar(stripStyle(raw, style), schema);
}

/**
 * A parameter whose schema is resolved one level down, so scalar
 * coercion can read a `type` off it.
 *
 * Coercion works by reading `type` from the schema governing a value,
 * and a `$ref` carries none, so a parameter behind one coerced nothing
 * and reported `must be integer` on input that was correct. That is not
 * an edge case: `resolveSpec` hoists external schema targets into
 * `components.schemas` and leaves an internal `$ref` at each use site,
 * and internal refs in the authored document are never inlined either.
 *
 * Three positions are followed, which is every position coercion reads:
 * the parameter's own schema, its `items`, and each entry of its
 * `properties`. Nothing deeper matters, because nothing deeper is
 * coerced.
 *
 * Built once per operation when the cache is built, rather than per
 * request: `createRefResolver` does not memoize, so resolving on the hot
 * path would re-walk a JSON pointer for every `$ref`'d parameter of
 * every request.
 *
 * Returns the parameter unchanged, identity included, when no position
 * was a `$ref`. That is the common case and it allocates nothing.
 *
 * @internal
 */
export function coercionView(
  parameter: ParameterObject,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
): ParameterObject {
  const schema = parameter.schema;
  if (schema === undefined || typeof schema === "boolean") return parameter;

  const deref = (s: SchemaOrBoolean | undefined): SchemaOrBoolean | undefined => {
    let current = s;
    // Bounded: a ref whose target is itself a ref is legal, and a cycle
    // among them would otherwise spin here. Coercion only needs a `type`,
    // so giving up and leaving the value a string is the right failure.
    for (let hops = 0; hops < 8; hops += 1) {
      if (current === undefined || typeof current === "boolean") return current;
      if (typeof current.$ref !== "string") return current;
      const next = resolveRef<SchemaOrBoolean>(current);
      if (next === undefined || next === current) return current;
      current = next;
    }
    return current;
  };

  const self = deref(schema);
  if (self === undefined || typeof self === "boolean") return parameter;

  const items = deref(self.items);
  let properties: Record<string, SchemaOrBoolean> | undefined;
  if (self.properties !== undefined) {
    for (const [name, value] of Object.entries(self.properties)) {
      const resolvedValue = deref(value);
      if (resolvedValue === value) continue;
      properties ??= { ...self.properties };
      if (resolvedValue !== undefined) setSpecKey(properties, name, resolvedValue);
    }
  }

  if (self === schema && items === self.items && properties === undefined) return parameter;
  return {
    ...parameter,
    schema: {
      ...self,
      ...(items === self.items ? {} : { items }),
      ...(properties === undefined ? {} : { properties }),
    },
  };
}

function defaultStyle(location: string): ParameterStyle {
  if (location === "query" || location === "cookie") return "form";
  return "simple";
}

function arraySeparator(style: ParameterStyle, explode: boolean): string {
  if (explode) return ","; // caller should have used Array.isArray fallthrough
  if (style === "pipeDelimited") return "|";
  // Query values reach here already URL-decoded (adapters read from
  // URLSearchParams / framework `req.query`), so a spaceDelimited
  // array arrives as space-separated text, not "%20"-separated.
  if (style === "spaceDelimited") return " ";
  return ",";
}

function stripStyle(value: string, style: ParameterStyle): string {
  if (style === "matrix" && value.startsWith(";")) return value.slice(1).split("=").pop() ?? "";
  if (style === "label" && value.startsWith(".")) return value.slice(1);
  return value;
}

function extractType(schema: SchemaObject | boolean | undefined): string | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type[0];
  return undefined;
}

/**
 * The schema governing every item of an array-typed parameter. Coercion
 * of a serialized array's items is driven by `items`, not by the array
 * schema itself: handing `coerceScalar` the array schema makes it read
 * `type: "array"` and return every item as an unchanged string.
 *
 * Returns `undefined`, leaving items as strings, when no single schema
 * governs them all:
 *
 * - `prefixItems` is present. There `items` covers only the elements
 *   past the prefix, so applying it to every element would coerce a
 *   prefix element against the wrong schema. `?a=12,3` against
 *   `prefixItems: [{type: "string"}], items: {type: "number"}` has to
 *   keep `"12"` a string.
 * - `items` is an array. No OpenAPI version permits that shape, and the
 *   compiler already reports it as a malformed schema, so this only
 *   keeps the helper total on input the caller will hear about anyway.
 *
 * A `$ref`-valued `items` also coerces nothing, since `extractType` sees
 * no `type` on it. That matches how a `$ref`-valued scalar parameter
 * schema already behaves.
 */
function itemSchema(
  schema: SchemaObject | boolean | undefined,
): SchemaObject | boolean | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  if (schema.prefixItems !== undefined) return undefined;
  const items = schema.items;
  if (Array.isArray(items)) return undefined;
  return items;
}

function coerceScalar(value: string, schema: SchemaObject | boolean | undefined): unknown {
  if (schema === undefined || typeof schema === "boolean") return value;
  const type = extractType(schema);
  if (type === "number" || type === "integer") {
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
 * Match a concrete `Content-Type` header against a set of OpenAPI media-type
 * patterns (which may use wildcards like `application/*` or `*\/*`). Returns
 * the most-specific match, or `undefined`.
 *
 * Media-type parameters (the bits after `;`) are honored on both sides:
 * a pattern like `application/json; version=1` only matches a concrete
 * `application/json; version=1` (extra parameters on the concrete side
 * are allowed). A pattern with no parameters matches any concrete type
 * that shares its type/subtype. Patterns with parameters win ties over
 * bare patterns, so a spec declaring both `application/json` and
 * `application/json; version=1` routes a versioned request to the
 * versioned entry.
 *
 * @param contentType - The concrete type (e.g. `"application/json; charset=utf-8"`).
 * @param patterns - Iterable of patterns from `content` keys.
 * @returns The matched pattern, or `undefined`.
 *
 * @public
 */
export function matchMediaType(
  contentType: string | undefined,
  patterns: Iterable<string>,
): string | undefined {
  return matchParsedMediaType(contentType, compileMediaTypePatterns(patterns));
}

/**
 * Parsed, spec-derived media-type pattern. Callers that match the same
 * OpenAPI `content` keys repeatedly can precompute these once and avoid
 * reparsing declarations on every request.
 *
 * @internal
 */
export interface ParsedMediaTypePattern {
  pattern: string;
  type: string;
  subtype: string;
  params: Record<string, string>;
  paramEntries: Array<[string, string]>;
  specificity: number;
}

/**
 * Parse OpenAPI media-type patterns once for repeated matching.
 *
 * @internal
 */
export function compileMediaTypePatterns(patterns: Iterable<string>): ParsedMediaTypePattern[] {
  const out: ParsedMediaTypePattern[] = [];
  for (const pattern of patterns) {
    const parsed = parseMediaType(pattern);
    if (parsed === undefined) continue;
    const paramEntries = Object.entries(parsed.params);
    out.push({
      pattern,
      type: parsed.type,
      subtype: parsed.subtype,
      params: parsed.params,
      paramEntries,
      specificity:
        (parsed.type === "*" ? 0 : 2) + (parsed.subtype === "*" ? 0 : 1) + paramEntries.length,
    });
  }
  return out;
}

/**
 * Match a concrete Content-Type against pre-parsed OpenAPI media-type
 * patterns. Ties preserve declaration order, matching {@link matchMediaType}.
 *
 * @internal
 */
export function matchParsedMediaType(
  contentType: string | undefined,
  patterns: readonly ParsedMediaTypePattern[],
): string | undefined {
  if (contentType === undefined) return undefined;
  const concrete = parseMediaType(contentType);
  if (concrete === undefined) return undefined;
  let best: ParsedMediaTypePattern | undefined;
  for (const parsed of patterns) {
    const typeMatch = parsed.type === "*" || parsed.type === concrete.type;
    const subtypeMatch = parsed.subtype === "*" || parsed.subtype === concrete.subtype;
    if (!typeMatch || !subtypeMatch) continue;
    let paramsMatch = true;
    for (const [k, v] of parsed.paramEntries) {
      if (getOwn(concrete.params, k) !== v) {
        paramsMatch = false;
        break;
      }
    }
    if (!paramsMatch) continue;
    if (!best || parsed.specificity > best.specificity) {
      best = parsed;
    }
  }
  return best?.pattern;
}

function parseMediaType(
  raw: string,
): { type: string; subtype: string; params: Record<string, string> } | undefined {
  const parts = raw.trim().toLowerCase().split(";");
  const head = parts[0]?.trim() ?? "";
  const [type, subtype = ""] = head.split("/");
  if (type === undefined || type === "") return undefined;
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 1) {
    const piece = parts[i]?.trim() ?? "";
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (k !== "") setSpecKey(params, k, v);
  }
  return { type, subtype, params };
}

/**
 * Find the response entry that matches a given status code, honoring the
 * OpenAPI precedence: exact status > `NXX` class > `default`.
 *
 * @param status - The response status.
 * @param responses - The operation's responses, as either a keyed
 *   object or a `Map` (the validator holds responses in a `Map`, so
 *   accepting it directly avoids an `Object.fromEntries` per call).
 * @returns The matched response key, or `undefined`.
 *
 * @public
 */
export function matchResponseKey(
  status: number,
  responses: Record<string, unknown> | Map<string, unknown>,
): string | undefined {
  const has =
    responses instanceof Map ? (k: string) => responses.has(k) : (k: string) => k in responses;
  const exact = String(status);
  if (has(exact)) return exact;
  const klass = `${Math.floor(status / 100)}XX`;
  if (has(klass)) return klass;
  if (has("default")) return "default";
  return undefined;
}
