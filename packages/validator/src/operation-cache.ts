import type {
  HeaderObject,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaOrBoolean,
} from "@oav/core";
import { resolveJsonPointer } from "@oav/core";
import type { RouteMatch } from "@oav/router";
import type { CompiledTreeSchema } from "@oav/schema";
import type { BodyDirection } from "./body-schema-transform.js";
import { compileMediaTypePatterns, type ParsedMediaTypePattern } from "./deserialize.js";
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
   * Names of every declared `in: "query"` parameter, precomputed for
   * the `strictQueryParameters` unknown-key check so the hot path
   * doesn't rebuild this Set per request.
   */
  knownQueryParameters: Set<string>;
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
  /** Keyed by lowercased header name; value preserves the spec-cased name. */
  headers: Map<string, { name: string; object: HeaderObject }>;
  /**
   * Response body schemas, keyed by media type. Each is compiled lazily
   * on first use and memoized into `bodyValidators`. Eager compilation
   * of every response schema at `cacheFor` time is expensive on specs
   * with hundreds of operations (Stripe-shaped), and most validators
   * are only ever asked about a single status/media-type pairing.
   */
  bodySchemas: Map<string, SchemaOrBoolean>;
  bodyMediaTypes: ParsedMediaTypePattern[];
  /** Header schemas keyed by lowercased name; compiled lazily. */
  headerSchemas: Map<string, SchemaOrBoolean>;
  /** Memoization caches for the lazy compiles. */
  bodyValidators: Map<string, CompiledTreeSchema>;
  headerValidators: Map<string, CompiledTreeSchema>;
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
  compile: (schema: SchemaOrBoolean) => CompiledTreeSchema;
  compileForDirection: (schema: SchemaOrBoolean, direction: BodyDirection) => CompiledTreeSchema;
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
  const rawParams: (ParameterObject | ReferenceObject)[] = [
    ...(pathMatch.pathItem.parameters ?? []),
    ...(pathMatch.operation.parameters ?? []),
  ];
  const byKey = new Map<string, ParameterObject>();
  for (const p of rawParams) {
    const resolved = deps.resolveRef<ParameterObject>(p);
    if (resolved === undefined) continue;
    byKey.set(`${resolved.in}\0${resolved.name}`, resolved);
  }
  const parameters: ParameterObject[] = [...byKey.values()];
  const knownQueryParameters = new Set<string>();
  for (const p of parameters) {
    if (p.in === "query") knownQueryParameters.add(p.name);
  }

  const pathParamValidators = new Map<string, CompiledTreeSchema>();
  const queryParamValidators = new Map<string, CompiledTreeSchema>();
  const headerParamValidators = new Map<string, CompiledTreeSchema>();
  const cookieParamValidators = new Map<string, CompiledTreeSchema>();

  for (const p of parameters) {
    const contentSchema = firstContentSchema(p);
    const schema = contentSchema ?? p.schema;
    if (schema === undefined) continue;
    const v = deps.compile(schema);
    const target =
      p.in === "path"
        ? pathParamValidators
        : p.in === "query"
          ? queryParamValidators
          : p.in === "header"
            ? headerParamValidators
            : cookieParamValidators;
    target.set(p.name, v);
  }

  const bodyValidators = new Map<string, CompiledTreeSchema>();
  const requestBody = deps.resolveRef<RequestBodyObject>(pathMatch.operation.requestBody);
  if (requestBody?.content) {
    for (const [mt, mto] of Object.entries(requestBody.content)) {
      if (mto.schema) bodyValidators.set(mt, deps.compileForDirection(mto.schema, "request"));
    }
  }

  const responses = new Map<string, ResponseCompiled>();
  const rawResponses = pathMatch.operation.responses ?? {};
  for (const [status, rawResponse] of Object.entries(rawResponses)) {
    const response = deps.resolveRef<ResponseObject>(rawResponse);
    if (response === undefined) continue;
    const bodySchemas = new Map<string, SchemaOrBoolean>();
    const headerSchemas = new Map<string, SchemaOrBoolean>();
    const headersResolved = new Map<string, { name: string; object: HeaderObject }>();
    for (const [mt, mto] of Object.entries(response.content ?? {})) {
      if (mto.schema) bodySchemas.set(mt, mto.schema);
    }
    for (const [name, rawHdr] of Object.entries(response.headers ?? {})) {
      const hdr = deps.resolveRef<HeaderObject>(rawHdr);
      if (hdr === undefined) continue;
      const lower = name.toLowerCase();
      headersResolved.set(lower, { name, object: hdr });
      if (hdr.schema) headerSchemas.set(lower, hdr.schema);
    }
    responses.set(status, {
      object: response,
      headers: headersResolved,
      bodySchemas,
      bodyMediaTypes: compileMediaTypePatterns(bodySchemas.keys()),
      headerSchemas,
      bodyValidators: new Map(),
      headerValidators: new Map(),
    });
  }

  return {
    parameters,
    knownQueryParameters,
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
 * External refs must be inlined upstream by `@oav/spec.resolveSpec()`.
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
  for (let hops = 0; hops < 32; hops++) {
    if (current === undefined || current === null || typeof current !== "object") {
      return current as T | undefined;
    }
    const ref = (current as ReferenceObject).$ref;
    if (typeof ref !== "string") return current as T;
    if (!ref.startsWith("#")) {
      throw new Error(
        `external ref "${ref}" not resolved; run @oav/spec's resolveSpec() over the document before passing it to createValidator()`,
      );
    }
    current = resolveJsonPointer(spec, ref.slice(1));
  }
  throw new Error(`$ref chain exceeded 32 hops (possible cycle)`);
}
