import {
  createLeafError,
  type HttpRequest,
  type HttpResponse,
  type OpenAPIVersion,
  type OperationObject,
  type PathItem,
} from "@oaverify/internal-core";
import { routeSignature, type RouteInfo } from "@oaverify/internal-router";
import type { SpecHygieneIssue } from "@oaverify/internal-spec";
import type { TreeValidationResult, ValidationResult } from "@oaverify/internal-schema";
import {
  FetchBodyParseError,
  httpRequestFromFetch,
  httpResponseFromFetch,
  type FetchRequestOptions,
} from "./from-fetch.js";
import { fetchBodyParseFailure, reshapeResult, toFetchResult } from "./reshape.js";
import type {
  PredicateValidator,
  RouteMatchResult,
  TreeValidator,
  Validator,
  ValidatorStats,
} from "./validator.js";

/**
 * Options for {@link combineValidators}.
 *
 * The composite is itself a {@link Validator}, so its skip vocabulary
 * mirrors {@link ValidatorOptions}: `ignoreUndocumented` and
 * `ignorePaths` here govern routes that NO member owns (undocumented
 * with respect to the whole composite). A route a member does own is
 * delegated to that member, whose own `ignoreUndocumented` / `ignorePaths`
 * still apply.
 *
 * @public
 */
export interface CombineOptions {
  /**
   * Policy when more than one member declares the same route (same
   * method and structurally-equal path, so `/x/{id}` and `/x/{slug}`
   * count as the same route).
   *
   * - `"first-match"` (default): the earliest member in array order
   *   wins; later validators never see the request. Mirrors the matcher's
   *   specificity-ordered scan, lifted to the member level.
   * - `"error"`: assert disjointness at construction. `combineValidators`
   *   throws if any route is owned by two validators, surfacing the clash
   *   at assembly time instead of letting first-match silently shadow.
   *   A GET route also reserves the HEAD cell (RFC 9110 §9.3.2), so a
   *   member's GET and another member's explicit HEAD on a
   *   structurally-equal path count as an overlap.
   */
  onOverlap?: "first-match" | "error";
  /**
   * No-owner skip policy. A request whose route no member owns is
   * undocumented with respect to the composite. `false` (default,
   * matching a single validator) produces a `route` error; `true`
   * passes (`{ valid: true }`). Members' own
   * {@link ValidatorOptions.ignoreUndocumented} governs only their owned
   * routes, reached via delegation, not this no-owner case.
   */
  ignoreUndocumented?: boolean;
  /**
   * Validate-time predicate, mirroring {@link ValidatorOptions.ignorePaths}.
   * Runs before dispatch; when it returns `true` the composite
   * short-circuits to a valid result without consulting any member.
   */
  ignorePaths?: (path: string) => boolean;
}

/**
 * The subset of the {@link Validator} surface `combineValidators` reads
 * from its validators. `Validator`, {@link TreeValidator}, and
 * {@link PredicateValidator} are all structurally assignable to it (their
 * narrower `validate*` returns widen into the union here), so the public
 * overloads accept each concrete kind while the implementation works
 * against this one shape. The Fetch wrappers are omitted deliberately:
 * the composite rebuilds them from `validateRequest` / `validateResponse`
 * rather than delegating, so it never calls a member's Fetch methods.
 */
interface CombinableValidator {
  validateRequest(req: HttpRequest): ValidationResult | TreeValidationResult | boolean;
  validateResponse(
    req: HttpRequest,
    res: HttpResponse,
  ): ValidationResult | TreeValidationResult | boolean;
  getOperation(req: { method: string; path: string }): {
    pathPattern: string;
    pathItem: PathItem;
    operation: OperationObject;
  } | null;
  matchRoute(req: { method: string; path: string }): RouteMatchResult;
  readonly routes: readonly RouteInfo[];
  readonly output: "flat" | "tree" | "predicate";
  readonly warnings: readonly string[];
  readonly specHygieneIssues: readonly SpecHygieneIssue[];
  readonly detectedVersion: OpenAPIVersion | undefined;
  readonly stats: ValidatorStats;
}

