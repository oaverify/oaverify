import {
  classifyUnknownVersion,
  createBranchError,
  createLeafError,
  detectOpenAPIVersion,
  type HttpRequest,
  type HttpResponse,
  type OpenAPIDocument,
  type OpenAPIVersion,
  type OperationObject,
  type PathItem,
  type ReferenceObject,
  type SchemaOrBoolean,
  type ValidationError,
} from "@oaverify/internal-core";
import { builtInFormats } from "@oaverify/internal-formats";
import {
  createRouter,
  type RouteInfo,
  type RouteMatch,
  type Router,
} from "@oaverify/internal-router";
import { lintResolvedSpec, type SpecHygieneIssue } from "@oaverify/internal-spec";
import {
  compileSchema,
  createRefResolver,
  oas30Dialect,
  openapi31Dialect,
  resolve,
  type CompiledTreeSchema,
  type CustomKeywordValidator,
  type Dialect,
  type RefResolver,
  type RegexCompiler,
  type SchemaLintIssue,
  type TreeValidationResult,
  type ValidationResult,
} from "@oaverify/internal-schema";
import { deserialize, matchParsedMediaType, matchResponseKey } from "./deserialize.js";
import { escapePointer } from "./document-walk.js";
import { getHeaderValue, getHeaderValueFast } from "./headers.js";
import { reshapeResult, toFetchResult } from "./reshape.js";
import {
  bodySchemaCompiledPointer,
  createDirectionResolver,
  transformBodySchemaForDirection,
  type BodyDirection,
} from "./body-schema-transform.js";
import {
  httpRequestFromFetch,
  httpResponseFromFetch,
  type FetchRequestOptions,
} from "./from-fetch.js";
import {
  buildOperationCache,
  operationLabel,
  operationPointer,
  resolveOperationRef,
  type OperationCache,
  type ResponseCompiled,
  type SchemaOrigin,
} from "./operation-cache.js";
import { checkSecurity, compileOperationSecurity, type SecurityMode } from "./security.js";
import { matchRequestBodyMediaType, validateBody, validateParameter } from "./validate-step.js";

/**
 * Coerce {@link ValidatorOptions.validateSecurity} (enum string |
 * undefined) to the `"off" | "shape" | "strict"` value the security
 * compiler reads. `undefined` defaults to `"off"`.
 *
 * @internal
 */
function normalizeSecurityMode(
  value: "off" | "shape" | "strict" | undefined,
): "off" | SecurityMode {
  return value ?? "off";
}

/**
 * Turn a failed compile into a {@link PrecompileFailure}, keeping the
 * address the successful path would have used.
 *
 * `context` falls back to the empty string only when the site supplied
 * no label, which no current site does; the field is required on the
 * type and predates this.
 */
function failureFrom(origin: SchemaOrigin, err: unknown): PrecompileFailure {
  const failure: PrecompileFailure = {
    context: origin.label ?? "",
    message: (err as Error).message,
  };
  if (origin.pointer !== undefined) {
    failure.pointer = origin.pointer;
    failure.anchor = origin.anchor ?? "node";
  }
  return failure;
}

/**
 * Address one response body media type, matching what
 * `getResponseValidator` would compile it under. Duplicated shape
 * rather than shared because the guard runs before the getter and has
 * to name the unit it is about to attempt.
 */
function responseBodyOrigin(response: ResponseCompiled, mediaType: string): SchemaOrigin {
  return {
    // The response's own label, not a per-media-type one. The guard
    // reported `context` before this change and the compiler's message
    // already names the media type, so narrowing it here would both
    // change existing human output and say it twice.
    label: response.context,
    pointer:
      response.pointer === undefined
        ? undefined
        : `${response.pointer}/content/${escapePointer(mediaType)}/schema`,
    anchor: response.anchor,
  };
}

/** The header counterpart to {@link responseBodyOrigin}. */
function responseHeaderOrigin(response: ResponseCompiled, key: string): SchemaOrigin {
  const header = response.headers.get(key);
  return {
    // See responseBodyOrigin: the label is the response's, unchanged.
    label: response.context,
    pointer: header?.pointer === undefined ? undefined : `${header.pointer}/schema`,
    anchor: header?.anchor,
  };
}

/**
 * Pick the dialect for a given OpenAPI version. 3.1 and 3.2 share the
 * 2020-12-based dialect with format-assertion; 3.0 uses the OAS 3.0
 * Schema Object flavour (string-only `type`, `nullable`, boolean
 * `exclusiveMaximum` / `exclusiveMinimum`, `$ref`-suppresses-siblings).
 *
 * @internal
 */
function dialectFor(version: OpenAPIVersion): Dialect {
  switch (version) {
    case "3.1":
    case "3.2":
      return openapi31Dialect;
    case "3.0":
      return oas30Dialect;
  }
}

/**
 * The HTTP validator (flat output, the default). `validateRequest` /
 * `validateResponse` return `@oaverify/core/schema`'s `ValidationResult`:
 * `{ valid: true }` or `{ valid: false, errors, truncated }` with a flat
 * list of leaf errors. Compile with `output: "tree"` for a
 * {@link TreeValidator} (nested {@link ValidationError} tree) or
 * `output: "predicate"` for a {@link PredicateValidator} (bare boolean).
 *
 * - **Per-call HTTP validation**: {@link Validator.validateRequest},
 *   {@link Validator.validateResponse}.
 * - **Web Standards convenience**: {@link Validator.validateFetchRequest},
 *   {@link Validator.validateFetchResponse}. Wrap the per-call methods
 *   with body-parsing for `Request` / `Response` consumers (Next.js,
 *   Hono, Bun, Deno).
 * - **Spec introspection**: {@link Validator.getOperation},
 *   {@link Validator.detectedVersion}.
 * - **Construction-time output**: {@link Validator.warnings},
 *   {@link Validator.specHygieneIssues}.
 * - **Live observability**: {@link Validator.stats}.
 *
 * @public
 */
/**
 * The routing verdict for a method + path, with nothing compiled or
 * validated. Pairs with {@link Validator.getOperation}: `getOperation`
 * hands back the resolved operation on a clean match, while `matchRoute`
 * reports the verdict and keeps the 404-vs-405 distinction that
 * `getOperation` collapses to `null`.
 *
 * - `"match"`: the path matched and the method is declared (counting the
 *   implicit HEAD a GET resource answers, RFC 9110 §9.3.2).
 * - `"method-not-allowed"`: the path matched but the method isn't
 *   declared on it; `allowed` is the union of declared methods, uppercased,
 *   suitable for an RFC 9110 `Allow` header.
 * - `"no-match"`: no path template matched at all.
 *
 * @public
 */
export type RouteMatchResult =
  | { readonly kind: "match"; readonly pathPattern: string }
  | {
      readonly kind: "method-not-allowed";
      readonly pathPattern: string;
      readonly allowed: readonly string[];
    }
  | { readonly kind: "no-match" };

/**
 * One schema that could not be compiled, from
 * {@link Validator.precompile} in `"collect"` mode.
 *
 * @public
 */
export interface PrecompileFailure {
  /**
   * What was being compiled, named down to the individual schema:
   * `'POST /things query parameter "q"'`, `"POST /things request body
   * (application/json)"`, `"GET /pets 200 response"`, or
   * `"POST /things security"`. The compiler's own message carries the
   * path within that schema.
   */
  context: string;
  /** The compiler's message, including the path within the schema. */
  message: string;
  /**
   * RFC 6901 pointer to the schema that would not compile,
   * percent-decoded with `~0` / `~1` retained. The structural
   * counterpart to `context`.
   *
   * A schema that failed to compile still has an address, and it is the
   * same one its lint issues would have carried had it compiled.
   * Absent under the same rule as everywhere else: no pointer into this
   * document resolves to it.
   */
  pointer?: string;
  /**
   * What `pointer` addresses: `"definition"` when the schema was
   * reached through a `$ref`, so editing there affects every use site.
   */
  anchor?: "node" | "definition";
}

