import {
  createLeafError,
  type HttpRequest,
  type ParameterObject,
  type ValidationError,
} from "@oaverify/internal-core";
import type { RouteMatch } from "@oaverify/internal-router";
import type { CompiledTreeSchema } from "@oaverify/internal-schema";
import { deserialize, matchParsedMediaType } from "./deserialize.js";
import { contentTypeErrorMessage, getHeaderValue, getHeaderValueFast, getOwn } from "./headers.js";
import type { OperationCache } from "./operation-cache.js";
import type { MutableRequestValues } from "./request-values.js";
import { assembleObjectQueryParam } from "./query-assembly.js";

/**
 * Media type of the (single) entry inside a parameter's `content` map,
 * or `undefined` when `content` isn't in use. Companion to
 * `firstContentSchema`.
 *
 * @internal
 */
function firstContentMediaType(p: ParameterObject): string | undefined {
  if (p.content === undefined) return undefined;
  for (const [mt, mto] of Object.entries(p.content)) {
    if (mto.schema !== undefined) return mt;
  }
  return undefined;
}

/**
 * `true` for media types that imply JSON encoding (`application/json`
 * and any `*+json` suffix per RFC 6838 §4.2.8).
 *
 * @internal
 */
function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

/**
 * Record an accepted parameter value into the `returnValues`
 * accumulator, under the location group matching the parameter's `in`.
 *
 * Called only after a schema accepted the value. The `in` values and the
 * accumulator's field names differ for two of the four locations
 * (`header` / `headers`, `cookie` / `cookies`), so the mapping is
 * explicit rather than indexed by `p.in`.
 *
 * @internal
 */
function recordValue(sink: MutableRequestValues, p: ParameterObject, value: unknown): void {
  switch (p.in) {
    case "path":
      sink.path[p.name] = value;
      return;
    case "query":
      sink.query[p.name] = value;
      return;
    case "header":
      sink.headers[p.name] = value;
      return;
    case "cookie":
      sink.cookies[p.name] = value;
      return;
  }
}

/**
 * The leaf error for a parameter that is absent, or `null` when it was
 * optional and absence is fine.
 *
 * A module-level function rather than a closure inside
 * {@link validateParameter}: a closure capturing `p` / `code` /
 * `pathPrefix` is allocated on every call, including the overwhelmingly
 * common one where the parameter is present and this is never reached.
 * That cost is ~135ns per parameter and it scaled with parameter count
 * (3.7x on 4 query parameters, 7.1x on 32).
 *
 * @internal
 */
function missingParameterError(
  p: ParameterObject,
  code: string,
  pathPrefix: (string | number)[],
): ValidationError | null {
  return p.required
    ? createLeafError(code, pathPrefix, `missing required ${p.in} parameter "${p.name}"`, {
        name: p.name,
        in: p.in,
      })
    : null;
}

/**
 * Validate a single parameter against the operation cache: fetch the
 * raw value from the appropriate HTTP frame (path / query / header /
 * cookie), deserialise per `style` + `explode`, and run the pre-
 * compiled schema validator. Pure: no closure over createValidator
 * state; the cache carries everything it needs.
 *
 * `sink` is the {@link ValidatorOptions.returnValues} accumulator, and
 * is `undefined` whenever that option is off. When present, a value is
 * recorded only after its schema accepted it, which is what makes a key
 * in the accumulator mean "spec-valid" on both verdicts. Every early
 * return below leaves the accumulator untouched, so the option-off path
 * is the same code with one `undefined` check per accepted parameter.
 *
 * @internal
 */
