import {
  setSpecKey,
  type HttpMethod,
  type OperationObject,
  type PathItem,
} from "@oaverify/internal-core";

/**
 * Decode a single path token, tolerating malformed percent-encoding.
 *
 * `decodeURIComponent` throws `URIError` on bad escapes (`%`, `%zz`),
 * and a request path is attacker-controlled, so an unguarded decode
 * turns a malformed URL into a thrown exception that escapes
 * `validateRequest`. Falling back to the raw token keeps matching
 * total: a malformed token simply fails to equal any literal segment
 * (yielding the normal 404) instead of crashing.
 *
 * Spec-side literal segments decode through here too. A path template
 * such as `/bad%zz` used to throw `URIError` straight out of
 * `createValidator`; now it parses to its raw form, and the malformed
 * escape is reported as a located `path-template-malformed` finding by
 * `lintResolvedSpec` rather than as a crash with no location.
 */
function decodePathToken(token: string): string {
  // No "%" means nothing to decode; skip the decodeURIComponent call
  // (and its per-token try frame) on the overwhelmingly common case.
  if (!token.includes("%")) return token;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

/**
 * Strip leading and trailing `/` from a path or template.
 *
 * Replaces the obvious `.replace(/^\/+/, "").replace(/\/+$/, "")`, which
 * is quadratic on a request path carrying a long interior run of
 * slashes: `/\/+$/` has no anchor to pin it, so the engine retries the
 * `+` at every slash in the run and fails the `$` each time. A path of
 * `"a" + "/".repeat(32000) + "b"` costs roughly 400ms of event loop,
 * and `match` takes the path straight off the request
 * (GHSA-class polynomial ReDoS; CodeQL js/polynomial-redos).
 *
 * A leading run alone is harmless, since `/^\/+/` is anchored and runs
 * first. The interior run is what bites, which makes the bug easy to
 * miss when probing by hand.
 *
 * Scanning from both ends is also ~5x faster than the two `.replace`
 * calls on ordinary paths: no regex machinery, and no allocation at all
 * when there is nothing to trim.
 */
function trimSlashes(s: string): string {
  const SLASH = 47; // "/"
  let start = 0;
  let end = s.length;
  while (end > start && s.charCodeAt(end - 1) === SLASH) end -= 1;
  while (start < end && s.charCodeAt(start) === SLASH) start += 1;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/**
 * Segments of a parsed OpenAPI path template. Three kinds:
 *
 * - `literal`: a fixed substring (`pets`).
 * - `template`: a single `{name}` parameter occupying the whole
 *   segment (`{petId}`).
 * - `compound`: multiple `{name}` parameters interleaved with literal
 *   text inside one segment (`{sha}.{diffType}`,
 *   `{year}-{month}.json`). Carries a pre-compiled regex with one
 *   non-greedy capture group per template part so the matcher stays a
 *   single `.exec` per segment in the hot path.
 *
 * Spec basis: OpenAPI 3.0 / 3.1 / 3.2 path templating only requires
 * that template expressions be delimited by `{}`; multiple per segment
 * with literal separators are spec-legal (cf. RFC 6570). Mainstream
 * routers (path-to-regexp, hono, find-my-way, gorilla/mux, werkzeug)
 * all use the non-greedy left-to-right rule modeled here.
 *
 * @public
 */
export type Segment =
  | { kind: "literal"; value: string }
  | { kind: "template"; name: string }
  | { kind: "compound"; regex: RegExp; names: string[]; raw: string };

/**
 * Result of a successful route match: the path template matched *and*
 * the requested method is declared on it.
 *
 * `operation` and `pathItem` are the identical references supplied to
 * {@link createRouter}. Downstream consumers (notably `@oaverify/internal-validator`)
 * key per-operation caches on `operation`'s object identity via
 * `WeakMap`, so any future router change must preserve that identity:
 * do not clone, merge, or otherwise reconstruct these references.
 *
 * @public
 */
export interface RouteMatch {
  kind: "match";
  operation: OperationObject;
  pathItem: PathItem;
  pathPattern: string;
  pathParams: Record<string, string>;
}

/**
 * Result returned when the path template matched but the requested
 * method isn't declared on it. Semantically a 405 Method Not Allowed
 * rather than a 404. `allowed` is the union of HTTP methods declared
 * across every path template that matched the request path, uppercased,
 * suitable for an RFC 9110 `Allow` response header.
 *
 * @public
 */
export interface MethodNotAllowed {
  kind: "method-not-allowed";
  /** The most specific path template that matched. */
  pathPattern: string;
  /** Uppercased HTTP methods declared on matching path(s). */
  allowed: string[];
}

/**
 * A single declared operation, surfaced by {@link Router.routes}.
 * `method` is uppercased (`"GET"`); `pathPattern` is the template
 * exactly as declared in the spec (`"/pets/{id}"`).
 *
 * Lists operations actually declared on each `PathItem`; the implicit
 * HEAD that any GET resource also answers (RFC 9110 §9.3.2) is a
 * match-time fallback, not a declaration, so it is not enumerated here.
 *
 * @public
 */
export interface RouteInfo {
  /** Uppercased HTTP method (e.g. `"GET"`). */
  method: string;
  /** Path template as declared in the spec (e.g. `"/pets/{id}"`). */
  pathPattern: string;
}

/**
 * The router interface. `match` returns:
 *
 * - `RouteMatch`: the path matched and the method is declared on it.
 * - `MethodNotAllowed`: the path matched but no declared method
 *   handles the request's verb. Callers map this to HTTP 405.
 * - `undefined`: no path template matched at all. Callers map this
 *   to HTTP 404.
 *
 * @public
 */
export interface Router {
  match(method: string, path: string): RouteMatch | MethodNotAllowed | undefined;
  /**
   * Every declared (method, pathPattern) pair, in the router's
   * specificity sort order (more literal segments first). Static for
   * the router's lifetime; the same frozen array is returned each call.
   * Used for spec introspection and cross-router overlap checks (see
   * `@oaverify/internal-validator`'s `combineValidators`).
   */
  routes(): readonly RouteInfo[];
}

// HTTP methods to scan on a `PathItem` when collecting `allowed` for a
// 405 response. Mirrors the `HttpMethod` union in @oaverify/internal-core; kept local
// here to avoid pulling an extra symbol across the package boundary
// for a constant array.
const ALL_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
];

interface Route {
  segments: Segment[];
  pathPattern: string;
  pathItem: PathItem;
}

/**
 * Methods a `PathItem` declares, including HEAD when only GET is
 * declared (RFC 9110 §9.3.2: GET implicitly answers HEAD via the
 * runtime fallback below). Used by the per-(method, structure)
 * ambiguity check so a pattern declaring GET reserves the HEAD slot
 * too; a structurally-identical sibling declaring explicit HEAD would
 * otherwise slip past the check and silently win at match time.
 */
function methodsDeclaredOn(item: PathItem): Set<HttpMethod> {
  const declared = new Set<HttpMethod>();
  for (const m of ALL_METHODS) {
    if (item[m] !== undefined) declared.add(m);
  }
  if (declared.has("get")) declared.add("head");
  return declared;
}

/**
 * Parse an OpenAPI path template into segments.
 *
 * @param template - The path template (e.g. `"/pets/{petId}"`).
 * @returns An array of literal / template / compound segments.
 *
 * @example
 * ```ts
 * parseTemplate("/pets/{id}"); // [{literal "pets"}, {template "id"}]
 * parseTemplate("/commits/{sha}.{ext}");
 * // [{literal "commits"}, {compound regex /^([^/]+?)\.([^/]+?)$/ names ["sha","ext"]}]
 * ```
 *
 * @public
 */
export function parseTemplate(template: string): Segment[] {
  const trimmed = trimSlashes(template);
  if (trimmed === "") return [];
  return trimmed.split("/").map((seg) => parseSegment(seg));
}

function parseSegment(seg: string): Segment {
  // Pure literal: no template syntax at all. Common case; skip parsing.
  if (!seg.includes("{")) {
    return { kind: "literal", value: decodePathToken(seg) };
  }
  // Pure template: the whole segment is one `{name}`.
  const pure = /^\{([^{}]+)\}$/.exec(seg);
  if (pure !== null) {
    return { kind: "template", name: pure[1]! };
  }
  // Compound: alternating literal and `{name}` parts. Build a regex
  // with one non-greedy `[^/]+?` capture per template part; the trailing
  // `$` anchor + lazy capture resolves multi-param ambiguity left-to-right
  // (e.g. `{x}.{y}` against `a.b.c` captures `x="a"`, `y="b.c"`), matching
  // path-to-regexp / hono / find-my-way / werkzeug behavior.
  //
  // Literal runs decode before they are escaped into the regex, the same
  // way a whole literal segment does. `match` decodes the request token
  // first, so an undecoded literal here could never meet it: the same
  // escape worked in a whole literal segment and not in a compound one.
  const names: string[] = [];
  let regexSrc = "^";
  let i = 0;
  let pendingLiteral = "";
  while (i < seg.length) {
    const ch = seg[i];
    if (ch === "{") {
      const end = seg.indexOf("}", i);
      if (end === -1) {
        // Unterminated `{`: treat the rest as literal so we don't throw
        // on a malformed template; match `path-to-regexp`'s tolerance.
        pendingLiteral += seg.slice(i);
        break;
      }
      if (pendingLiteral !== "") {
        regexSrc += escapeRegex(decodePathToken(pendingLiteral));
        pendingLiteral = "";
      }
      const name = seg.slice(i + 1, end);
      names.push(name);
      // `[\s\S]` rather than `[^/]`: the regex runs against one token,
      // already split on `/` and already decoded, so a `/` here can only
      // have come from a `%2F` the client encoded. Excluding it made a
      // compound capture refuse what a bare `{id}` accepts, and the
      // refusal was silent, since the request then fell through to a
      // less specific route.
      regexSrc += "([\\s\\S]+?)";
      i = end + 1;
    } else {
      pendingLiteral += ch;
      i += 1;
    }
  }
  if (pendingLiteral !== "") {
    regexSrc += escapeRegex(decodePathToken(pendingLiteral));
  }
  regexSrc += "$";
  // No template parts ended up in the segment despite a `{`; degenerate.
  // Fall back to literal so behavior matches the !includes("{") branch.
  if (names.length === 0) {
    return { kind: "literal", value: decodePathToken(seg) };
  }
  return { kind: "compound", regex: new RegExp(regexSrc), names, raw: seg };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Stable signature of a segment for the per-(method, structure)
 * ambiguity index. Two segments share a signature iff they would match
 * the same set of tokens for any choice of parameter names. Compound
 * segments emit their literal skeleton with `\0{}` markers replacing
 * each `{name}`, so `{a}.{b}` and `{x}.{y}` both produce `\0{}.\0{}`
 * (correctly flagged as ambiguous on overlapping methods); `{a}.{b}`
 * vs `{a}-{b}` produce different signatures (correctly distinct).
 *
 * The literal runs decode, because that is what they match on: a
 * literal segment's signature is its decoded `value`, and a compound
 * built from raw text would call `/caf%C3%A9-{id}` and `/café-{slug}`
 * distinct while both match `café-42`, so the collision would go
 * unreported and one route would silently shadow the other.
 */
function segmentSignature(s: Segment): string {
  if (s.kind === "literal") return s.value;
  if (s.kind === "template") return "\0{}";
  return s.raw
    .split(/(\{[^{}]+\})/g)
    .map((part) => (/^\{[^{}]+\}$/.test(part) ? "\0{}" : decodePathToken(part)))
    .join("");
}

/**
 * Structural signature of a path template: two templates share a
 * signature iff they would match the same set of request paths for any
 * choice of parameter names (`/items/{id}` and `/items/{slug}` both
 * yield `items/\0{}`). Raw string comparison would call those two
 * distinct; their signatures are equal.
 *
 * `createRouter` uses this internally to reject parameter-name-only
 * collisions within one document. It is exported so cross-router checks
 * (notably `@oaverify/internal-validator`'s `combineValidators` route-disjointness
 * guard) can detect the same overlap between separately-built routers,
 * using the identical structural rule the matcher itself applies.
 *
 * @param pathPattern - A path template (e.g. `"/items/{id}"`).
 * @returns A signature string; equal signatures denote overlapping routes.
 *
 * @public
 */
export function routeSignature(pathPattern: string): string {
  return parseTemplate(pathPattern).map(segmentSignature).join("/");
}

/**
 * Build a router from a map of `pathTemplate → PathItem`. Paths with more
 * literal (non-template) segments win over more template-heavy siblings;
 * the route list is sorted once at construction, then each `match` call is
 * a linear scan: O(routes × segments). That is cheap for the route counts
 * typical in OpenAPI specs (tens to low hundreds); swap in a proper radix
 * tree here if you're routing thousands of paths.
 *
 * @param paths - Record of path templates to PathItems.
 * @returns A {@link Router}.
 *
 * @example
 * ```ts
 * const router = createRouter({
 *   "/pets/{id}": { get: {...} },
 *   "/pets/mine": { get: {...} },
 * });
 * router.match("get", "/pets/mine");   // hits "mine"
 * router.match("get", "/pets/42");     // hits {id}
 * ```
 *
 * @public
 */
export function createRouter(paths: Record<string, PathItem>): Router {
  const routes: Route[] = [];
  // Per-(method, structure) ambiguity index. Two patterns that differ
  // only in parameter names are an ill-formed document only when they
  // also overlap on at least one HTTP method; disjoint-method siblings
  // (e.g. `/items/{id}` GET and `/items/{slug}` POST) describe disjoint
  // routing cells and would never collide at match time. Real-world
  // specs (GitHub, Jira, Gmail, several AWS APIs) declare such pairs.
  const byMethodSignature = new Map<string, string>();
  for (const [pattern, item] of Object.entries(paths)) {
    const segments = parseTemplate(pattern);
    const signature = segments.map(segmentSignature).join("/");
    for (const method of methodsDeclaredOn(item)) {
      const key = `${method}\t${signature}`;
      const existing = byMethodSignature.get(key);
      if (existing !== undefined) {
        const verb = method.toUpperCase();
        // The parameter-name clause explains why two textually different
        // templates collide, which is the common case and worth saying.
        // It is wrong for a pair carrying no placeholder: `/a` and `/a/`,
        // or `/bad%zz` and `/bad%25zz`, name the same path, and blaming
        // parameter names sends the reader looking for one neither has.
        //
        // Read off the signature rather than the text. The `\0{}` marker
        // is present exactly when a segment parsed as a template or a
        // compound, so `/a{b`, which `parseSegment` treats as literal
        // text, is correctly reported as the literal collision it is.
        const hasPlaceholder = signature.includes("\0{}");
        const why = hasPlaceholder
          ? `parameter names differ but every ${verb} request would match both`
          : `they name the same path`;
        throw new Error(
          `createRouter: path templates "${existing}" and "${pattern}" both declare ${verb} on the same path structure (${why}). Rename one or merge them.`,
        );
      }
      byMethodSignature.set(key, pattern);
    }
    routes.push({ segments, pathPattern: pattern, pathItem: item });
  }
  // Sort by specificity:
  //   1. more pure-literal segments win
  //   2. more compound segments win (compounds carry literal anchors,
  //      so they're stricter than a bare `{name}` at the same position)
  //   3. longer paths win
  //   4. alphabetical tie-break for stability
  routes.sort((a, b) => {
    const aLit = a.segments.filter((s) => s.kind === "literal").length;
    const bLit = b.segments.filter((s) => s.kind === "literal").length;
    if (aLit !== bLit) return bLit - aLit;
    const aComp = a.segments.filter((s) => s.kind === "compound").length;
    const bComp = b.segments.filter((s) => s.kind === "compound").length;
    if (aComp !== bComp) return bComp - aComp;
    if (a.segments.length !== b.segments.length) return b.segments.length - a.segments.length;
    return a.pathPattern.localeCompare(b.pathPattern);
  });

  // Enumerate declared operations once, in sort order. Frozen so the
  // accessor can hand the same array out repeatedly without copying.
  const routeList: readonly RouteInfo[] = Object.freeze(
    routes.flatMap((route) =>
      ALL_METHODS.filter((m) => route.pathItem[m] !== undefined).map((m) => ({
        method: m.toUpperCase(),
        pathPattern: route.pathPattern,
      })),
    ),
  );

  return {
    routes() {
      return routeList;
    },
    match(method, path) {
      const normMethod = method.toLowerCase() as HttpMethod;
      const stripped = path.split("?")[0] ?? path;
      const trimmed = trimSlashes(stripped);
      // Decode in place instead of mapping: split already allocated the
      // array, and most tokens carry no escapes to decode.
      const tokens = trimmed === "" ? [] : trimmed.split("/");
      for (let i = 0; i < tokens.length; i += 1) {
        tokens[i] = decodePathToken(tokens[i]!);
      }

      // If we scan every matching path without finding the method, we
      // still want to report a 405 (not 404) and carry the union of
      // declared methods across every path that matched structurally.
      // `/items/42` and `/items/{id}` can both match `POST /items/42`
      // even though neither declares POST.
      let firstMatchedPattern: string | undefined;
      // Allocated on the first structural match without the method; the
      // common outcomes (match or plain 404) never build the Set.
      let allowed: Set<string> | undefined;

      for (const route of routes) {
        if (route.segments.length !== tokens.length) continue;
        // Allocated at the first template/compound segment, after the
        // preceding literals matched; a candidate rejected on a literal
        // (the common miss) costs no allocation.
        let params: Record<string, string> | undefined;
        let matched = true;
        for (let i = 0; i < tokens.length; i += 1) {
          const seg = route.segments[i];
          const tok = tokens[i];
          if (seg === undefined || tok === undefined) {
            matched = false;
            break;
          }
          if (seg.kind === "literal") {
            if (seg.value !== tok) {
              matched = false;
              break;
            }
          } else if (seg.kind === "template") {
            params ??= {};
            setSpecKey(params, seg.name, tok);
          } else {
            const m = seg.regex.exec(tok);
            if (m === null) {
              matched = false;
              break;
            }
            params ??= {};
            for (let j = 0; j < seg.names.length; j += 1) {
              setSpecKey(params, seg.names[j]!, m[j + 1]!);
            }
          }
        }
        if (!matched) continue;
        let operation = route.pathItem[normMethod];
        // RFC 9110 §9.3.2: any resource that answers GET must also answer
        // HEAD. OpenAPI authors rarely declare HEAD explicitly, so fall
        // back to the GET operation when no explicit HEAD is present.
        if (operation === undefined && normMethod === "head") {
          operation = route.pathItem.get;
        }
        if (operation !== undefined) {
          return {
            kind: "match",
            operation,
            pathItem: route.pathItem,
            pathPattern: route.pathPattern,
            pathParams: params ?? {},
          };
        }

        // Path matched but this path's method map doesn't include the
        // request's verb. Remember the first (most-specific) matched
        // pattern, union the declared methods, and keep scanning.
        if (firstMatchedPattern === undefined) firstMatchedPattern = route.pathPattern;
        allowed ??= new Set<string>();
        for (const m of ALL_METHODS) {
          if (route.pathItem[m] !== undefined) allowed.add(m.toUpperCase());
        }
        // GET implicitly answers HEAD (RFC 9110 §9.3.2).
        if (route.pathItem.get !== undefined) allowed.add("HEAD");
      }

      if (firstMatchedPattern !== undefined) {
        return {
          kind: "method-not-allowed",
          pathPattern: firstMatchedPattern,
          allowed: allowed === undefined ? [] : [...allowed].sort(),
        };
      }
      return undefined;
    },
  };
}