export interface Validator {
  /**
   * Validate one HTTP request against the spec. Returns `{ valid: true }`
   * when the request matches the operation declared at its method + path
   * (parameters, headers, cookies, body, and content type); otherwise
   * `{ valid: false, errors, truncated }` with a flat list of leaf
   * errors.
   *
   * Each error's `path` is prefixed with its HTTP location: `["body",
   * …]`, `["query", name]`, `["header", name]`, `["cookie", name]`,
   * `["path", name]`, or `["security"]`. (The matching error `code` is
   * `query-param` / `header-param` / `cookie-param` / `path-param`; the
   * path segment drops the `-param` suffix.) Route and method
   * mismatches surface as `route` / `method` leaves; see
   * {@link httpStatusFor} for the canonical status mapping.
   *
   * `truncated` is `true` when the `maxErrors` cap (default 1) was
   * reached, so more problems may exist; raise `maxErrors` to collect
   * them.
   *
   * Does not mutate `req`. Synchronous: parameter deserialization,
   * content-type matching, and schema validation all run inline.
   *
   * Paths the spec doesn't declare are treated according to
   * {@link ValidatorOptions.ignoreUndocumented} and
   * {@link ValidatorOptions.ignorePaths}: by default an undeclared
   * path returns a `route` error; configure to bypass the validator
   * entirely.
   *
   * @see {@link Validator.validateResponse} for the response-side pair.
   * @see {@link Validator.validateFetchRequest} for the Web Standards convenience wrapper.
   * @see {@link Validator.getOperation} to look up the matched operation without validating.
   */
  validateRequest(req: HttpRequest): ValidationResult;
  /**
   * Validate one HTTP response against the spec, given the request it
   * answers. Returns `{ valid: true }` when the response status, content
   * type, headers, and body all match the responses declared on the
   * operation `req` resolves to; otherwise `{ valid: false, errors,
   * truncated }`.
   *
   * Each error's `path` is prefixed with `["body", …]`, `["header",
   * name]`, or `["status"]`. The `req` argument is used only to locate
   * the operation; its body isn't read.
   *
   * Response-body schemas compile lazily on first use per `(status,
   * mediaType)` pairing; {@link ValidatorStats.responseBodiesCompiled}
   * counts how many have been compiled since construction.
   *
   * Does not mutate `req` or `res`. Synchronous, like
   * {@link Validator.validateRequest}.
   *
   * @see {@link Validator.validateRequest} for the request-side pair.
   * @see {@link Validator.validateFetchResponse} for the Web Standards convenience wrapper.
   */
  validateResponse(req: HttpRequest, res: HttpResponse): ValidationResult;
  /**
   * Parse a Web Standards {@link Request} and validate it in one call.
   * Convenient for route handlers in frameworks that expose `Request`
   * directly (Next.js App Router, Hono, Bun, Deno) so callers don't
   * repeat ~10 lines of URL / header / body extraction per route.
   *
   * Returns a discriminated union. On success, `body` is the parsed
   * request body, narrowed to the generic type the caller supplies
   * (validation has already confirmed the shape, so the cast is safe
   * in practice). On failure, `errors` / `truncated` are the same
   * fields `validateRequest` would return.
   *
   * Body parsing recognizes `application/json` (and `*+json`),
   * `application/x-www-form-urlencoded`, `multipart/form-data`
   * (file fields come through as `Uint8Array`), and `text/*`. Any
   * other content type is read as raw bytes; the spec's
   * `format: "binary"` opaque-body bypass accepts it. Override the
   * default reader per-call via {@link FetchRequestOptions.readBody}
   * for streaming, multer-style parsing, or other bespoke handling.
   *
   * @param request - The incoming Web Standards request.
   * @param options - Optional body-reader override.
   * @typeParam T - Declared shape of the parsed body on success.
   *
   * @example
   * ```ts
   * export async function POST(request: Request) {
   *   const r = await validator.validateFetchRequest<CreatePet>(request);
   *   if (!r.ok) return problemResponse(r.errors);
   *   // r.body is typed as CreatePet
   * }
   * ```
   */
  validateFetchRequest<T = unknown>(
    request: Request,
    options?: FetchRequestOptions,
  ): Promise<{ ok: true; body: T } | { ok: false; errors: ValidationError[]; truncated: boolean }>;
  /**
   * Validate a Web Standards {@link Response} against the operation
   * the {@link Request} resolves to. Mirrors
   * {@link validateFetchRequest} for the response side; useful when
   * you're calling an upstream API and want to confirm its response
   * matches the spec, or when you're testing your own handler's
   * output against its OpenAPI contract.
   *
   * Both messages are consumed by this call. The `request` is used
   * only to match the route, method, and path; its body isn't
   * read (and `request.clone()` will give you back a fresh one if
   * you need it after the fact).
   *
   * @param request  - The Web Standards request that triggered `response`.
   * @param response - The Web Standards response to validate.
   * @typeParam T    - Declared shape of the parsed response body on success.
   *
   * @example
   * ```ts
   * const response = await fetch(upstreamUrl, init);
   * const r = await validator.validateFetchResponse<PetList>(req, response);
   * if (!r.ok) log.warn("upstream returned malformed response", r.errors);
   * ```
   */
  validateFetchResponse<T = unknown>(
    request: Request,
    response: Response,
  ): Promise<{ ok: true; body: T } | { ok: false; errors: ValidationError[]; truncated: boolean }>;
  /**
   * Look up the effective operation declaration for a method + path.
   * Returns the resolved (`$ref`s followed) and overlay-applied
   * {@link OperationObject}, the matched path pattern, and the
   * enclosing {@link PathItem}. Returns `null` when no operation
   * matches (either the path doesn't match any template or the
   * method isn't declared on it).
   *
   * Startup-time introspection, not a validation step: the spec is
   * frozen at `createValidator` time, so this is safe to call once
   * during application init and cache the result. Callers typically
   * use it to derive middleware configuration (multer limits,
   * accepted content types, required headers) from the same source
   * of truth the validator uses.
   *
   * Uses the same per-operation cache the validation path uses;
   * repeated calls are O(route-match) with no extra compilation.
   *
   * @example
   * ```ts
   * const info = validator.getOperation({ method: "POST", path: "/uploads" });
   * const mediaTypes = Object.keys(info?.operation.requestBody?.content ?? {});
   * ```
   */
  getOperation(req: { method: string; path: string }): {
    pathPattern: string;
    pathItem: PathItem;
    operation: OperationObject;
  } | null;
  /**
   * Resolve a method + path to its routing verdict without compiling or
   * validating. Returns a {@link RouteMatchResult}: `"match"`,
   * `"method-not-allowed"` (with the `allowed` method set), or
   * `"no-match"`.
   *
   * Pairs with {@link Validator.getOperation}, which returns `null` for
   * both the 405 and 404 cases; `matchRoute` keeps them distinct, so a
   * caller can map a wrong-method hit to HTTP 405 rather than 404.
   * {@link combineValidators} uses it to dispatch across members while
   * preserving method-not-allowed semantics that `getOperation` alone
   * can't express.
   *
   * Startup-cheap: a single route-table scan, no schema compilation.
   *
   * @see {@link Validator.getOperation} for the operation object on a match.
   */
  matchRoute(req: { method: string; path: string }): RouteMatchResult;
  /**
   * Compile every operation's schemas now, rather than on first access.
   *
   * Compilation is lazy by default, and response bodies are lazier
   * still, so a spec with hundreds of operations pays only for the
   * pairings its traffic exercises. That is right for a server and wrong
   * for a tool inspecting the whole document: until a schema compiles it
   * has neither been checked for well-formedness nor contributed to
   * {@link ValidatorStats.schemaLintIssues}.
   *
   * After this call, a malformed schema anywhere in the document has
   * thrown (with its path), and `stats.schemaLintIssues` covers the
   * whole document rather than the parts already touched.
   *
   * Idempotent. Not needed on the request path: the results land in the
   * same caches lazy compilation fills, so this changes when the work
   * happens, not how much.
   *
   * `onMalformed` decides what a malformed schema does. The default,
   * `"throw"`, stops at the first one and is what a server wants:
   * continuing would leave that operation compiled from nothing and
   * silently unvalidated. `"collect"` records each failure, skips the
   * schema that failed, and carries on, which is what a tool inspecting
   * the document wants: one bad `items` should not hide every other
   * finding in the document. The failures are returned either way (empty
   * when throwing, since a throw leaves nothing to return).
   *
   * Collect mode skips one schema, not one operation: every other
   * parameter, request body, and response in the same operation is still
   * compiled and still contributes to
   * {@link ValidatorStats.schemaLintIssues}. The operation's cache is
   * discarded rather than memoized when any of its schemas failed, so a
   * later request rebuilds it and throws instead of validating against a
   * cache that is missing a validator (#527).
   */
  precompile(options?: { onMalformed?: "throw" | "collect" }): readonly PrecompileFailure[];
  /**
   * Every operation the spec declares, as `{ method, pathPattern }`
   * pairs in route-specificity order (more literal segments first).
   * `method` is uppercased (`"GET"`); `pathPattern` is the template as
   * declared (`"/pets/{id}"`). The implicit HEAD that a GET resource
   * also answers (RFC 9110 §9.3.2) is a match-time fallback, not a
   * declaration, so it is not listed.
   *
   * Startup-time introspection over the same route table the validator
   * matches against, frozen at `createValidator` time. Useful for
   * mounting per-route middleware, generating coverage reports, or
   * asserting two specs are route-disjoint before
   * {@link combineValidators} stacks them.
   */
  readonly routes: readonly RouteInfo[];
  /**
   * The OpenAPI version detected from the spec's `openapi` field, or
   * `undefined` when the field was missing, malformed, unsupported, or
   * accepted only because an explicit {@link ValidatorOptions.dialect}
   * bypassed version detection.
   */
  readonly detectedVersion: OpenAPIVersion | undefined;
  /**
   * The output shape this validator was built with (see
   * {@link ValidatorOptions.output}): `"flat"` (default), `"tree"`, or
   * `"predicate"`. Lets consumers (e.g. the framework adapters) branch
   * on the result shape without a trial call.
   */
  readonly output: "flat" | "tree" | "predicate";
  /**
   * Warnings collected during `createValidator`. Populated when
   * `onUnknownVersion: "warn"` fires, or when the `dialect` escape
   * hatch suppresses a category error that would otherwise throw
   * (missing `openapi` field, wrong major). Empty when neither applies.
   *
   * The library never writes to `process.stderr` or `console`; this
   * array is the library's only record of such events. Callers that
   * want live output pass {@link ValidatorOptions.warn}; the CLI
   * wrapper does this.
   *
   * Frozen after `createValidator` returns; no post-construction
   * writes happen.
   */
  readonly warnings: readonly string[];
  /**
   * Spec-hygiene findings from {@link lintResolvedSpec}, populated when
   * {@link ValidatorOptions.lint} is `true`. Empty otherwise. Frozen
   * after `createValidator` returns.
   *
   * Different from {@link ValidatorStats.schemaLintIssues}, which lints
   * compiled schemas; this one lints the OpenAPI document itself
   * (unused components, dead path parameters, unreachable `$defs`).
   */
  readonly specHygieneIssues: readonly SpecHygieneIssue[];
  /**
   * Runtime observability for compile-time-specialization optimizations.
   * The counters live on the validator, not inside a ValidationError
   * tree, so tests can assert on the optimization directly rather than
   * through indirect signals (throwing test schemas, source grepping).
   */
  readonly stats: ValidatorStats;
}