export function validateParameter(
  p: ParameterObject,
  req: HttpRequest,
  match: RouteMatch,
  cache: OperationCache,
  sink: MutableRequestValues | undefined,
): ValidationError | null {
  let raw: string | string[] | undefined;
  let validator: CompiledTreeSchema | undefined;
  let pathPrefix: (string | number)[];
  let code: string;

  switch (p.in) {
    case "path":
      raw = cache.requestParameterReadsRequireOwnProperties
        ? getOwn(match.pathParams, p.name)
        : match.pathParams[p.name];
      validator = cache.pathParamValidators.get(p.name);
      pathPrefix = ["path", p.name];
      code = "path-param";
      break;
    case "query": {
      pathPrefix = ["query", p.name];
      code = "query-param";
      validator = cache.queryParamValidators.get(p.name);
      // Object-valued query params with style:form + explode:true, or
      // style:deepObject, are spread across multiple top-level query
      // keys rather than living under `query[p.name]`. Assemble a
      // value from those keys before falling through to the scalar /
      // array deserialization path.
      const assembled = assembleObjectQueryParam(p, req.query);
      if (assembled !== undefined) {
        if (validator === undefined) return null;
        if (assembled.value === undefined) return missingParameterError(p, code, pathPrefix);
        const r = validator.validate(assembled.value, pathPrefix);
        if (r.valid) {
          if (sink !== undefined) recordValue(sink, p, assembled.value);
          return null;
        }
        if (r.error === undefined) return null;
        return r.error;
      }
      raw = cache.requestParameterReadsRequireOwnProperties
        ? getOwn(req.query, p.name)
        : req.query?.[p.name];
      // Bracket-suffixed fallback, on a miss only, so the literal
      // declared name always wins. The alias is precomputed and exists
      // only for array-typed parameters under
      // `allowBracketedQueryArrays`; see OperationCache.bracketQueryAliases.
      //
      // This sits at the lookup rather than in `normalizeRequestQuery`
      // so it covers both query sources with one implementation: a
      // query string embedded in `path` has already been folded into
      // `req.query` by the time any parameter is read, so the record an
      // adapter supplies and the record the path produced take the same
      // route through here.
      if (raw === undefined && cache.bracketQueryAliases.size > 0) {
        const alias = cache.bracketQueryAliases.get(p.name);
        if (alias !== undefined) {
          raw = cache.requestParameterReadsRequireOwnProperties
            ? getOwn(req.query, alias)
            : req.query?.[alias];
        }
      }
      break;
    }
    case "header":
      raw = cache.requestParameterReadsRequireOwnProperties
        ? getHeaderValue(req.headers, p.name)
        : getHeaderValueFast(req.headers, p.name);
      validator = cache.headerParamValidators.get(p.name);
      pathPrefix = ["header", p.name];
      code = "header-param";
      break;
    case "cookie":
      raw = cache.requestParameterReadsRequireOwnProperties
        ? getOwn(req.cookies, p.name)
        : req.cookies?.[p.name];
      validator = cache.cookieParamValidators.get(p.name);
      pathPrefix = ["cookie", p.name];
      code = "cookie-param";
      break;
  }

  if (raw === undefined) return missingParameterError(p, code, pathPrefix);
  // Empty-string is a legitimate value; `minLength`/`pattern` on the
  // parameter schema handles rejection where needed. OpenAPI 3.1 §4.8.12.1
  // explicitly permits `?flag=` on query parameters declaring
  // `allowEmptyValue: true`; exempt those from validation.
  // No value is recorded for `returnValues` here or on the next line:
  // both paths skip the schema, and the accumulator only holds values a
  // schema accepted. An `allowEmptyValue` parameter that arrived empty
  // is therefore absent from `value` even though the client sent it.
  if (raw === "" && p.in === "query" && p.allowEmptyValue === true) return null;
  if (validator === undefined) return null;

  // `parameter.content` takes precedence over `parameter.schema` when both
  // are present. Spec permits exactly one media-type entry; take it.
  // For JSON media types, parse the raw string before validating; other
  // types (text/plain, etc.) are passed through as the raw string.
  const contentMediaType = firstContentMediaType(p);
  if (contentMediaType !== undefined) {
    const rawStr = Array.isArray(raw) ? raw[0] : raw;
    if (typeof rawStr !== "string") return null;
    let parsed: unknown = rawStr;
    if (isJsonMediaType(contentMediaType)) {
      try {
        parsed = JSON.parse(rawStr);
      } catch (err) {
        return createLeafError(
          code,
          pathPrefix,
          `${p.in} parameter "${p.name}" is not valid ${contentMediaType}: ${(err as Error).message}`,
          { name: p.name, in: p.in, mediaType: contentMediaType, reason: "content-parse" },
        );
      }
    }
    const r = validator.validate(parsed, pathPrefix);
    if (r.valid) {
      if (sink !== undefined) recordValue(sink, p, parsed);
      return null;
    }
    if (r.error === undefined) return null;
    return r.error;
  }

  const value = deserialize(raw, p);
  // A present token can still supply no value for this parameter: a
  // `style: matrix` segment whose groups all name something else
  // (#758), or a `label` / `matrix` token carrying none of the style's
  // framing (#789). Both are the parameter being absent, and reporting
  // absence is what rejects them whatever the schema says, where
  // handing the schema `[]` or the unread token did not.
  //
  // Gated on the style rather than testing `value === undefined` alone,
  // because `deserialize` has a second source of undefined that is not
  // absence: an object-typed parameter handed an empty array reads
  // `raw[0]`. Treating that as absent would accept an optional one that
  // the schema rejects today.
  if (value === undefined && (p.style === "matrix" || p.style === "label"))
    return missingParameterError(p, code, pathPrefix);
  const r = validator.validate(value, pathPrefix);
  if (r.valid) {
    if (sink !== undefined) recordValue(sink, p, value);
    return null;
  }
  if (r.error === undefined) return null;
  return r.error;
}

