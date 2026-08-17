import type {
  HeaderObject,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaOrBoolean,
} from "@oaverify/internal-core";
import {
  pointerFromFragment,
  pointerFromRefFragment,
  resolveJsonPointer,
} from "@oaverify/internal-core";
import {
  isHeaderObjectPrototypePropertyName,
  isObjectPrototypePropertyName,
} from "@oaverify/internal-core/prototype-properties";
import type { RouteMatch } from "@oaverify/internal-router";
import type { CompiledTreeSchema } from "@oaverify/internal-schema";
import type { BodyDirection } from "./body-schema-transform.js";
import {
  coercionView,
  compileMediaTypePatterns,
  type ParsedMediaTypePattern,
  type SchemaRefResolver,
} from "./deserialize.js";
import { escapePointer } from "./document-walk.js";
import { effectiveType } from "./schema-type.js";
import type { CompiledSecurity } from "./security.js";

/**
 * Pre-compiled lookup tables for a single operation. The validator's
 * request/response flow reads from this cache rather than re-resolving
 * `$ref`s and re-compiling schemas per request.
 *
 * @internal
 */
export interface OperationCache {
  pathParamValidators: Map<string, CompiledTreeSchema>;
  queryParamValidators: Map<string, CompiledTreeSchema>;
  headerParamValidators: Map<string, CompiledTreeSchema>;
  cookieParamValidators: Map<string, CompiledTreeSchema>;
  parameters: ParameterObject[];
  /**
   * True when at least one spec-declared request parameter name can
   * collide with `Object.prototype` on its lookup bag. The request hot
   * path branches on this once per parameter instead of paying an
   * own-property check for every safe operation.
   */
  requestParameterReadsRequireOwnProperties: boolean;
  /**
   * Names of every declared `in: "query"` parameter, precomputed for
   * the `strictQueryParameters` unknown-key check so the hot path
   * doesn't rebuild this Set per request.
   */
  knownQueryParameters: Set<string>;
  /**
   * Bracket-suffixed spellings accepted for array-typed query
   * parameters, keyed by declared parameter name
   * (`"tags" -> "tags[]"`). Empty unless
   * {@link ValidatorOptions.allowBracketedQueryArrays} is on.
   *
   * Built here rather than derived per request so the "array schema
   * only" rule lives in one place and the request path pays nothing but
   * a Map lookup, and only on a lookup that already missed.
   *
   * A candidate alias that collides with a parameter declared under
   * that literal name is skipped, which is how "the literal declared
   * name always wins" holds even when a document declares both `tags`
   * and `tags[]`.
   */
  bracketQueryAliases: Map<string, string>;
  requestBody: RequestBodyObject | undefined;
  bodyValidators: Map<string, CompiledTreeSchema>;
  bodyMediaTypes: ParsedMediaTypePattern[];
  responses: Map<string, ResponseCompiled>;
  /**
   * Pre-compiled shape-only security check, or `undefined` when the
   * operation has no effective security requirement (either because
   * nothing was declared, it's opted out via `security: []`, or the
   * `validateSecurity` option is `"off"`).
   */
  security: CompiledSecurity | undefined;
}

/**
 * The resolved + lazy-compile state for a single response status entry.
 *
 * @internal
 */
