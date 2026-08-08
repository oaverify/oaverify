import { effectiveType } from "./schema-type.js";
import {
  getOwn,
  setSpecKey,
  type HttpRequest,
  type ParameterObject,
  type ParameterStyle,
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
  const type = effectiveType(schema);

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
    const items = itemSchema(schema);
    // Label and matrix arrays strip their style prefix from the whole
    // token before splitting; splitting first and stripping per item
    // read every exploded form wrong (".a.b.c" as one element,
    // ";c=a;c=b" as ["b"]). RFC 6570 gives each form its shape:
    // {.list} is ".a,b,c", {.list*} is ".a.b.c", {;list} is ";c=a,b,c",
    // {;list*} is ";c=a;c=b;c=c".
    if (style === "label") {
      const body = raw.startsWith(".") ? raw.slice(1) : raw;
      if (body === "") return [];
      return body.split(explode ? "." : ",").map((v) => coerceScalar(v, items));
    }
    if (style === "matrix") {
      if (explode) {
        const values: string[] = [];
        for (const group of raw.split(";")) {
          if (group === "") continue;
          const eq = group.indexOf("=");
          const groupName = eq === -1 ? group : group.slice(0, eq);
          // A group naming some other parameter is not one of ours;
          // RFC 6570 never emits one here, so it contributes nothing.
          if (groupName !== parameter.name) continue;
          values.push(eq === -1 ? "" : group.slice(eq + 1));
        }
        return values.map((v) => coerceScalar(v, items));
      }
      const body = stripStyle(raw, style);
      if (body === "") return [];
      return body.split(",").map((v) => coerceScalar(v, items));
    }
    const separator = arraySeparator(style, explode);
    return raw.split(separator).map((v) => coerceScalar(stripStyle(v, style), items));
  }

  if (type === "object") {
    if (style === "deepObject") return raw;
    if (explode) {
      const out: Record<string, unknown> = {};
      for (const kv of raw.split("&")) {
        // Split at the first "=" only: the value may carry more of them
        // (base64 padding, a nested pair), and `kv.split("=")[1]` was
        // silently truncating "token=a=b" to "a".
        const eq = kv.indexOf("=");
        if (eq === -1) setSpecKey(out, kv, "");
        else setSpecKey(out, kv.slice(0, eq), kv.slice(eq + 1));
      }
      return out;
    }
    const parts = raw.split(",");
    const out: Record<string, unknown> = {};
    for (let i = 0; i < parts.length; i += 2) {
      // An odd part count is malformed serialization; giving the
      // trailing key an empty value keeps the defect visible to schema
      // validation, where dropping the key hid it entirely.
      setSpecKey(out, parts[i] ?? "", parts[i + 1] ?? "");
    }
    return out;
  }

  return coerceScalar(stripStyle(raw, style), schema);
}

/**
 * Resolves one `$ref` hop for {@link coercionView}, through whatever
 * resolver the caller compiles schemas with. May throw when the
 * reference cannot be resolved.
 *
 * @internal
 */
export type SchemaRefResolver = (schema: SchemaObject) => SchemaOrBoolean | undefined;

/**
 * Bind a {@link SchemaRefResolver} to a resolved schema graph.
 *
 * The base URI is what makes this agree with the compiler, which resolves
 * every `$ref` as `resolve(ref, schemaBaseUri.get(schema) ?? baseUri)`.
 * Dropping it resolves against the document root instead, which usually
 * throws and costs only the coercion, and lands on a different real node
 * when the root has something at the same pointer or when the ref is an
 * anchor. A silently wrong coercion type is worse than none, so the two
 * resolve the same way or the point of doing this at all is lost.
 *
 * One factory rather than a copy per call site, so the binding cannot
 * drift between `createValidator`, the AOT emitter and the tests.
 *
 * @internal
 */
export function schemaRefResolverFor(
  refResolver: { resolve: (ref: string, fromBaseUri?: string) => SchemaOrBoolean },
  graph: { baseUri: string; schemaBaseUri: WeakMap<object, string> },
): SchemaRefResolver {
  return (schema) =>
    refResolver.resolve(schema.$ref as string, graph.schemaBaseUri.get(schema) ?? graph.baseUri);
}

/**
 * Ref hops {@link coercionView} will follow before giving up.
 *
 * Matches `REF_CHAIN_MAX_HOPS` in `operation-cache.ts`, which bounds the
 * same thing for the resolver the rest of the cache uses. A tighter
 * bound here would reinstate the divergence this view exists to close:
 * the compiler would resolve a long chain and coercion would not.
 */