/** The four validation methods whose return type tracks `output`. */
type OutputDependentMethods =
  | "validateRequest"
  | "validateResponse"
  | "validateFetchRequest"
  | "validateFetchResponse";

/**
 * The HTTP validator built with `output: "tree"`. Identical to
 * {@link Validator} except `validateRequest` / `validateResponse` return
 * `@oaverify/core/schema`'s `TreeValidationResult` (a nested
 * {@link ValidationError} tree under `error`) instead of the flat default.
 *
 * @public
 */
export interface TreeValidator extends Omit<Validator, OutputDependentMethods> {
  validateRequest(req: HttpRequest): TreeValidationResult;
  validateResponse(req: HttpRequest, res: HttpResponse): TreeValidationResult;
  validateFetchRequest<T = unknown>(
    request: Request,
    options?: FetchRequestOptions,
  ): Promise<{ ok: true; body: T } | { ok: false; error: ValidationError; truncated: boolean }>;
  validateFetchResponse<T = unknown>(
    request: Request,
    response: Response,
  ): Promise<{ ok: true; body: T } | { ok: false; error: ValidationError; truncated: boolean }>;
}

/**
 * The HTTP validator built with `output: "predicate"`. `validateRequest`
 * / `validateResponse` return a bare `boolean` (no errors are ever
 * constructed). The Fetch wrappers narrow the body on success and carry
 * no error payload on failure. A predicate validator cannot render a
 * problem-details response, so the framework adapters reject it at
 * construction; use it for gating where only the yes/no answer matters.
 *
 * @public
 */
export interface PredicateValidator extends Omit<Validator, OutputDependentMethods> {
  validateRequest(req: HttpRequest): boolean;
  validateResponse(req: HttpRequest, res: HttpResponse): boolean;
  validateFetchRequest<T = unknown>(
    request: Request,
    options?: FetchRequestOptions,
  ): Promise<{ ok: true; body: T } | { ok: false }>;
  validateFetchResponse<T = unknown>(
    request: Request,
    response: Response,
  ): Promise<{ ok: true; body: T } | { ok: false }>;
}

/**
 * Live counters attached to an {@link Validator}.
 *
 * @public
 */
export interface ValidatorStats {
  /**
   * Number of response-body schemas that have been lazily compiled since
   * the validator was constructed. Starts at `0`; bumps by one each time
   * a `(status, mediaType)` pairing is seen by `validateResponse` for
   * the first time. A spec's response bodies are NOT compiled at
   * `createValidator` time, so on a fresh validator this is always `0`.
   */
  responseBodiesCompiled: number;
  /**
   * Live array of schema lint issues surfaced by
   * {@link ValidatorOptions.schemaLint}. Grows as schemas compile (request
   * / path / header / query schemas at construction; response-body
   * schemas lazily on first use). An empty array when `schemaLint: "off"`
   * or when the linter found nothing to flag.
   *
   * Schema paths are the full path inside each compiled schema, not
   * HTTP-frame-prefixed; the linter runs over raw JSON Schema, not
   * OpenAPI.
   */
  schemaLintIssues: readonly SchemaLintIssue[];
}