// A GET resource also answers HEAD (RFC 9110 §9.3.2): the matcher honours
// this at match time, and its intra-document ambiguity check reserves the
// HEAD cell for a GET-only path. `routes` reports only declared operations
// (no implicit HEAD), so the cross-member overlap scan expands a GET
// without an explicit HEAD sibling into a synthetic HEAD entry, matching
// the matcher's rule. Without it, a GET in one member and an explicit HEAD
// on a structurally-equal path in another slip past the check and let
// first-match silently shadow the explicit HEAD.
function effectiveRoutes(routes: readonly RouteInfo[]): RouteInfo[] {
  const explicitHead = new Set<string>();
  for (const r of routes) {
    if (r.method === "HEAD") explicitHead.add(routeSignature(r.pathPattern));
  }
  const expanded: RouteInfo[] = [...routes];
  for (const r of routes) {
    if (r.method === "GET" && !explicitHead.has(routeSignature(r.pathPattern))) {
      expanded.push({ method: "HEAD", pathPattern: r.pathPattern });
    }
  }
  return expanded;
}

/**
 * Stack several validators into one that dispatches each request to the
 * member that owns its route, so multiple OpenAPI documents validate
 * through a single {@link Validator}.
 *
 * Built for multi-document deployments: load each spec into its own
 * validator (each keeps its own dialect, components, and compiled
 * plans, so cross-spec component-name clashes can't occur), then
 * `combineValidators([a, b, c])` to get one validator the framework
 * adapters consume unchanged. `validateRequests(combineValidators([...]))`
 * replaces a stack of per-spec middlewares; a future `validateResponses`
 * takes the same composite.
 *
 * Dispatch keys on route ownership ({@link Validator.matchRoute}), not on
 * a member's validation verdict, so a member configured with
 * `ignoreUndocumented` can't pre-empt the member that actually owns the
 * route. A real match wins; failing that, a member whose path matched but
 * whose method isn't declared (405) still owns the path, so the request is
 * delegated to it and surfaces as a method error rather than being
 * laundered into the undocumented-route bypass. The owning member's
 * `validateRequest` / `validateResponse` is then called in full, so its
 * own `ignorePaths` / content-type / schema logic runs exactly as it would
 * standalone. Only a true no-match (no member's path matched) is
 * undocumented with respect to the composite and handled per
 * {@link CombineOptions.ignoreUndocumented}.
 *
 * All validators must share an `output` mode; mixing throws at construction
 * (the composite presents one result shape). An empty array throws.
 *
 * @param validators - Validators to combine, in first-match priority order.
 * @param options - Overlap policy and no-owner skip policy.
 * @returns A validator of the validators' shared output kind.
 *
 * @example
 * ```ts
 * const v1 = createValidator(specV1);
 * const v2 = createValidator(specV2);
 * const validator = combineValidators([v1, v2], { onOverlap: "error" });
 * app.use(validateRequests(validator));
 * ```
 *
 * @public
 */