export interface ResponseCompiled {
  object: ResponseObject;
  /**
   * Keyed by lowercased header name; value preserves the spec-cased
   * name, and the pointer to the Header Object (its component, where it
   * was reached through a `$ref`).
   */
  headers: Map<
    string,
    { name: string; object: HeaderObject; pointer?: string; anchor?: "node" | "definition" }
  >;
  /**
   * Response body schemas, keyed by media type. Each is compiled lazily
   * on first use and memoized into `bodyValidators`. Eager compilation
   * of every response schema at `cacheFor` time is expensive on specs
   * with hundreds of operations (Stripe-shaped), and most validators
   * are only ever asked about a single status/media-type pairing.
   */
  bodySchemas: Map<string, SchemaOrBoolean>;
  bodyMediaTypes: ParsedMediaTypePattern[];
  /**
   * `GET /pets 200 response`, prefixed onto the labels of the body and
   * header schemas compiled from this entry. Built here because this is
   * where the operation and status are both in hand; the lazy compile
   * happens later, with neither.
   */
  context: string;
  /**
   * Structural counterpart to `context`, e.g.
   * `/paths/~1pets/get/responses/200`. Built here for the same reason:
   * the lazy compile happens later, with neither the operation nor the
   * status in hand. Absent when the response cannot be addressed, which
   * includes a `$ref`'d Response Object reached from a document frame
   * that was itself absent.
   */
  pointer?: string;
  /** What `pointer` addresses; `"definition"` for a `$ref`'d Response. */
  anchor?: "node" | "definition";
  /** Header schemas keyed by lowercased name; compiled lazily. */
  headerSchemas: Map<string, SchemaOrBoolean>;
  /** Memoization caches for the lazy compiles. */
  bodyValidators: Map<string, CompiledTreeSchema>;
  headerValidators: Map<string, CompiledTreeSchema>;
  /** True when any response header lookup key can hit `Object.prototype`. */
  headerReadsRequireOwnProperties: boolean;
}

/**
 * Where one compiled schema sits, for a reader and for a machine.
 *
 * The two travel together at every compile site, so they are one
 * argument: a site that knows the prose almost always knows the
 * structure, and splitting them invites a site to pass one and forget
 * the other.
 *
 * @internal
 */
export interface SchemaOrigin {
  /** Prose, e.g. `POST /things request body (application/json)`. */
  label?: string;
  /**
   * RFC 6901 pointer to the schema in the resolved document. Absent
   * where the document cannot address it, which is never silently: see
   * `bodySchemaCompiledPointer` for the one case where the pointer is
   * not simply the use site.
   */
  pointer?: string;
  /**
   * What `pointer` addresses. `"definition"` when it was reached
   * through a `$ref` (a `$ref`'d Parameter, Request Body, Response or
   * Header, or a body schema whose root ref was unwrapped), so findings
   * inside it are reported as shared text. Defaults to `"node"`.
   */
  anchor?: "node" | "definition";
}

/**
 * External collaborators the cache builder needs: how to resolve
 * operation-level `$ref`s, how to compile a schema plainly, and how to
 * compile a body schema with a direction-specific readOnly/writeOnly
 * transform applied.
 *
 * @internal
 */