/**
 * The full set of {@link createValidator} tunables. Every knob you
 * might reach for lives on this type; the per-field TSDoc below is
 * the canonical contract for each one. The integration guide carries
 * worked examples; this type carries the API.
 *
 * - **Dialect override**: {@link ValidatorOptions.dialect}.
 * - **Schema extension**: {@link ValidatorOptions.formats},
 *   {@link ValidatorOptions.keywords}.
 * - **Output shape + error budget**: {@link ValidatorOptions.output},
 *   {@link ValidatorOptions.maxErrors}.
 * - **Schema lint**: {@link ValidatorOptions.schemaLint}.
 * - **Security gating**: {@link ValidatorOptions.validateSecurity}.
 * - **Path filtering**: {@link ValidatorOptions.ignoreUndocumented},
 *   {@link ValidatorOptions.ignorePaths}.
 * - **Query strictness**: {@link ValidatorOptions.strictQueryParameters}.
 * - **Response strictness**: {@link ValidatorOptions.requireResponseBody}.
 * - **Version mismatch**: {@link ValidatorOptions.onUnknownVersion}.
 * - **Warn sink**: {@link ValidatorOptions.warn}.
 *
 * @remarks
 * Ordering convention (shared with
 * `@oaverify/core/schema`'s `CompileOptions`):
 *
 *   1. Compile essentials: `dialect`.
 *   2. Shared extension points: `formats`, `keywords`.
 *   3. Error-collection policy: `output`, `maxErrors`.
 *   4. Surface-specific extras last: here, `strictQueryParameters`,
 *      `onUnknownVersion`, `warn`.
 *
 * Options common to both surfaces share names and positions so a
 * reader of one declaration can predict the other. When adding a new
 * option, put it in the section that matches its role and use the
 * same name on the compile-schema side if the concept applies there
 * too.
 *
 * @public
 */
export interface ValidatorOptions {
  // --- 1. Compile essentials ---

  /**
   * Override the schema dialect used to compile the spec's schemas.
   * By default the validator reads the spec's `openapi` version and
   * picks a matching built-in dialect (`openapi31Dialect` for 3.1/3.2,
   * `oas30Dialect` for 3.0). Pass this option to plug in a custom
   * {@link Dialect} or force a specific built-in.
   *
   * Takes precedence over the detected version, so a 3.1 document
   * compiled with `oas30Dialect` gets 3.0 semantics (`nullable` becomes
   * load-bearing, `type` arrays are rejected). Detection still runs:
   * {@link Validator.detectedVersion} reports what the document
   * declares, which this option does not change.
   *
   * Setting `dialect` is also the universal escape hatch for the
   * category-error checks that normally throw at construction: a
   * missing/non-string `openapi` field or a wrong major version
   * would reject the spec by default, but an explicit `dialect`
   * signals "I know what I'm doing" and compilation proceeds. A
   * single warning is emitted via {@link ValidatorOptions.warn}
   * when the override suppresses a would-be category error, so
   * accidental misuse is still visible.
   */
  dialect?: Dialect;

  // --- 2. Shared extension points ---

  /** Optional extra format validators merged on top of {@link builtInFormats}. */
  formats?: Record<string, (value: string) => boolean>;
  /**
   * User-registered schema keywords. The record is keyed by keyword
   * name; each validator is invoked whenever that name appears in a
   * schema. Keys must not collide with built-in keywords. See
   * {@link CustomKeywordValidator} for the function signature.
   *
   * @example
   * ```ts
   * createValidator(spec, {
   *   keywords: {
   *     divisibleBy: (data, schemaValue) =>
   *       typeof data !== "number" || data % (schemaValue as number) === 0,
   *   },
   * });
   * ```
   */
  keywords?: Record<string, CustomKeywordValidator>;

  // --- 3. Error-collection policy ---

  /**
   * What `validateRequest` / `validateResponse` return. Mirrors
   * `@oaverify/core/schema`'s `CompileOptions.output`:
   *
   * - `"flat"` (default): a
   *   `ValidationResult`: `{ valid }` plus,
   *   on failure, a flat `errors` leaf list and `truncated`. The
   *   constructed validator has type {@link Validator}.
   * - `"tree"`: a `TreeValidationResult`: a
   *   nested {@link ValidationError} tree under `error`. Type
   *   {@link TreeValidator}.
   * - `"predicate"`: a bare `boolean`. Type {@link PredicateValidator};
   *   the framework adapters reject it (it can't render a 400 body).
   *
   * Defaults to `"flat"`.
   */
  output?: "flat" | "tree" | "predicate";
  /**
   * Cap on the number of leaf schema errors collected per
   * `validateRequest` / `validateResponse` call, across all locations
   * (body, parameters, headers). Defaults to `1` (fast-fail: the first
   * error). Pass `Number.POSITIVE_INFINITY` to collect every error.
   *
   * When the cap is reached the result's `truncated` is `true`, so
   * consumers can tell more problems may exist. A small cap also bounds
   * CPU and memory on validation of very large invalid payloads (e.g. a
   * 10 MB array where every element has the same structural error).
   *
   * Must be a positive integer (>= 1). `createValidator` throws on
   * non-integer or zero/negative values.
   */
  maxErrors?: number;
  /**
   * Cap on recursion depth through `$ref` cycles per
   * `validateRequest` / `validateResponse` call. Defaults to uncapped.
   *
   * Recursive schemas (a `$ref` back to an ancestor, common for tree /
   * comment shapes) validate by recursing on the JS call stack, so a
   * small but deeply nested payload can exhaust it and throw. Set this
   * to bound the recursion: past the cap, validation emits a `depth`
   * error (HTTP 400) at the boundary instead of descending, so a deep
   * payload fails as a client error rather than crashing the process.
   *
   * Legitimate payloads rarely recurse beyond ten or fifteen levels; a
   * cap of 32 to 64 is generous. Non-recursive schemas are never
   * instrumented and pay nothing; unset, codegen is identical to the
   * un-instrumented path. Must be a positive integer (>= 1);
   * `createValidator` throws otherwise.
   */
  maxDepth?: number;
  /**
   * Compile-time schema linting applied to every schema the validator
   * compiles (request parameters / body; response headers; response
   * bodies lazily). Issues surface via
   * {@link ValidatorStats.schemaLintIssues}; no throws.
   *
   * - `"off"`: silence on everything.
   * - `"warn"` (default): warn on keywords flagged as
   *   partially-implemented (currently `$dynamicRef`).
   * - `"strict"`: warn on partial features AND unknown keys.
   */
  schemaLint?: "off" | "warn" | "strict";
  /**
   * Custom compiler for schema `pattern` keywords and `format: "regex"`.
   * Defaults to JavaScript's built-in `RegExp` (with u-mode and a
   * non-u fallback). Override to plug in a library like `re2` when
   * the spec is attacker-controlled and ReDoS is a concern. See
   * {@link RegexCompiler} and the "Hardening against untrusted regex
   * patterns" recipe in `docs/configuration.md`.
   */
  regexCompiler?: RegexCompiler;

  // --- 4. HTTP-validator-specific extras ---