const MAX_REF_HOPS = 32;

/**
 * A parameter whose schema is resolved one level down, so scalar
 * coercion can read a `type` off it.
 *
 * Coercion works by reading `type` from the schema governing a value,
 * and a `$ref` carries none, so a parameter behind one coerced nothing
 * and reported `must be integer` on input that was correct. This is the
 * ordinary shape: `resolveSpec` hoists external schema targets into
 * `components.schemas` and leaves an internal `$ref` at each use site,
 * and internal refs in the authored document are never inlined either.
 *
 * Three positions are followed, which is every position coercion reads:
 * the parameter's own schema, its `items`, and each entry of its
 * `properties`. Nothing deeper matters, because nothing deeper is
 * coerced.
 *
 * Composition is not followed. `effectiveType` reads `type` and nothing
 * else, so a type reachable only through `allOf`, `oneOf` or `anyOf` is
 * invisible here and the value stays a string. `allOf` is a conjunction
 * and could be flattened; `oneOf` and `anyOf` cannot, since branches may
 * disagree on the type and coercion has to pick one before validation
 * says which branch applies.
 *
 * Sibling handling follows the dialect, because the compiler's does.
 * Under 2020-12 a `$ref`'s siblings are a conjunction and the view
 * merges them in, use site winning. Under OAS 3.0
 * (`refSuppressesSiblings`) the compiler ignores every sibling, so the
 * view ignores them too: merging read a `type` the compiler never
 * enforces, and `{ $ref: Id, type: "string" }` compiled as integer but
 * coerced as string, rejecting `?n=42` on correct input.
 *
 * Built once per operation when the cache is built, rather than per
 * request: `createRefResolver` does not memoize, so resolving on the hot
 * path would re-walk a JSON pointer for every `$ref`'d parameter of
 * every request.
 *
 * The resolver is the one the schema compiler uses, so the two agree on
 * what a ref points at. They did not: coercion went through the
 * pointer-only resolver, which cannot follow an `$id`-based target, so a
 * parameter behind one compiled against the right schema and coerced
 * against nothing.
 *
 * Returns the parameter unchanged, identity included, when no position
 * was a `$ref`. That is the common case, and it allocates no new
 * parameter or schema object.
 *
 * @internal
 */
export interface CoercionViewOptions {
  /**
   * OAS 3.0 semantics: every sibling keyword of a `$ref` is ignored,
   * matching `DialectRules.refSuppressesSiblings` in the compiler.
   * Default `false` (2020-12 semantics, siblings merge).
   */
  refSuppressesSiblings?: boolean;
}