export interface OperationCacheDeps {
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined;
  /**
   * Resolves one `$ref` hop for the coercion views, through the resolver
   * schemas compile with. Separate from {@link OperationCacheDeps.resolveRef}
   * because that one walks JSON pointers and cannot follow an `$id`-based
   * target, which left coercion disagreeing with the compiled schema.
   */
  resolveSchemaRef: SchemaRefResolver;
  /**
   * The compiling dialect's `rules.refSuppressesSiblings`, so the
   * coercion views drop `$ref` siblings exactly when the compiler does
   * (OAS 3.0). Default `false`.
   */
  refSuppressesSiblings?: boolean;
  /**
   * {@link ValidatorOptions.allowBracketedQueryArrays}. When `true`, the
   * cache builds {@link OperationCache.bracketQueryAliases}; when
   * `false` that map is left empty and nothing downstream changes.
   */
  allowBracketedQueryArrays?: boolean;
  compile: (schema: SchemaOrBoolean, origin?: SchemaOrigin) => CompiledTreeSchema;
  compileForDirection: (
    schema: SchemaOrBoolean,
    direction: BodyDirection,
    origin?: SchemaOrigin,
  ) => CompiledTreeSchema;
  /**
   * Report a request-side schema that would not compile, instead of
   * letting the throw abort the build.
   *
   * Omitted, one malformed schema aborts the operation, which is what a
   * server wants: an operation missing a validator validates against
   * nothing. Supplied, each parameter and each request body media type
   * is compiled under its own guard and a failure costs only that unit,
   * so a document-inspecting tool sees every defect in the operation
   * rather than the first (#527).
   *
   * A cache built this way is missing the validators that failed, so the
   * caller must not memoize it for request validation. `precompile`
   * memoizes only when nothing was reported.
   */
  onCompileError?: (origin: SchemaOrigin, err: unknown) => void;
  /**
   * Adjust a body schema's origin to address what will actually be
   * compiled, which differs from the use site when a root `$ref` is
   * unwrapped (#517, defect 3c).
   *
   * Exposed because the guard has to name the unit *before* attempting
   * it: a body that fails to compile is reported from here, and the
   * schema that failed is the target, not the `$ref` node. Idempotent,
   * since it derives the answer from the raw schema.
   */
  bodySchemaOrigin?: (schema: SchemaOrBoolean, origin: SchemaOrigin) => SchemaOrigin;
  /**
   * Where a spec object that may be a `$ref` actually sits, following
   * the chain. See {@link originOfResolved}, which this binds to the
   * document; the cache builder holds no document of its own.
   */
  originOf?: (
    raw: unknown,
    base: { pointer?: string; anchor?: "node" | "definition" },
  ) => { pointer?: string; anchor?: "node" | "definition" };
}

/**
 * HTTP methods a `PathItem` can declare. Mirrors the `HttpMethod` union
 * in `@oaverify/core`, kept local for the same reason the
 * router keeps its own copy: a constant array is not worth a symbol
 * across the package boundary.
 */
const METHOD_KEYS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

/**
 * `POST /things`, for labelling the schemas an operation owns.
 *
 * `RouteMatch` carries the operation object and its path template but
 * not the method, so the method is recovered by finding which slot on
 * the `PathItem` holds this operation. Cheaper than threading a method
 * argument through every caller of `cacheFor`, and it cannot drift out
 * of sync with the operation actually being compiled.
 *
 * Falls back to the path alone if the operation is not reachable from
 * its own `PathItem`, which a hand-built `RouteMatch` could manage.
 *
 * @internal
 */
export function operationLabel(pathMatch: RouteMatch): string {
  for (const method of METHOD_KEYS) {
    if (pathMatch.pathItem[method] === pathMatch.operation) {
      return `${method.toUpperCase()} ${pathMatch.pathPattern}`;
    }
  }
  return pathMatch.pathPattern;
}

/**
 * `/paths/~1things/post`, the structural counterpart to
 * {@link operationLabel}. Everything an operation owns is addressed
 * beneath it.
 *
 * `undefined` when the operation is not reachable from its own
 * `PathItem` (a hand-built `RouteMatch` can manage this), which is the
 * same condition under which `operationLabel` falls back to the path
 * alone. There the label degrades to something still readable and the
 * pointer cannot degrade to anything that resolves, so it is absent.
 *
 * @internal
 */
export function operationPointer(pathMatch: RouteMatch): string | undefined {
  for (const method of METHOD_KEYS) {
    if (pathMatch.pathItem[method] === pathMatch.operation) {
      return `/paths/${escapePointer(pathMatch.pathPattern)}/${method}`;
    }
  }
  return undefined;
}

/**
 * How far a `$ref` chain is followed before it is called a cycle. Shared
 * with {@link resolveOperationRef} so the address and the object it
 * addresses can never come from different numbers of hops.
 */
const REF_CHAIN_MAX_HOPS = 32;

