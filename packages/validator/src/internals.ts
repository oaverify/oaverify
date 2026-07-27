/**
 * Internal re-exports for `oav/validator/internals`. Exposes
 * the parameter-deserialisation and query-assembly primitives that the
 * validator uses to prepare values before schema compilation, plus the
 * operation-level `$ref` resolver. Reachable when you need them
 * (tests, advanced plugins, tooling that reuses the same style /
 * explode rules outside the normal validator flow) but deliberately
 * separated from the main `oav/validator` barrel so the
 * public surface matches what request/response-validation consumers
 * actually need.
 *
 * Nothing here is covered by semver guarantees. Compare against the
 * main barrel in `./index.ts` before importing from here.
 *
 * @packageDocumentation
 */

// Parameter deserialisation primitives: `style` + `explode`
// interpretation, Content-Type negotiation, response-status key
// matching (exact → NXX class → default).
export {
  compileMediaTypePatterns,
  deserialize,
  matchMediaType,
  matchParsedMediaType,
  matchResponseKey,
  type ParsedMediaTypePattern,
} from "./deserialize.js";

// Query-object assembly helpers. Handle the two OAS query shapes that
// spread an object across multiple top-level keys: `style: form +
// explode: true` (the default) and `style: deepObject`.
export {
  assembleDeepObject,
  assembleFormExplodedObject,
  assembleObjectQueryParam,
  coerceQueryScalar,
} from "./query-assembly.js";

// Operation-level `$ref` resolver: used internally by the cache
// builder; exposed so tests can exercise it without constructing a
// full validator.
export { resolveOperationRef } from "./operation-cache.js";

// Fetch-adapter primitives: extract an `HttpRequest` / `HttpResponse`
// from a Web Standards `Request` / `Response`. `oav compile-spec`'s
// emitted output uses these to provide the `validateFetchRequest` /
// `validateFetchResponse` helpers without the consumer having to
// import them themselves.
export {
  httpRequestFromFetch,
  httpResponseFromFetch,
  readBodyFromFetch,
  type FetchRequestOptions,
} from "./from-fetch.js";

// Shape-only security check. `oav compile-spec` pre-compiles the
// per-op security plan at build time, then calls `checkSecurity` at
// request time.
export { checkSecurity, compileOperationSecurity } from "./security.js";

// The router is a workspace-private package (`@oaverify/internal-router`) that
// isn't published on its own. `oav compile-spec`'s emitted output
// needs `createRouter` at module load to build its dispatch table;
// re-exporting it here keeps all emit-side imports funnelled through
// `oav/validator/internals` so the emitted module only
// has to reach into one subpath.
export { createRouter, type RouteMatch, type Router } from "@oaverify/internal-router";

// Result reshaping. The validator builds a nested error tree internally
// and reshapes it to the requested `output` / `maxErrors` at the public
// boundary; `oav compile-spec`'s emitted module reuses the same two
// functions so its AOT output's result shape matches `createValidator`
// exactly (`reshapeResult` for `validate{Request,Response}`,
// `toFetchResult` for the `validateFetch*` wrappers). Sourced from the
// standalone `./reshape.js` so re-exporting here doesn't pull the
// validator's `node:fs`-bearing graph into the compile-spec bundle.
export { reshapeResult, toFetchResult } from "./reshape.js";