  /**
   * Reject requests that don't satisfy the declared
   * {@link OperationObject.security} (or document-level
   * {@link OpenAPIDocument.security} when the operation doesn't override).
   * **Shape-only**: the check confirms the request carries the declared
   * credential (e.g. a `Bearer` token in `Authorization`, the declared
   * apiKey header); it does not verify the credential itself. Credential
   * verification stays with the app's auth middleware.
   *
   * Modes:
   *
   * - `"off"` (default): no security check.
   * - `"shape"`: shape-check recognized schemes (`http` with
   *   `scheme: "bearer"` or `"basic"`, and `apiKey` in header / query /
   *   cookie). Silently passes on schemes the validator can't inspect
   *   (`oauth2`, `openIdConnect`, `mutualTLS`, HTTP digest/mutual/etc.):
   *   declaring them satisfied avoids spurious 401s on specs that use
   *   them.
   * - `"strict"`: shape-check recognized schemes; fail with a `security`
   *   leaf error on any unrecognized scheme. The strict opt-in for
   *   callers who want the gap to surface rather than silently pass.
   *
   * Real apps gate security upstream of validation: by the time the
   * validator runs, the auth middleware has already verified (or
   * rejected) the credential. Opt in to `"shape"` or `"strict"` when
   * there's no auth middleware (early dev / prototyping) or when the
   * auth layer only decorates `req` without rejecting unauthenticated
   * traffic. None of the modes substitute for actual credential
   * verification.
   */
  validateSecurity?: "off" | "shape" | "strict";
  /** When `true`, reject unknown query parameters (default: `false`). */
  strictQueryParameters?: boolean;
  /**
   * When `true`, `validateResponse` emits a `body` finding when the
   * matched response declares content but the response carries no body
   * (`res.body === undefined`). Catches the common bug where a handler
   * sends a 200 with `Content-Type: application/json` and an empty
   * body (`res.json(user)` after a lookup returned `undefined`); the
   * client then fails at parse time instead of the server failing
   * during development.
   *
   * Opt-in because OpenAPI takes no position: request bodies have a
   * `required` flag, response content does not, so an absent-body rule
   * is the validator's opinion, not the spec's. Default: `false`.
   *
   * Exemptions (never a finding even when set): HEAD requests (the
   * router answers HEAD with the GET operation, whose declared content
   * is correctly absent per RFC 9110 9.3.2), and statuses 204, 205,
   * and 304, which are bodyless by status semantics.
   */
  requireResponseBody?: boolean;
  /**
   * When `true`, an unmatched path no longer produces a `route` error;
   * `validateRequest` / `validateResponse` report the request as valid
   * (`{ valid: true }`). Mirrors
   * `express-openapi-validator`'s `ignoreUndocumented`. Does not affect
   * the `method` code: a path that matched but whose verb wasn't
   * declared still surfaces (that's a 405, not an "undocumented route").
   */
  ignoreUndocumented?: boolean;
  /**
   * Predicate for finer control than {@link ValidatorOptions.ignoreUndocumented}.
   * Runs before route matching; when it returns `true` for the request's
   * `path`, the validator short-circuits to a valid result
   * (`{ valid: true }`). Useful for
   * per-prefix allowlists ("skip anything under `/internal/`"),
   * regex-driven exclusions, or keeping parts of the surface out of
   * spec validation for staged rollout.
   *
   * When both `ignorePaths` and `ignoreUndocumented` are set,
   * `ignorePaths` runs first. If the predicate does not skip,
   * `ignoreUndocumented` still applies to a subsequent route miss.
   */
  ignorePaths?: (path: string) => boolean;
  /**
   * How to handle a spec with an unknown **minor** version inside the
   * OpenAPI 3.x line; e.g. `openapi: "3.7.0"` if a future minor ships
   * before oaverify is updated. Pure forward-compat control; does not govern
   * category errors (missing `openapi` field, wrong major), which
   * always throw unless `dialect` is set.
   *
   * - `"fallback31"` (default): accept silently; use the 3.1 dialect.
   * - `"warn"`: add an entry to {@link Validator.warnings} (and
   *   call {@link ValidatorOptions.warn} if provided) and use the 3.1
   *   dialect.
   * - `"throw"`: throw an `Error`.
   *
   * Regardless of the choice, `Validator.detectedVersion` is set to
   * `undefined` so callers can introspect after the fact.
   */
  onUnknownVersion?: "fallback31" | "warn" | "throw";
  /**
   * Optional live-output sink for warnings, called synchronously
   * during {@link createValidator} whenever a warning is emitted
   * (currently: `onUnknownVersion: "warn"` path, and the single
   * category-error-overridden-by-`dialect` case). Every warning is
   * _also_ accumulated into {@link Validator.warnings} regardless
   * of whether this callback is set.
   *
   * Default: undefined (no live sink). The library never writes to
   * `process.stderr` or `console` on its own; pass a callback if you
   * want live output. The CLI wrapper supplies one that prints to
   * stderr.
   */
  warn?: (message: string) => void;
  /**
   * Run spec-hygiene lint passes against the document at construction.
   * Findings land in {@link Validator.specHygieneIssues}; nothing is
   * thrown. Defaults to `false`.
   *
   * The same engine runs from
   * `resolveSpec` and `loadSpec` from `@oaverify/core/spec`; pick whichever layer is
   * natural for your flow. Running it in both places lints twice for
   * no benefit.
   */
  lint?: boolean;
}

/**
 * Build a {@link Validator} from a resolved OpenAPI 3.1 document.
 *
 * @param spec - The fully-resolved OpenAPI document (no external `$ref`s).
 * @param options - Tunables for the validator. See {@link ValidatorOptions}
 *   for the full set: security gating, path filtering, dialect override,
 *   error budget, custom formats and keywords, schema lint,
 *   version-mismatch handling, and a warn-output sink.
 * @returns A validator that can check individual requests and responses.
 *
 * @example
 * ```ts
 * const v = createValidator(resolvedSpec);
 * const err = v.validateRequest({ method: "POST", path: "/pets", body: {...} });
 * ```
 *
 * @see {@link ValidatorOptions}
 * @public
 */