export function combineValidators(
  validators: TreeValidator[],
  options?: CombineOptions,
): TreeValidator;
export function combineValidators(
  validators: PredicateValidator[],
  options?: CombineOptions,
): PredicateValidator;
export function combineValidators(validators: Validator[], options?: CombineOptions): Validator;
export function combineValidators(
  validators: CombinableValidator[],
  options: CombineOptions = {},
): Validator | TreeValidator | PredicateValidator {
  if (validators.length === 0) {
    throw new Error(
      "combineValidators: at least one validator is required (received an empty array).",
    );
  }

  // One output mode across all validators: the composite presents a single
  // result shape, and the typed overloads resolve to it. Mixing is a
  // construction mistake, so fail at the seam rather than reshape per
  // request.
  const outputMode = validators[0]!.output;
  for (let i = 1; i < validators.length; i += 1) {
    if (validators[i]!.output !== outputMode) {
      throw new Error(
        `combineValidators: all validators must share an output mode; validators[0] is "${outputMode}" ` +
          `but validators[${i}] is "${validators[i]!.output}". Build each validator with the same \`output\` option.`,
      );
    }
  }

  // Optional startup assertion that the validators are route-disjoint.
  // Structural (parameter-name-insensitive), so /x/{id} and /x/{slug}
  // count as the same routing cell, matching the matcher's own
  // intra-document ambiguity rule.
  if (options.onOverlap === "error") {
    const seen = new Map<string, { index: number; pathPattern: string }>();
    validators.forEach((member, index) => {
      for (const { method, pathPattern } of effectiveRoutes(member.routes)) {
        const key = `${method}\t${routeSignature(pathPattern)}`;
        const prior = seen.get(key);
        if (prior !== undefined) {
          throw new Error(
            `combineValidators: route overlap with onOverlap: "error": validators[${prior.index}] ` +
              `(${method} ${prior.pathPattern}) and validators[${index}] (${method} ${pathPattern}) ` +
              "own the same route. Make the specs path-disjoint, or drop onOverlap to let first-match win.",
          );
        }
        seen.set(key, { index, pathPattern });
      }
    });
  }

  const ignoreUndocumented = options.ignoreUndocumented === true;

  // First member that owns the route (first-match-wins by array order).
  // Keys on matchRoute (route ownership), never on a validate verdict,
  // so a non-owning member's ignoreUndocumented / ignorePaths can't
  // shadow the real owner.
  //
  // A real match wins outright. With no real match, a member whose path
  // matched but whose method isn't declared (405) still owns the path:
  // delegate to the first such member so its own validateRequest emits
  // the method error, reproducing single-validator semantics. Only a
  // true no-match (no member's path matched) falls through to
  // `noOwnerResult`, where `ignoreUndocumented` applies. This keeps a
  // wrong-method hit on an owned path a 405 rather than laundering it
  // into the undocumented-route bypass.
  const ownerFor = (req: { method: string; path: string }): CombinableValidator | undefined => {
    let methodNotAllowed: CombinableValidator | undefined;
    for (const member of validators) {
      const m = member.matchRoute(req);
      if (m.kind === "match") return member;
      if (m.kind === "method-not-allowed" && methodNotAllowed === undefined) {
        methodNotAllowed = member;
      }
    }
    return methodNotAllowed;
  };

  // The composite's own no-owner result, mirroring a single validator's
  // undocumented-route handling. A single `route` leaf, so the per-call
  // error budget is irrelevant; Infinity keeps `truncated` false (there
  // is nothing more to find).
  const noOwnerResult = (req: HttpRequest): ValidationResult | TreeValidationResult | boolean => {
    if (ignoreUndocumented) return reshapeResult(null, outputMode, Number.POSITIVE_INFINITY);
    const error = createLeafError(
      "route",
      [],
      `no route matches ${req.method.toUpperCase()} ${req.path}`,
      { method: req.method, path: req.path },
    );
    return reshapeResult(error, outputMode, Number.POSITIVE_INFINITY);
  };

  const validateRequest = (req: HttpRequest): ValidationResult | TreeValidationResult | boolean => {
    if (options.ignorePaths?.(req.path) === true) {
      return reshapeResult(null, outputMode, Number.POSITIVE_INFINITY);
    }
    const owner = ownerFor(req);
    return owner !== undefined ? owner.validateRequest(req) : noOwnerResult(req);
  };

  const validateResponse = (
    req: HttpRequest,
    res: HttpResponse,
  ): ValidationResult | TreeValidationResult | boolean => {
    if (options.ignorePaths?.(req.path) === true) {
      return reshapeResult(null, outputMode, Number.POSITIVE_INFINITY);
    }
    const owner = ownerFor(req);
    return owner !== undefined ? owner.validateResponse(req, res) : noOwnerResult(req);
  };

  const validateFetchRequest = async <T>(request: Request, fetchOptions?: FetchRequestOptions) => {
    let extracted;
    try {
      extracted = await httpRequestFromFetch(request, fetchOptions);
    } catch (err) {
      // Same verdict a member validator would have returned on its own,
      // so a caller moving from one validator to a composite of that
      // validator sees no change. The parse fails before routing, so no
      // member owns the request yet and the `returnValues` channel a
      // member might have is unreachable; the composite's own surface
      // never promised one.
      if (err instanceof FetchBodyParseError) {
        return fetchBodyParseFailure<T>(err, outputMode, Number.POSITIVE_INFINITY);
      }
      throw err;
    }
    const { httpRequest, body } = extracted;
    const result = validateRequest(httpRequest);
    const fetchResult = toFetchResult<T>(result, body);
    // Forward the owning member's `returnValues` channel. A composite
    // has no `returnValues` option of its own; it hands back whatever
    // the member that owned the route produced. `toFetchResult`'s
    // failure branch rest-spreads the result and picks `value` up on its
    // own, while its success branch builds a fresh literal and drops it,
    // so forwarding explicitly is what keeps the two branches agreeing.
    if (typeof result === "object" && "value" in result) {
      (fetchResult as { value?: unknown }).value = (result as { value?: unknown }).value;
    }
    return fetchResult;
  };

  const validateFetchResponse = async <T>(request: Request, response: Response) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const httpRequest: HttpRequest = { method, path: url.pathname };
    const { httpResponse, body } = await httpResponseFromFetch(response);
    return toFetchResult<T>(validateResponse(httpRequest, httpResponse), body);
  };

  const getOperation = (req: { method: string; path: string }) => {
    for (const member of validators) {
      const op = member.getOperation(req);
      if (op !== null) return op;
    }
    return null;
  };

  // Composite routing verdict: a real match in any member wins; failing
  // that, a member whose path matched (405) makes the composite a 405
  // too, unioning the allowed methods across every such member; only a
  // total miss is `no-match`. Mirrors `ownerFor`'s precedence.
  const matchRoute = (req: { method: string; path: string }): RouteMatchResult => {
    let methodNotAllowed: { pathPattern: string } | undefined;
    const allowed = new Set<string>();
    for (const member of validators) {
      const m = member.matchRoute(req);
      if (m.kind === "match") return m;
      if (m.kind === "method-not-allowed") {
        if (methodNotAllowed === undefined) methodNotAllowed = { pathPattern: m.pathPattern };
        for (const a of m.allowed) allowed.add(a);
      }
    }
    if (methodNotAllowed !== undefined) {
      return {
        kind: "method-not-allowed",
        pathPattern: methodNotAllowed.pathPattern,
        allowed: [...allowed],
      };
    }
    return { kind: "no-match" };
  };

  // Static introspection is concatenated once (validators freeze these at
  // their own construction); `detectedVersion` collapses to the shared
  // value or `undefined` when validators disagree.
  const firstVersion = validators[0]!.detectedVersion;
  const detectedVersion = validators.every((m) => m.detectedVersion === firstVersion)
    ? firstVersion
    : undefined;

  const combined = {
    validateRequest,
    validateResponse,
    validateFetchRequest,
    validateFetchResponse,
    getOperation,
    matchRoute,
    routes: Object.freeze(validators.flatMap((m) => [...m.routes])),
    detectedVersion,
    output: outputMode,
    warnings: Object.freeze(validators.flatMap((m) => [...m.warnings])),
    specHygieneIssues: Object.freeze(validators.flatMap((m) => [...m.specHygieneIssues])),
    // Live: response bodies compile lazily, so read validators' counters on
    // each access rather than snapshotting at construction.
    get stats(): ValidatorStats {
      return {
        responseBodiesCompiled: validators.reduce((n, m) => n + m.stats.responseBodiesCompiled, 0),
        schemaLintIssues: validators.flatMap((m) => [...m.stats.schemaLintIssues]),
      };
    },
  };

  return combined as unknown as Validator | TreeValidator | PredicateValidator;
}
