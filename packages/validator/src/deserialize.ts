import type { ParameterObject, ParameterStyle, SchemaObject } from "@oaverify/internal-core";

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
 * deserialize("1,2,3", { name: "ids", in: "query", schema: { type: "array" } });
 * // [1, 2, 3]
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
    if (type === "array") return raw.map((v) => coerceScalar(v, schema));
    if (type === "object") return raw[0];
    return coerceScalar(raw[0] ?? "", schema);
  }

  if (type === "array") {
    if (raw === "") return [];
    const separator = arraySeparator(style, explode);
    return raw.split(separator).map((v) => coerceScalar(stripStyle(v, style), schema));
  }

  if (type === "object") {
    if (style === "deepObject") return raw;
    if (explode) {
      const pairs = raw.split("&").map((kv) => kv.split("="));
      const out: Record<string, unknown> = {};
      for (const pair of pairs) out[pair[0] ?? ""] = pair[1] ?? "";
      return out;
    }
    const parts = raw.split(",");
    const out: Record<string, unknown> = {};
    for (let i = 0; i < parts.length - 1; i += 2) {
      out[parts[i] ?? ""] = parts[i + 1] ?? "";
    }
    return out;
  }

  return coerceScalar(stripStyle(raw, style), schema);
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
      if (concrete.params[k] !== v) {
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
    if (k !== "") params[k] = v;
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