export function createValidator(
  spec: OpenAPIDocument,
  options: ValidatorOptions & { output: "tree" },
): TreeValidator;
export function createValidator(
  spec: OpenAPIDocument,
  options: ValidatorOptions & { output: "predicate" },
): PredicateValidator;
export function createValidator(
  spec: OpenAPIDocument,
  options?: ValidatorOptions & { output?: "flat" },
): Validator;
export function createValidator(
  spec: OpenAPIDocument,
  options?: ValidatorOptions,
): Validator | TreeValidator | PredicateValidator;
export function createValidator(
  spec: OpenAPIDocument,
  options: ValidatorOptions = {},
): Validator | TreeValidator | PredicateValidator {
  if (
    options.maxErrors !== undefined &&
    Number.isFinite(options.maxErrors) &&
    (!Number.isInteger(options.maxErrors) || options.maxErrors < 1)
  ) {
    // `Infinity` is degenerate (equivalent to omitting) but harmless;
    // existing callers may pass it explicitly. Reject the values that
    // would silently break validation: 0, negatives, non-integers.
    throw new Error(
      `createValidator: \`maxErrors\` must be a positive integer (got ${String(options.maxErrors)}). ` +
        "Omit the option for fast-fail (1), or pass `Number.POSITIVE_INFINITY` to collect every error.",
    );
  }
  if (
    options.maxDepth !== undefined &&
    Number.isFinite(options.maxDepth) &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth < 1)
  ) {
    throw new Error(
      `createValidator: \`maxDepth\` must be a positive integer (got ${String(options.maxDepth)}). ` +
        "Omit the option for uncapped recursion depth.",
    );
  }
  // Resolved output shape + per-call error budget. Both mirror
  // `compileSchema`: flat output and `maxErrors: 1` by default. Each
  // per-location sub-validator is capped at `maxErrors` (bounds the work
  // per location); `reshapeResult` then enforces the per-call total.
  const outputMode = options.output ?? "flat";
  const maxErrors = options.maxErrors ?? 1;
  const paths = spec.paths ?? {};
  const router: Router = createRouter(paths);
  const formats = { ...builtInFormats, ...options.formats };

  // Warnings are accumulated passively (no I/O from the library); a
  // caller-supplied `options.warn` additionally gets them live. The
  // CLI wrapper passes a stderr-writing callback; the core library
  // never does.
  const warnings: string[] = [];
  const emitWarn = (message: string): void => {
    warnings.push(message);
    options.warn?.(message);
  };

  // Version detection is pure compile-time: we bake the right
  // dialect into the compiled validator and never branch on version
  // per request.
  //
  // Three categories of input:
  //   (1) valid 3.x spec (3.0 / 3.1 / 3.2): pick dialect, compile
  //   (2) missing openapi field / wrong major: category error, throw
  //       (unless `dialect` is set, which is the universal override)
  //   (3) valid 3.x major but unknown minor (e.g. "3.7.0"): forward
  //       compat, governed by `onUnknownVersion`
  //
  // `dialect` outranks all three. It used to be consulted only where
  // detection failed, so on a spec that declared a version it was read
  // and discarded, and a custom Dialect had no way in at all (#534).
  // Detection still runs and still fills `detectedVersion`: the option
  // decides what compiles, not what the document says it is.
  const detectedVersion = detectOpenAPIVersion(spec);
  const dialect: Dialect = (() => {
    if (detectedVersion !== undefined) return options.dialect ?? dialectFor(detectedVersion);

    // Classify the reason detection failed so we can distinguish
    // category errors from unknown-minor forward-compat.
    const rawOpenapi = (spec as { openapi?: unknown }).openapi;
    const reason = classifyUnknownVersion(rawOpenapi);

    if (reason.kind === "ok-unknown-minor") {
      if (options.dialect !== undefined) return options.dialect;
      const policy = options.onUnknownVersion ?? "fallback31";
      if (policy === "throw") {
        throw new Error(
          `createValidator: openapi: "${reason.raw}" is an unknown 3.x minor version; ` +
            "set onUnknownVersion to 'warn' or 'fallback31' to accept it, or pass `dialect` to force a specific compiler",
        );
      }
      if (policy === "warn") {
        emitWarn(
          `createValidator: openapi: "${reason.raw}" is an unknown 3.x minor version; falling back to the 3.1 dialect`,
        );
      }
      return openapi31Dialect;
    }

    // Category error: missing field, wrong major, or non-string.
    // `dialect` is the universal override; emit a warning so the
    // override is still visible but don't block compilation.
    if (options.dialect !== undefined) {
      emitWarn(`createValidator: ${reason.message}; compiling anyway because \`dialect\` was set`);
      return options.dialect;
    }
    throw new Error(`createValidator: ${reason.message}`);
  })();

  const graph = resolve(spec as unknown as SchemaOrBoolean);
  const refResolver: RefResolver = createRefResolver(graph);

  // Live array. Compile closure appends on each miss; consumers read
  // `validator.stats.schemaLintIssues` at any point to see what's been
  // flagged so far.
  const schemaLintIssues: SchemaLintIssue[] = [];
  const stats: ValidatorStats = {
    responseBodiesCompiled: 0,
    schemaLintIssues,
  };

  const compiledCache = new Map<SchemaOrBoolean, CompiledTreeSchema>();
  // `label` names what is being compiled so errors and lint issues can
  // be placed in the document. The cache is keyed by schema identity
  // alone, so a schema reached from several operations keeps the label
  // of whichever compiled it first; see SchemaLintIssue.context.
  const compile = (
    schema: SchemaOrBoolean,
    resolver: RefResolver = refResolver,
    origin?: SchemaOrigin,
  ): CompiledTreeSchema => {
    const cached = compiledCache.get(schema);
    if (cached !== undefined) return cached;
    const c = compileSchema(schema, {
      label: origin?.label,
      pointer: origin?.pointer,
      pointerAnchor: origin?.anchor,
      dialect,
      formats,
      refResolver: resolver,
      // The validator builds a nested per-location tree internally and
      // reshapes it to the requested `output` at the boundary, so the
      // sub-validators always compile in tree mode. Each is capped at the
      // per-call `maxErrors` (a per-location bound that prevents a single
      // huge location from running away); `reshapeResult` then enforces
      // the per-call total across all locations.
      output: "tree",
      maxErrors,
      maxDepth: options.maxDepth,
      keywords: options.keywords,
      schemaLint: options.schemaLint,
      regexCompiler: options.regexCompiler,
    });
    compiledCache.set(schema, c);
    for (const issue of c.stats.schemaLintIssues) schemaLintIssues.push(issue);
    return c;
  };

  // Per-direction transform caches: readOnly/writeOnly are direction-
  // sensitive, so the same schema object produces two differently-clipped
  // clones (one with readOnly properties forbidden, one with writeOnly).
  // Keyed by the original schema identity; reused across operations.
  // The direction resolvers project the same transform across every
  // `$ref` target so inherited `properties` / `required` from composed
  // schemas (`allOf: [{ $ref: ... }]`) are transformed too.
  const directionTransformCache = {
    request: new Map<SchemaOrBoolean, SchemaOrBoolean>(),
    response: new Map<SchemaOrBoolean, SchemaOrBoolean>(),
  };
  const directionResolvers = {
    request: createDirectionResolver(refResolver, "request", directionTransformCache.request),
    response: createDirectionResolver(refResolver, "response", directionTransformCache.response),
  };
  const compileForDirection = (
    schema: SchemaOrBoolean,
    direction: BodyDirection,
    origin?: SchemaOrigin,
  ): CompiledTreeSchema =>
    compile(
      transformBodySchemaForDirection(
        schema,
        direction,
        refResolver,
        directionTransformCache[direction],
      ),
      directionResolvers[direction],
      {
        label: origin?.label,
        // The one place the pointer is not the use site. A body whose
        // schema is a bare root `$ref` is unwrapped before compiling,
        // so findings are relative to the target and the use site holds
        // no `properties` to address (#517, defect 3c).
        ...bodySchemaCompiledPointer(schema, refResolver, origin?.pointer, origin?.anchor),
      },
    );

  // Look up a response-side validator, compiling on first access and
  // memoizing into the passed cache. Shared by body and header paths.
  // `direction` controls readOnly/writeOnly enforcement: response bodies
  // get the "response" transform (writeOnly properties forbidden);
  // response headers are direction-agnostic.
  const getResponseValidator = (
    cache: Map<string, CompiledTreeSchema>,
    schemas: Map<string, SchemaOrBoolean>,
    key: string,
    direction?: BodyDirection,
    response?: ResponseCompiled,
  ): CompiledTreeSchema | undefined => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const schema = schemas.get(key);
    if (schema === undefined) return undefined;
    // `direction === undefined` is the header path; bodies carry a media
    // type, headers a name.
    const context = response?.context;
    const label =
      context === undefined
        ? undefined
        : direction === undefined
          ? `${context} header "${key}"`
          : `${context} body (${key})`;
    // Headers are addressed from their own entry, which already
    // accounts for a `$ref`'d Header Object; bodies hang off the
    // response.
    const header = direction === undefined ? response?.headers.get(key) : undefined;
    const pointer =
      direction === undefined
        ? header?.pointer === undefined
          ? undefined
          : `${header.pointer}/schema`
        : response?.pointer === undefined
          ? undefined
          : `${response.pointer}/content/${escapePointer(key)}/schema`;
    const origin: SchemaOrigin = {
      label,
      pointer,
      anchor: direction === undefined ? header?.anchor : response?.anchor,
    };
    const c =
      direction === undefined
        ? compile(schema, refResolver, origin)
        : compileForDirection(schema, direction, origin);
    cache.set(key, c);
    if (direction === "response") stats.responseBodiesCompiled += 1;
    return c;
  };

  const resolveRef = <T>(value: T | ReferenceObject | undefined): T | undefined =>
    resolveOperationRef<T>(spec, value);

  const operationCache = new WeakMap<OperationObject, OperationCache>();

  const securityMode = normalizeSecurityMode(options.validateSecurity);

  /**
   * Compile one operation's request side. `onCompileError` turns each
   * schema into its own guarded unit; see
   * {@link OperationCacheDeps.onCompileError}. The result is not
   * memoized, since a cache built with a collector may be missing
   * validators.
   */
  const buildCache = (
    pathMatch: RouteMatch,
    onCompileError?: (origin: SchemaOrigin, err: unknown) => void,
  ): OperationCache => {
    const cache = buildOperationCache(pathMatch, {
      resolveRef,
      // The cache builder has no business choosing a ref resolver, so it
      // sees a two-argument `compile` and the default resolver is bound
      // here.
      compile: (schema, origin) => compile(schema, refResolver, origin),
      bodySchemaOrigin: (schema, origin) => ({
        ...origin,
        ...bodySchemaCompiledPointer(schema, refResolver, origin.pointer, origin.anchor),
      }),
      compileForDirection,
      onCompileError,
    });
    if (securityMode !== "off") {
      const build = (): void => {
        cache.security = compileOperationSecurity(
          pathMatch.operation,
          spec,
          resolveRef,
          securityMode,
        );
      };
      if (onCompileError === undefined) build();
      else {
        try {
          build();
        } catch (err) {
          onCompileError({ label: `${operationLabel(pathMatch)} security` }, err);
        }
      }
    }
    return cache;
  };

  const cacheFor = (pathMatch: RouteMatch): OperationCache => {
    const existing = operationCache.get(pathMatch.operation);
    if (existing !== undefined) return existing;
    const cache = buildCache(pathMatch);
    operationCache.set(pathMatch.operation, cache);
    return cache;
  };

  /**
   * Resolve a request to its route, applying the path filters and the
   * 404-vs-405 distinction. Request and response validation share this so
   * the two stay in step; changing how `ignorePaths` and
   * `ignoreUndocumented` interact, or which error a route miss produces,
   * is a single edit.
   *
   * `"skip"` means a filter opted the path out and validation should
   * report no error at all, which is distinct from `"error"` carrying a
   * `route` or `method` leaf.
   */
  const resolveRoute = (
    req: HttpRequest,
  ):
    | { kind: "skip" }
    | { kind: "error"; error: ValidationError }
    | { kind: "match"; match: RouteMatch } => {
    if (options.ignorePaths?.(req.path) === true) return { kind: "skip" };
    const match = router.match(req.method, req.path);
    if (match === undefined) {
      if (options.ignoreUndocumented === true) return { kind: "skip" };
      return {
        kind: "error",
        error: createLeafError(
          "route",
          [],
          `no route matches ${req.method.toUpperCase()} ${req.path}`,
          { method: req.method, path: req.path },
        ),
      };
    }
    if (match.kind === "method-not-allowed") {
      return {
        kind: "error",
        error: createLeafError(
          "method",
          [],
          `method ${req.method.toUpperCase()} not allowed on ${match.pathPattern}; allowed: ${match.allowed.join(", ")}`,
          { method: req.method, pathPattern: match.pathPattern, allowed: match.allowed },
        ),
      };
    }
    return { kind: "match", match };
  };

  const validateRequestTree = (req: HttpRequest): ValidationError | null => {
    const routed = resolveRoute(req);
    if (routed.kind === "skip") return null;
    if (routed.kind === "error") return routed.error;
    const match = routed.match;
    const cache = cacheFor(match);
    const children: ValidationError[] = [];

    // Security check first and short-circuit: an auth failure makes
    // every parameter / body diagnostic noise, and the client can't act
    // on the latter without fixing the former.
    if (cache.security !== undefined) {
      const securityErr = checkSecurity(cache.security, req);
      if (securityErr !== null) {
        return createBranchError(
          "request",
          [],
          `${req.method.toUpperCase()} ${match.pathPattern}: request validation failed`,
          [securityErr],
          { method: req.method, pathPattern: match.pathPattern },
        );
      }
    }

    // Content-type gate: if the request carries a body whose
    // Content-Type doesn't match any declared media type, short-circuit
    // with a single leaf. Parameter / body schema diagnostics against a
    // request the server can't parse in the first place are noise.
    const bodyMediaTypeOrErr = matchRequestBodyMediaType(req, cache);
    if (bodyMediaTypeOrErr !== null && typeof bodyMediaTypeOrErr !== "string") {
      return createBranchError(
        "request",
        [],
        `${req.method.toUpperCase()} ${match.pathPattern}: request validation failed`,
        [bodyMediaTypeOrErr],
        { method: req.method, pathPattern: match.pathPattern },
      );
    }

    for (const p of cache.parameters) {
      const err = validateParameter(p, req, match, cache);
      if (err !== null) children.push(err);
    }

    if (cache.requestBody !== undefined) {
      const err = validateBody(
        req,
        cache,
        typeof bodyMediaTypeOrErr === "string" ? bodyMediaTypeOrErr : undefined,
      );
      if (err !== null) children.push(err);
    }

    if (options.strictQueryParameters && req.query) {
      const known = cache.knownQueryParameters;
      for (const key of Object.keys(req.query)) {
        if (!known.has(key)) {
          children.push(
            createLeafError("query-param", ["query", key], `unknown query parameter "${key}"`, {
              name: key,
              in: "query",
            }),
          );
        }
      }
    }

    if (children.length === 0) return null;
    return createBranchError(
      "request",
      [],
      `${req.method.toUpperCase()} ${match.pathPattern}: request validation failed`,
      children,
      { method: req.method, pathPattern: match.pathPattern },
    );
  };

  const validateResponseTree = (req: HttpRequest, res: HttpResponse): ValidationError | null => {
    const routed = resolveRoute(req);
    if (routed.kind === "skip") return null;
    if (routed.kind === "error") return routed.error;
    const match = routed.match;
    const cache = cacheFor(match);
    const children: ValidationError[] = [];

    const statusKey = matchResponseKey(res.status, cache.responses);
    if (statusKey === undefined) {
      children.push(
        createLeafError("status", [], `no response defined for status ${res.status}`, {
          status: res.status,
        }),
      );
    } else {
      const responseCompiled = cache.responses.get(statusKey);
      if (responseCompiled !== undefined) {
        if (responseCompiled.headers.size > 0) {
          const headers = res.headers ?? {};
          for (const [lowered, entry] of responseCompiled.headers) {
            const hdr = entry.object;
            const name = entry.name;
            const raw = responseCompiled.headerReadsRequireOwnProperties
              ? getHeaderValue(headers, name)
              : getHeaderValueFast(headers, name);
            if (hdr.required && (raw === undefined || raw === "")) {
              children.push(
                createLeafError(
                  "header-param",
                  ["header", name],
                  `missing required header "${name}"`,
                  {
                    name,
                    in: "header",
                  },
                ),
              );
              continue;
            }
            if (raw === undefined) continue;
            const validator = getResponseValidator(
              responseCompiled.headerValidators,
              responseCompiled.headerSchemas,
              lowered,
              undefined,
              responseCompiled,
            );
            if (validator === undefined) continue;
            const value = deserialize(raw, {
              name,
              in: "header",
              schema: hdr.schema,
              style: hdr.style,
              explode: hdr.explode,
            });
            const r = validator.validate(value, ["header", name]);
            if (!r.valid && r.error !== undefined) {
              children.push(r.error);
            }
          }
        }

        if (responseCompiled.bodySchemas.size > 0 && res.body === undefined) {
          // Opt-in absent-body finding. HEAD answers against the GET
          // operation, whose declared content is correctly absent
          // (RFC 9110 9.3.2); 204 / 205 / 304 are bodyless by status
          // semantics regardless of declared content.
          if (
            options.requireResponseBody === true &&
            req.method.toUpperCase() !== "HEAD" &&
            res.status !== 204 &&
            res.status !== 205 &&
            res.status !== 304
          ) {
            children.push(
              createLeafError(
                "body",
                ["body"],
                `response for status ${statusKey} declares content but no body was sent`,
                {},
              ),
            );
          }
        }

        if (responseCompiled.bodySchemas.size > 0 && res.body !== undefined) {
          const mt = matchParsedMediaType(res.contentType, responseCompiled.bodyMediaTypes);
          if (mt === undefined) {
            children.push(
              createLeafError(
                "content-type",
                ["body"],
                `response Content-Type "${res.contentType ?? "<missing>"}" is not declared for status ${statusKey}`,
                {
                  contentType: res.contentType,
                  declared: [...responseCompiled.bodySchemas.keys()],
                },
              ),
            );
          } else {
            const validator = getResponseValidator(
              responseCompiled.bodyValidators,
              responseCompiled.bodySchemas,
              mt,
              "response",
              responseCompiled,
            );
            if (validator !== undefined) {
              const r = validator.validate(res.body, ["body"]);
              if (!r.valid && r.error !== undefined) {
                children.push(r.error);
              }
            }
          }
        }
      }
    }

    if (children.length === 0) return null;
    return createBranchError(
      "response",
      [],
      `${req.method.toUpperCase()} ${match.pathPattern}: response validation failed`,
      children,
      { status: res.status },
    );
  };

  // Public, output-shaped entry points: build the internal tree, then
  // reshape to the requested output and per-call error budget.
  const validateRequest = (req: HttpRequest): ValidationResult | TreeValidationResult | boolean =>
    reshapeResult(validateRequestTree(req), outputMode, maxErrors);
  const validateResponse = (
    req: HttpRequest,
    res: HttpResponse,
  ): ValidationResult | TreeValidationResult | boolean =>
    reshapeResult(validateResponseTree(req, res), outputMode, maxErrors);

  const validateFetchRequest = async <T>(request: Request, fetchOptions?: FetchRequestOptions) => {
    const { httpRequest, body } = await httpRequestFromFetch(request, fetchOptions);
    return toFetchResult<T>(validateRequest(httpRequest), body);
  };

  const validateFetchResponse = async <T>(request: Request, response: Response) => {
    // Build an HttpRequest from the fetch Request without reading its
    // body; we only need method + path to match the operation.
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const httpRequest: HttpRequest = { method, path: url.pathname };
    const { httpResponse, body } = await httpResponseFromFetch(response);
    return toFetchResult<T>(validateResponse(httpRequest, httpResponse), body);
  };

  const getOperation = (req: {
    method: string;
    path: string;
  }): { pathPattern: string; pathItem: PathItem; operation: OperationObject } | null => {
    const match = router.match(req.method, req.path);
    if (match === undefined || match.kind === "method-not-allowed") return null;
    // Warm the per-operation cache so `getOperation` and subsequent
    // validation share a single compiled plan. Doesn't force response
    // compilation (still lazy on first `validateResponse`).
    cacheFor(match);
    return {
      pathPattern: match.pathPattern,
      pathItem: match.pathItem,
      operation: match.operation,
    };
  };

  const matchRoute = (req: { method: string; path: string }): RouteMatchResult => {
    const match = router.match(req.method, req.path);
    if (match === undefined) return { kind: "no-match" };
    if (match.kind === "method-not-allowed") {
      return { kind: "method-not-allowed", pathPattern: match.pathPattern, allowed: match.allowed };
    }
    return { kind: "match", pathPattern: match.pathPattern };
  };

  const specHygieneIssues: readonly SpecHygieneIssue[] = options.lint
    ? Object.freeze(lintResolvedSpec(spec))
    : [];

  // The runtime methods return the `output`-dependent union; the
  // overloads above resolve the precise interface for callers. The cast
  // bridges the two: `outputMode` determines the real shape, which TS
  /**
   * Compile every operation's schemas up front, instead of on first
   * access.
   *
   * Compilation is normally lazy, and response bodies are lazier still:
   * a spec with hundreds of operations pays for only the pairings its
   * traffic actually exercises. That is right for a server and wrong for
   * a tool that wants to inspect the whole document, because until a
   * schema compiles it has neither been checked for well-formedness nor
   * contributed to {@link ValidatorStats.schemaLintIssues}.
   *
   * Call this to make both complete:
   *
   * - A malformed schema anywhere in the document throws here, with its
   *   path, rather than on the first request that happens to reach it.
   * - `stats.schemaLintIssues` afterwards covers the whole document
   *   rather than the parts already touched.
   *
   * Idempotent, and unnecessary on the request path: everything it
   * compiles is memoized in the same caches lazy compilation fills, so
   * calling it changes when the work happens, not how much.
   */
  const precompile = (options?: {
    onMalformed?: "throw" | "collect";
  }): readonly PrecompileFailure[] => {
    const collect = options?.onMalformed === "collect";
    const failures: PrecompileFailure[] = [];
    // Each unit is compiled inside its own guard so one malformed schema
    // costs its own operation and nothing else. Without it the first bad
    // schema in a document hid every finding behind it (#515).
    const attempt = (origin: SchemaOrigin, run: () => void): void => {
      if (!collect) {
        run();
        return;
      }
      try {
        run();
      } catch (err) {
        failures.push(failureFrom(origin, err));
      }
    };

    for (const route of router.routes()) {
      const match = router.match(route.method, route.pathPattern);
      if (match === undefined || match.kind !== "match") continue;
      const where = `${route.method} ${route.pathPattern}`;
      let cache: OperationCache | undefined;
      if (!collect) {
        cache = cacheFor(match);
      } else {
        // Each request-side schema is its own guarded unit, so one bad
        // parameter costs itself rather than the operation. Previously
        // the whole build was one unit: a malformed parameter left no
        // cache, the response loops below were skipped, and every
        // finding in the operation was lost with no sign in the output
        // that it had been graded at all (#527).
        const before = failures.length;
        attempt({ label: where, pointer: operationPointer(match) }, () => {
          cache = buildCache(match, (origin, err) => {
            failures.push(failureFrom(origin, err));
          });
        });
        if (cache === undefined) continue;
        // A cache missing the validators that failed must never serve a
        // request, where the skipped schema would go unvalidated. Only a
        // clean build is memoized; a degraded one is used to drive the
        // response side here and then dropped, so a later request
        // rebuilds and throws as it should.
        if (failures.length === before) operationCache.set(match.operation, cache);
      }
      if (cache === undefined) continue;
      // Request-side schemas are compiled by cacheFor. Response bodies
      // and headers are not, so drive their lazy getters here.
      for (const [status, response] of cache.responses) {
        for (const mediaType of response.bodySchemas.keys()) {
          attempt(responseBodyOrigin(response, mediaType), () => {
            getResponseValidator(
              response.bodyValidators,
              response.bodySchemas,
              mediaType,
              "response",
              response,
            );
          });
        }
        for (const name of response.headerSchemas.keys()) {
          attempt(responseHeaderOrigin(response, name), () => {
            getResponseValidator(
              response.headerValidators,
              response.headerSchemas,
              name,
              undefined,
              response,
            );
          });
        }
        void status;
      }
    }
    return failures;
  };

  // can't track from the value back to the literal overload.
  return {
    validateRequest,
    validateResponse,
    validateFetchRequest,
    validateFetchResponse,
    getOperation,
    matchRoute,
    precompile,
    routes: router.routes(),
    detectedVersion,
    output: outputMode,
    warnings,
    specHygieneIssues,
    stats,
  } as unknown as Validator | TreeValidator | PredicateValidator;
}