/**
 * Content-type gate for the request body. Returns a single leaf when
 * the client's `Content-Type` doesn't match the operation's declared
 * media types; otherwise `null`. Runs before {@link validateBody} (and
 * before parameter validation) so a content-type mismatch short-circuits
 * with an unambiguous single-leaf tree instead of being paired with
 * unrelated parameter diagnostics.
 *
 * Fires whenever the client declared a `Content-Type` that doesn't
 * match, including the body-absent case, where the wrong header is
 * the more actionable signal than the downstream "body required" leaf.
 * Returns `null` (deliberately not a content-type error) when:
 * - the operation declares no `requestBody`,
 * - the operation's `requestBody.content` map is empty (nothing to
 *   match against),
 * - the request has no body AND no `Content-Type` (body-missing is a
 *   separate concern, handled by {@link validateBody}).
 *
 * @internal
 */
export function checkBodyContentType(
  req: HttpRequest,
  cache: OperationCache,
): ValidationError | null {
  const match = matchRequestBodyMediaType(req, cache);
  return typeof match === "string" ? null : match;
}

/**
 * Return the matched request-body media type, a content-type error, or
 * `null` when no body media-type gate applies.
 *
 * @internal
 */
export function matchRequestBodyMediaType(
  req: HttpRequest,
  cache: OperationCache,
): string | ValidationError | null {
  if (cache.requestBody === undefined) return null;
  if (cache.bodyValidators.size === 0) return null;
  // See validateBody: only `undefined` means absent.
  const hasBody = req.body !== undefined;
  // No body and no Content-Type: the client said nothing about the
  // payload, so the actionable signal is the missing body, not a 415
  // for an unsent header. Defer to validateBody.
  if (!hasBody && req.contentType === undefined) return null;
  const mt = matchParsedMediaType(req.contentType, cache.bodyMediaTypes);
  if (mt !== undefined) return mt;
  return createLeafError(
    "content-type",
    ["body"],
    contentTypeErrorMessage("request", req.contentType, req.headers),
    { contentType: req.contentType, accepted: [...cache.bodyValidators.keys()] },
  );
}

/**
 * Validate the request body against the operation cache's pre-compiled
 * per-media-type validators. Returns a leaf error for required-missing;
 * delegates shape validation to the compiled schema and returns its
 * error subtree (or `null` on success). Content-type matching is the
 * caller's responsibility via {@link checkBodyContentType}; when
 * reached here, a matching media-type validator is assumed to exist.
 *
 * @internal
 */
export function validateBody(
  req: HttpRequest,
  cache: OperationCache,
  matchedMediaType?: string,
): ValidationError | null {
  const body = cache.requestBody;
  if (body === undefined) return null;
  // Only `undefined` means absent. A parsed JSON `null` is a value, and
  // has to reach the schema: `type: "null"` accepts it, anything else
  // rejects it. Adapters establish the same boundary, setting `body`
  // only when it is not `undefined`.
  const hasBody = req.body !== undefined;
  if (!hasBody) {
    if (body.required) {
      return createLeafError("body", ["body"], "missing required request body", {});
    }
    return null;
  }
  if (cache.bodyValidators.size === 0) return null;
  const mt = matchedMediaType ?? matchParsedMediaType(req.contentType, cache.bodyMediaTypes);
  if (mt === undefined) return null; // content-type gate ran upstream; defensive no-op.
  const validator = cache.bodyValidators.get(mt);
  if (validator === undefined) return null;
  const r = validator.validate(req.body, ["body"]);
  if (r.valid || r.error === undefined) return null;
  return r.error;
}