/**
 * Where a spec object that may have been reached through `$ref` sits,
 * and what that address means for a reader.
 *
 * `resolveRef` returns the target and says nothing about how it got
 * there, so a caller building an address has to ask separately. A
 * `$ref`'d Parameter, Request Body, Response or Header is written in
 * `components`, and that is where a reader has to go to edit it; the
 * use-site pointer addresses the `$ref` node instead.
 *
 * Follows the **whole chain**, because only its last hop names the
 * object that was resolved. A one-hop reading of `A -> B -> Parameter`
 * addresses `A`, which holds no `schema` key, so every pointer built
 * beneath it fails to resolve. That is the same defect as an unwrapped
 * root ref on a body schema (#517, defect 3c); the two are one bug in
 * two places.
 *
 * The anchor never downgrades: a caller passing `"definition"` because
 * its own container was `$ref`'d keeps it whether or not this object
 * adds a hop of its own. A response header inside a `$ref`'d Response
 * is shared text even when the Header Object is written inline.
 *
 * @internal
 */
export function originOfResolved(
  spec: unknown,
  raw: unknown,
  base: { pointer?: string; anchor?: "node" | "definition" },
): { pointer?: string; anchor?: "node" | "definition" } {
  if (base.pointer === undefined) return {};
  let current = raw;
  let lastRef: string | undefined;
  for (let hops = 0; hops < REF_CHAIN_MAX_HOPS; hops += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) break;
    const ref = (current as { $ref?: unknown }).$ref;
    if (typeof ref !== "string") break;
    // An external or anchor target names no position in this document,
    // so no pointer is the honest answer rather than the use site's,
    // which addresses the `$ref` node and not what was resolved.
    if (!ref.startsWith("#/")) return {};
    lastRef = ref;
    try {
      current = resolveJsonPointer(spec, pointerFromFragment(ref.slice(1)));
    } catch {
      // Unresolvable here is not this function's problem to report; the
      // compile that follows will fail and say so with its own message.
      return {};
    }
  }
  if (lastRef === undefined) return { pointer: base.pointer, anchor: base.anchor ?? "node" };
  return { pointer: pointerFromRefFragment(lastRef), anchor: "definition" };
}

/**
 * Media type of the entry {@link firstContentSchema} picks, so a caller
 * addressing that schema can name the `content` key it sits under.
 *
 * @internal
 */
export function firstContentMediaType(p: ParameterObject): string | undefined {
  if (p.content === undefined) return undefined;
  for (const [name, mto] of Object.entries(p.content)) {
    if (mto.schema !== undefined) return name;
  }
  return undefined;
}

/**
 * First schema found inside a parameter's `content` map (OAS 3.x spec
 * permits exactly one entry, but the API is keyed by media type).
 * Split out so both the cache builder and the per-request parameter
 * step can agree on the lookup rule.
 *
 * @internal
 */
export function firstContentSchema(p: ParameterObject): SchemaOrBoolean | undefined {
  if (p.content === undefined) return undefined;
  for (const mto of Object.values(p.content)) {
    if (mto.schema !== undefined) return mto.schema;
  }
  return undefined;
}

/**
 * Build the per-operation cache: de-duplicate path+operation parameters,
 * compile every parameter / request-body schema eagerly, and freeze the
 * response-side plan (schemas captured; validators compiled lazily on
 * first use via the caller's `getResponseValidator`).
 *
 * @internal
 */