export function coercionView(
  parameter: ParameterObject,
  resolveSchemaRef: SchemaRefResolver,
  options?: CoercionViewOptions,
): ParameterObject {
  const schema = parameter.schema;
  if (schema === undefined || typeof schema === "boolean") return parameter;

  // One hop per call, so a chain needs the loop. Bounded: a cycle would
  // spin here otherwise, and giving up leaves the value a string, which
  // is the right failure for a schema that never yields a `type`. The
  // `next === current` guard catches a self-cycle early; a longer cycle
  // ends on the hop budget.
  //
  // Siblings are merged at every hop, not only at the use site. 2020-12
  // reads a `$ref`'s siblings as a conjunction, and the compiler honours
  // each one, so `{ $ref: C, items: X }` reached through another ref has
  // to keep its `items` or the two disagree.
  //
  // The resolver throws on a ref it cannot resolve. Coercion is
  // best-effort by construction, so that is not a reason to fail the
  // build: the compiler resolves and validates the same schema through
  // the same resolver, and only the coercion is lost.
  const keepSiblings = options?.refSuppressesSiblings !== true;
  const resolveChain = (s: SchemaOrBoolean | undefined): SchemaOrBoolean | undefined => {
    if (s === undefined || typeof s === "boolean" || typeof s.$ref !== "string") return s;
    // Outermost first, so the use site is applied last and wins. Under
    // a sibling-suppressing dialect the array stays empty and only the
    // chain's final target survives, matching the compiler.
    const siblingLayers: SchemaObject[] = [];
    let current: SchemaOrBoolean = s;
    for (let hops = 0; hops < MAX_REF_HOPS; hops += 1) {
      if (typeof current === "boolean" || typeof current.$ref !== "string") break;
      const { $ref: _ref, ...siblings } = current;
      if (keepSiblings && Object.keys(siblings).length > 0) {
        siblingLayers.push(siblings as SchemaObject);
      }
      let next: SchemaOrBoolean | undefined;
      try {
        next = resolveSchemaRef(current);
      } catch {
        break;
      }
      if (next === undefined || next === current) break;
      current = next;
    }
    if (typeof current === "boolean") return current;
    let out: SchemaObject = current;
    for (let i = siblingLayers.length - 1; i >= 0; i -= 1) {
      out = { ...out, ...siblingLayers[i] };
    }
    return out;
  };

  const self = resolveChain(schema);
  if (self === undefined || typeof self === "boolean") return parameter;

  const items = resolveChain(self.items);
  let properties: Record<string, SchemaOrBoolean> | undefined;
  if (self.properties !== undefined) {
    for (const [name, value] of Object.entries(self.properties)) {
      const resolvedValue = resolveChain(value);
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

/**
 * Fold a query string embedded in `path` into the `query` field.
 *
 * The router strips `?...` before matching, so `path: "/w?n=abc"`
 * routed while the parameters in it went unvalidated: optional ones
 * silently, required ones with a false "missing" report. Every HTTP
 * framework hands the caller exactly that combined string, so parsing
 * it is what a hand-built request means.
 *
 * An explicit `query` field wins and the embedded string is ignored:
 * two sources that can disagree is the trap the `contentType` field's
 * design already refuses, and the explicit field is the deliberate
 * one. No `?` in the path, or an explicit `query`, returns the request
 * unchanged by identity.
 *
 * Parsed with `URLSearchParams` and repeated keys collapsed into
 * arrays, matching `httpRequestFromFetch`.
 *
 * Called at the top of `validateRequest` in both the interpreted
 * validator and the `oaverify compile-spec` emitted module, which is
 * why it lives on the codegen-runtime surface.
 *
 * @internal
 */
export function normalizeRequestQuery(req: HttpRequest): HttpRequest {
  const q = req.path.indexOf("?");
  const hash = req.path.indexOf("#");
  // A "?" inside a fragment ("/w#f?x=1") opens no query, and a
  // fragment after one ("/w?n=42#frag") is not part of the last value;
  // the router cuts both the same way before matching.
  if (q === -1 || (hash !== -1 && hash < q) || req.query !== undefined) return req;
  const query: Record<string, string | string[]> = {};
  const params = new URLSearchParams(req.path.slice(q + 1, hash === -1 ? undefined : hash));
  for (const key of new Set(params.keys())) {
    if (key === "") continue;
    const values = params.getAll(key);
    setSpecKey(query, key, values.length === 1 ? (values[0] ?? "") : values);
  }
  return { ...req, path: req.path.slice(0, q), query };
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
  if (style === "matrix" && value.startsWith(";")) {
    // Drop the ";name=" prefix and nothing more: `.split("=").pop()`
    // returned the text after the *last* "=", truncating a value that
    // carries one (";v=a=b" read as "b").
    const rest = value.slice(1);
    const eq = rest.indexOf("=");
    return eq === -1 ? rest : rest.slice(eq + 1);
  }
  if (style === "label" && value.startsWith(".")) return value.slice(1);
  return value;
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
 * A `$ref`-valued `items` also coerces nothing, since `effectiveType`
 * sees no `type` on it. That matches how a `$ref`-valued scalar parameter
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

/**
 * A decimal number as a query or path value spells one: optional sign,
 * digits with an optional fraction (or a bare fraction), optional
 * exponent. Deliberately wider than JSON's grammar (`+5`, `.5`, `5.`,
 * and `007` all coerce; a URL is not JSON and clients emit all four)
 * and deliberately narrower than `Number()`, which reads `""` and
 * whitespace as 0, `0x1A` as 26, and `Infinity` as a number a
 * `type: number` schema then accepts. None of those is a decimal
 * number the client plausibly meant, so each stays a string and fails
 * the type check instead of validating as a value it never sent.
 */
const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function coerceScalar(value: string, schema: SchemaObject | boolean | undefined): unknown {
  if (schema === undefined || typeof schema === "boolean") return value;
  const type = effectiveType(schema);
  if (type === "number" || type === "integer") {
    if (!DECIMAL_NUMBER_RE.test(value)) return value;
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
