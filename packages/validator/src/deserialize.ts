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
 * - cookie: `form` (default), `cookie` (OpenAPI 3.2 and later)
 *
 * @param raw - The raw value(s) provided for this parameter (string, array, or undefined).
 * @param parameter - The parameter definition.
 * @returns The deserialized value, ready for schema validation, or
 * `undefined` when the parameter has no value. That covers `raw` being
 * `undefined`, and two wire cases, both of which say the token is not
 * an expansion of this parameter in its declared style:
 *
 * - The token carries none of the style's framing: a `style: label`
 *   value not opening with "." or a `style: matrix` segment not opening
 *   with ";". So `"abc"` against either is an absent `p`, not a `p` of
 *   `"abc"`.
 * - A framed `style: matrix` segment whose groups all name some other
 *   parameter (see `matrixGroupValues`), which makes `;q=1` an absent
 *   `p` rather than a `p` of `"1"`.
 *
 * Callers treat all three the same way. A caller reporting a missing
 * required parameter has to test the style as well as the value,
 * because an object-typed parameter handed an empty array reads
 * `undefined` too and that is not absence; `validateParameter` in
 * `validate-step.ts` is the reference.
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
  const explode = parameter.explode ?? defaultExplode(style);
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

  // Every `label` expansion opens with "." and every `matrix` segment
  // with ";", whatever the schema type and whatever `explode` says, so
  // a token carrying neither is not an expansion of this parameter in
  // its declared style. Reporting the parameter absent is the only
  // answer that rejects whatever the schema says: reading the token as
  // the value satisfies `type: string`, and splitting it satisfies an
  // unbounded `type: array` (#789).
  //
  // This is the same shape of rule as the group-name check below and
  // was split out of it (#758): that one rejects a segment framed for
  // some other parameter, this one a token framed for no style at all.
  // Both styles are held to it together, because they had agreed with
  // each other on the tolerant reading and tightening one alone would
  // have ended that.
  if (style === "label" && !raw.startsWith(".")) return undefined;
  if (style === "matrix" && !raw.startsWith(";")) return undefined;

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
      const groups = matrixGroupValues(raw, parameter.name);
      if (groups === undefined) return undefined;
      // {;list*} is one group per element; {;list} is one group whose
      // value is the comma-joined list. A second group in the
      // non-explode form is not a shape RFC 6570 emits, so the first
      // one supplies the parameter and the rest are ignored, matching
      // how a repeated scalar resolves below.
      if (explode) return groups.map((v) => coerceScalar(v, items));
      const body = groups[0] ?? "";
      if (body === "") return [];
      return body.split(",").map((v) => coerceScalar(v, items));
    }
    if (style === "cookie" && explode) {
      // One crumb is one element. The style escapes nothing, so a comma
      // inside the value is part of the value, and the elements that
      // would follow it live under a repeat of the name that
      // `HttpRequest.cookies` cannot carry (#826). Reading the crumb as
      // a comma-joined list would invent elements the wire never
      // separated.
      return [coerceScalar(raw, items)];
    }
    const separator = arraySeparator(style, explode);
    return raw.split(separator).map((v) => coerceScalar(stripStyle(v, style), items));
  }

  if (type === "object") {
    if (style === "deepObject") return raw;
    // Strip the style's framing from the whole token before splitting,
    // the way the array branch above does and for the same reason: an
    // exploded label object separates its pairs with the dot that also
    // opens the segment, so stripping per part would eat the separator.
    let body = raw;
    if (style === "matrix") {
      if (explode) {
        // {;keys*} is ";R=100;G=200": the group names are the object's
        // property names, not the parameter's, so the "a group must
        // name this parameter" rule `matrixGroupValues` applies does
        // not hold here and it is the wrong reader.
        body = raw.startsWith(";") ? raw.slice(1) : raw;
      } else {
        // {;keys} is ";p=R,100,G,200": one group, named for the
        // parameter, carrying the flat list. Same reader as the scalar
        // and array shapes, absence included.
        const groups = matrixGroupValues(raw, parameter.name);
        if (groups === undefined) return undefined;
        body = groups[0] ?? "";
      }
    } else if (style === "label") {
      body = raw.startsWith(".") ? raw.slice(1) : raw;
    }
    const separator = objectSeparator(style, explode);
    const props = propertySchemas(schema);
    const out: Record<string, unknown> = {};
    if (explode) {
      for (const kv of body.split(separator)) {
        // Split at the first "=" only: the value may carry more of them
        // (base64 padding, a nested pair), and `kv.split("=")[1]` was
        // silently truncating "token=a=b" to "a".
        const eq = kv.indexOf("=");
        const key = eq === -1 ? kv : kv.slice(0, eq);
        setSpecKey(out, key, coerceProperty(eq === -1 ? "" : kv.slice(eq + 1), key, props));
      }
      return out;
    }
    const parts = body.split(separator);
    for (let i = 0; i < parts.length; i += 2) {
      // An odd part count is malformed serialization; giving the
      // trailing key an empty value keeps the defect visible to schema
      // validation, where dropping the key hid it entirely.
      const key = parts[i] ?? "";
      setSpecKey(out, key, coerceProperty(parts[i + 1] ?? "", key, props));
    }
    return out;
  }

  if (style === "matrix") {
    const groups = matrixGroupValues(raw, parameter.name);
    if (groups === undefined) return undefined;
    // First wins, as it does for a repeated query parameter above
    // (`raw[0]`). `;p=1;p=2` against a scalar is not a shape RFC 6570
    // emits; reading it as the whole tail gave the handler "1;p=2".
    return coerceScalar(groups[0] ?? "", schema);
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
 * Options for {@link coercionView}.
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

/**
 * What `explode` means when a parameter leaves it out. `form` and, from
 * OpenAPI 3.2, `cookie` default it to true; every other style defaults
 * it to false.
 *
 * Read alongside {@link defaultStyle}: that one answers what a
 * parameter's style is when unstated, this one what its explode is.
 * `cookie` is never the answer to the first, since 3.2 keeps `form` as
 * the default style in a cookie for compatibility, so a parameter
 * reaches the true arm here only by declaring `style: cookie` itself.
 *
 * @internal
 */
function defaultExplode(style: ParameterStyle): boolean {
  return style === "form" || style === "cookie";
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

/**
 * The character separating one piece of a serialized object from the
 * next, per the Style Examples table's object column.
 *
 * Read alongside {@link arraySeparator}, which answers the same question
 * for the array column. They differ on `label` and `matrix`: an array's
 * exploded form repeats the style's own token (`.a.b.c`, `;p=a;p=b`)
 * and `arraySeparator` never sees it, because those two styles are
 * handled before it is consulted. The object arms route through here
 * for every style, so it carries both columns.
 *
 * `pipeDelimited` and `spaceDelimited` have no exploded object row: the
 * table marks it _n/a_, so nothing settles what `explode: true` means
 * there. Keeping the style's own delimiter is the reading that leaves
 * the two arms agreeing about which character belongs to the style;
 * `form`'s "&" is the one thing it could not be.
 */
function objectSeparator(style: ParameterStyle, explode: boolean): string {
  if (style === "label") return explode ? "." : ",";
  if (style === "matrix") return explode ? ";" : ",";
  if (style === "pipeDelimited") return "|";
  if (style === "spaceDelimited") return " ";
  if (style === "simple") return ",";
  // RFC 6265 delimits crumbs with "; ", which is what `style: cookie`
  // adopts and the one thing that separates it from `form`. The
  // exploded arm is reached when a caller hands the pairs over joined,
  // under a crumb literally named for the parameter: a request whose
  // cookies were split into a record instead takes
  // `assembleObjectCookieParam`, which reads them as separate crumbs
  // and never arrives here.
  if (style === "cookie") return explode ? "; " : ",";
  // `form`, in query and cookie, and any style not named above.
  return explode ? "&" : ",";
}

function stripStyle(value: string, style: ParameterStyle): string {
  if (style === "label" && value.startsWith(".")) return value.slice(1);
  return value;
}

/**
 * The values carried by the groups of a `style: matrix` segment that
 * name this parameter; `undefined` when none do. Callers hand it a
 * segment `deserialize` has already checked opens with ";".
 *
 * RFC 6570 §3.2.7 gives every matrix form the same frame: a segment is
 * a run of `;name=value` groups, and a group's name says which
 * parameter it supplies. `{;p}` is `;p=1`, `{;list}` is `;p=1,2`, and
 * `{;list*}` is `;p=1;p=2`, so one reader serves all three and the
 * shape-specific work (splitting on "," , taking a scalar) is what
 * differs afterwards.
 *
 * `undefined` rather than an empty list is the load-bearing part. A
 * segment naming only other parameters supplies no value for this one,
 * which is the parameter being absent, and absence is the only answer
 * that rejects for every schema type: returning `[]` satisfies
 * `required` plus an unbounded `type: array`, and returning the segment
 * unread satisfies `type: string`. Both were accept-invalid (#758).
 *
 * A group with no "=" carries the empty value, per the same section:
 * `{;p}` against "" expands to `;p`. Reading its name as the value was
 * how `;p` reached a handler as "p".
 *
 * A ";" inside a value cannot survive this, and nothing here can fix
 * it: RFC 6570 requires the client to percent-encode one, the router
 * decodes the path token before any of this runs, and a decoded ";" is
 * then indistinguishable from a group delimiter. `;p=a%3Bb` reads as
 * "a". The explode arm has always split on ";" and behaved this way;
 * the other arms kept everything after the first "=" and now agree
 * with it. Splitting before decoding is the only real fix and belongs
 * in the router, not here.
 */
function matrixGroupValues(raw: string, name: string): string[] | undefined {
  // Unreachable: `deserialize` rejects an unframed segment before any
  // of the three call sites is taken. Kept so the reader is total on
  // its own terms rather than only in the context of its callers.
  if (!raw.startsWith(";")) return undefined;
  const values: string[] = [];
  for (const group of raw.split(";")) {
    if (group === "") continue;
    const eq = group.indexOf("=");
    // A group naming some other parameter is not one of ours; RFC 6570
    // never emits one here, so it contributes nothing.
    if ((eq === -1 ? group : group.slice(0, eq)) !== name) continue;
    // Split at the first "=" only: the value may carry more of them,
    // and taking the text after the last one truncated ";v=a=b" to "b".
    values.push(eq === -1 ? "" : group.slice(eq + 1));
  }
  return values.length === 0 ? undefined : values;
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
 * The `properties` map of an object-typed parameter's schema, or
 * `undefined` when there is no well-formed one to read. The object
 * counterpart of {@link itemSchema}, and read for the same reason: a
 * serialized object's property values are governed by `properties`, not
 * by the object schema itself, so coercing against the parameter schema
 * makes `effectiveType` read `type: "object"` and return every property
 * as an unchanged string (#824).
 *
 * Shared with `extractObjectProperties` in `param-assembly.ts`, which
 * re-exports this. The two paths that assemble an object from top-level
 * query keys already read `properties`; this is what lets the path that
 * deserializes one from a single token read the same map, so a property
 * type means the same thing whichever route the parameter took.
 *
 * @internal
 */
export function propertySchemas(
  schema: SchemaObject | boolean | undefined,
): Record<string, SchemaOrBoolean> | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  const props = schema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return undefined;
  return props as Record<string, SchemaOrBoolean>;
}

/**
 * One property of a serialized object, coerced with its declared schema.
 *
 * A property the schema does not declare stays a string, which is what
 * `assembleDeepObject` already does for the same situation: there is no
 * type to read, and inventing one from the lexeme's shape would coerce
 * `additionalProperties` the caller never described.
 */
function coerceProperty(
  value: string,
  key: string,
  props: Record<string, SchemaOrBoolean> | undefined,
): unknown {
  const propSchema = getOwn(props, key);
  return propSchema === undefined ? value : coerceScalar(value, propSchema);
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

/**
 * Coerce one raw query or path lexeme into the JS type a numeric or
 * boolean schema expects. Strings, unrecognised types, and schemas with
 * no type to act on pass through unchanged, so the value fails the type
 * check downstream rather than arriving as something the client never
 * sent.
 *
 * Shared with {@link coerceQueryScalar}, which applies it to the
 * properties of an assembled object parameter. One grammar across both:
 * a lexeme means the same thing whether it arrives as `?n=` or as
 * `?filter[n]=` (#751).
 *
 * @internal
 */
export function coerceScalar(value: string, schema: SchemaObject | boolean | undefined): unknown {
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