export function buildOperationCache(
  pathMatch: RouteMatch,
  deps: OperationCacheDeps,
): OperationCache {
  // OAS 3.x: operation-level parameters replace path-level parameters
  // of the same (name, in). Push op-level second so later writes win
  // in the (in, name)-keyed dedup, then materialise the unique list.
  const operation = operationLabel(pathMatch);
  const opPointer = operationPointer(pathMatch);

  // The merge is where a parameter's address used to be lost. Source
  // array, index within it, and whether a `$ref` was followed are all
  // gone by the time the compile loop runs, and none is recoverable
  // from the resolved object: the dedup reorders, and an operation-level
  // entry overwrites a path-level one at the same key. So each raw entry
  // is paired with its own pointer before the merge, and the pair is
  // what gets deduped.
  const rawParams: { raw: ParameterObject | ReferenceObject; pointer?: string }[] = [
    ...(pathMatch.pathItem.parameters ?? []).map((raw, i) => ({
      raw,
      pointer:
        opPointer === undefined
          ? undefined
          : `/paths/${escapePointer(pathMatch.pathPattern)}/parameters/${i}`,
    })),
    ...(pathMatch.operation.parameters ?? []).map((raw, i) => ({
      raw,
      pointer: opPointer === undefined ? undefined : `${opPointer}/parameters/${i}`,
    })),
  ];
  const byKey = new Map<
    string,
    { object: ParameterObject; pointer?: string; anchor?: "node" | "definition" }
  >();
  for (const { raw, pointer } of rawParams) {
    const resolved = deps.resolveRef<ParameterObject>(raw);
    // Not `=== undefined`: a `- ` list entry with nothing under it is
    // `null`, which resolves to `null` and would throw on `.in` below.
    // Skipped for the same reason the router skips a null Operation; the
    // conformance pass locates it. See operationOn in the router.
    if (resolved === null || typeof resolved !== "object") continue;
    byKey.set(`${resolved.in}\0${resolved.name}`, {
      object: resolved,
      ...deps.originOf?.(raw, { pointer, anchor: "node" }),
    });
  }
  const parameterEntries = [...byKey.values()];
  // Coercion reads `type` off the schema governing a value, and a `$ref`
  // carries none, so these views resolve the three positions coercion
  // looks at. Compilation below still uses `parameterEntries`, the
  // unresolved originals, because the compiler follows refs itself and
  // the origin pointers address the document as written.
  const parameters: ParameterObject[] = parameterEntries.map((e) =>
    coercionView(e.object, deps.resolveSchemaRef, {
      refSuppressesSiblings: deps.refSuppressesSiblings,
    }),
  );
  const knownQueryParameters = new Set<string>();
  const bracketQueryAliases = new Map<string, string>();
  let requestParameterReadsRequireOwnProperties = false;
  for (const p of parameters) {
    if (p.in === "query") knownQueryParameters.add(p.name);
    if (
      p.in === "header"
        ? isHeaderObjectPrototypePropertyName(p.name)
        : isObjectPrototypePropertyName(p.name)
    ) {
      requestParameterReadsRequireOwnProperties = true;
    }
  }

  // Second pass, so the collision check can see every declared name.
  // `knownQueryParameters` grows here too: the check answers "could this
  // key legitimately appear", not "did the request use it", so an
  // accepted spelling is known whether or not it was sent. Without that,
  // `strictQueryParameters` would reject the very key this option
  // accepts and the two options would contradict each other.
  if (deps.allowBracketedQueryArrays === true) {
    for (const p of parameters) {
      if (p.in !== "query") continue;
      if (effectiveType(p.schema) !== "array") continue;
      const alias = `${p.name}[]`;
      if (knownQueryParameters.has(alias)) continue;
      bracketQueryAliases.set(p.name, alias);
    }
    for (const alias of bracketQueryAliases.values()) knownQueryParameters.add(alias);
  }

  // Compile one unit. Without a collector this is a plain call and a
  // throw propagates, aborting the build. With one, the failure is
  // recorded against its own label and the unit is skipped, leaving the
  // rest of the operation to compile.
  const guarded = (
    origin: SchemaOrigin,
    run: () => CompiledTreeSchema,
  ): CompiledTreeSchema | undefined => {
    if (deps.onCompileError === undefined) return run();
    try {
      return run();
    } catch (err) {
      // The whole origin reaches the collector: a schema that failed to
      // compile still has an address, and it is the same one a
      // successful compile would have reported its lint issues against.
      deps.onCompileError(origin, err);
      return undefined;
    }
  };

  const pathParamValidators = new Map<string, CompiledTreeSchema>();
  const queryParamValidators = new Map<string, CompiledTreeSchema>();
  const headerParamValidators = new Map<string, CompiledTreeSchema>();
  const cookieParamValidators = new Map<string, CompiledTreeSchema>();

  for (const { object: p, pointer: paramPointer, anchor: paramAnchor } of parameterEntries) {
    const contentSchema = firstContentSchema(p);
    const schema = contentSchema ?? p.schema;
    if (schema === undefined) continue;
    const context = `${operation} ${p.in} parameter "${p.name}"`;
    // A `content`-bearing parameter holds its schema one level deeper,
    // under the single media type the spec permits. No media type means
    // no address for it, which is absence rather than `/content//schema`.
    const contentMediaType = contentSchema === undefined ? undefined : firstContentMediaType(p);
    const pointer =
      paramPointer === undefined
        ? undefined
        : contentSchema === undefined
          ? `${paramPointer}/schema`
          : contentMediaType === undefined
            ? undefined
            : `${paramPointer}/content/${escapePointer(contentMediaType)}/schema`;
    const origin: SchemaOrigin = { label: context, pointer, anchor: paramAnchor };
    const v = guarded(origin, () => deps.compile(schema, origin));
    if (v === undefined) continue;
    // One bucket per location, with no final else. The chained ternary
    // this replaces ended at `cookieParamValidators`, so a parameter
    // whose `in` is none of the four had its compiled schema filed
    // under cookies, keyed by its name, where a real cookie parameter
    // of the same name would collide with it (#836). Nothing read it
    // back, which is why it was invisible.
    //
    // `createValidator` refuses such a document before any cache is
    // built (`assertServedParameterLocations`), so this is the same
    // defence `validateParameter`'s `default` arm gives: unreachable,
    // and obvious rather than silently wrong if a caller ever reaches
    // it by another route.
    const target =
      p.in === "path"
        ? pathParamValidators
        : p.in === "query"
          ? queryParamValidators
          : p.in === "header"
            ? headerParamValidators
            : p.in === "cookie"
              ? cookieParamValidators
              : undefined;
    if (target === undefined) continue;
    target.set(p.name, v);
  }

  const bodyValidators = new Map<string, CompiledTreeSchema>();
  const requestBody = deps.resolveRef<RequestBodyObject>(pathMatch.operation.requestBody);
  const requestBodyOrigin =
    deps.originOf?.(pathMatch.operation.requestBody, {
      pointer: opPointer === undefined ? undefined : `${opPointer}/requestBody`,
      anchor: "node",
    }) ?? {};
  if (requestBody?.content) {
    for (const [mt, mto] of Object.entries(requestBody.content)) {
      if (mto.schema) {
        const context = `${operation} request body (${mt})`;
        const pointer =
          requestBodyOrigin.pointer === undefined
            ? undefined
            : `${requestBodyOrigin.pointer}/content/${escapePointer(mt)}/schema`;
        const useSite: SchemaOrigin = {
          label: context,
          pointer,
          anchor: requestBodyOrigin.anchor,
        };
        const origin = deps.bodySchemaOrigin?.(mto.schema as SchemaOrBoolean, useSite) ?? useSite;
        const v = guarded(origin, () =>
          deps.compileForDirection(mto.schema as SchemaOrBoolean, "request", origin),
        );
        if (v !== undefined) bodyValidators.set(mt, v);
      }
    }
  }

  const responses = new Map<string, ResponseCompiled>();
  const rawResponses = pathMatch.operation.responses ?? {};
  for (const [status, rawResponse] of Object.entries(rawResponses)) {
    const response = deps.resolveRef<ResponseObject>(rawResponse);
    // Not `=== undefined`: `'200':` with nothing under it is `null`, and
    // would throw on `.content` below. Same rule as the null Parameter
    // above and the router's null Operation.
    if (response === null || typeof response !== "object") continue;
    const responseOrigin =
      deps.originOf?.(rawResponse, {
        pointer:
          opPointer === undefined ? undefined : `${opPointer}/responses/${escapePointer(status)}`,
        anchor: "node",
      }) ?? {};
    const bodySchemas = new Map<string, SchemaOrBoolean>();
    const headerSchemas = new Map<string, SchemaOrBoolean>();
    const headersResolved = new Map<
      string,
      { name: string; object: HeaderObject; pointer?: string; anchor?: "node" | "definition" }
    >();
    let headerReadsRequireOwnProperties = false;
    for (const [mt, mto] of Object.entries(response.content ?? {})) {
      if (mto.schema) bodySchemas.set(mt, mto.schema);
    }
    for (const [name, rawHdr] of Object.entries(response.headers ?? {})) {
      const hdr = deps.resolveRef<HeaderObject>(rawHdr);
      if (hdr === undefined) continue;
      const lower = name.toLowerCase();
      if (isObjectPrototypePropertyName(lower)) headerReadsRequireOwnProperties = true;
      headersResolved.set(lower, {
        name,
        object: hdr,
        // The response's anchor is the base, so a header written inline
        // inside a `$ref`'d Response is still shared text.
        ...deps.originOf?.(rawHdr, {
          pointer:
            responseOrigin.pointer === undefined
              ? undefined
              : `${responseOrigin.pointer}/headers/${escapePointer(name)}`,
          anchor: responseOrigin.anchor,
        }),
      });
      if (hdr.schema) headerSchemas.set(lower, hdr.schema);
    }
    responses.set(status, {
      object: response,
      context: `${operation} ${status} response`,
      pointer: responseOrigin.pointer,
      anchor: responseOrigin.anchor,
      headers: headersResolved,
      bodySchemas,
      bodyMediaTypes: compileMediaTypePatterns(bodySchemas.keys()),
      headerSchemas,
      bodyValidators: new Map(),
      headerValidators: new Map(),
      headerReadsRequireOwnProperties,
    });
  }

  return {
    parameters,
    knownQueryParameters,
    bracketQueryAliases,
    requestParameterReadsRequireOwnProperties,
    pathParamValidators,
    queryParamValidators,
    headerParamValidators,
    cookieParamValidators,
    requestBody,
    bodyValidators,
    bodyMediaTypes: compileMediaTypePatterns(bodyValidators.keys()),
    responses,
    // Security is populated by `createValidator` after this call
    // returns; `buildOperationCache` deliberately doesn't see the full
    // document (it only needs the `RouteMatch` subtree) so the field
    // starts out undefined.
    security: undefined,
  };
}

/**
 * Resolve an operation-level `$ref` (requestBody / response / parameter /
 * header) against the spec. Returns the target object with any siblings
 * on the reference itself dropped: per OAS, siblings of a Reference
 * are ignored. Follows chains with a depth guard to catch cycles.
 * External refs must be resolved upstream by `resolveSpec()` from
 * `@oaverify/core/spec`, which hoists schema targets into
 * `components.schemas` and inlines the rest; either way nothing external
 * survives for this to follow.
 *
 * Lifted to module scope so it can be exercised independently of
 * `createValidator`.
 *
 * @internal
 */
export function resolveOperationRef<T>(
  spec: unknown,
  value: T | ReferenceObject | undefined,
): T | undefined {
  let current: unknown = value;
  for (let hops = 0; hops < REF_CHAIN_MAX_HOPS; hops++) {
    if (current === undefined || current === null || typeof current !== "object") {
      return current as T | undefined;
    }
    const ref = (current as ReferenceObject).$ref;
    if (typeof ref !== "string") return current as T;
    if (!ref.startsWith("#")) {
      throw new Error(
        `external ref "${ref}" not resolved; run resolveSpec() from @oaverify/core/spec over the document before passing it to createValidator()`,
      );
    }
    current = resolveJsonPointer(spec, pointerFromFragment(ref.slice(1)));
  }
  throw new Error(`$ref chain exceeded 32 hops (possible cycle)`);
}
