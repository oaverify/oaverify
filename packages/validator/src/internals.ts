/**
 * Internal re-exports for `@oaverify/core/validator/internals`. Exposes
 * the parameter-deserialisation and parameter-assembly primitives that the
 * validator uses to prepare values before schema compilation, plus the
 * shared document traversal. Reachable when you need them (tests,
 * advanced plugins, tooling that reuses the same style / explode rules
 * outside the normal validator flow) but deliberately separated from
 * the main `@oaverify/core` validator barrel so the public surface
 * matches what request/response-validation consumers actually need.
 *
 * Nothing here is covered by semver guarantees. Compare against the
 * main barrel in `./index.ts` before importing from here. The one
 * population that used to make that warning false has moved: everything
 * `oaverify compile-spec`'s emitted output imports lives in
 * `./codegen-runtime.js` (`@oaverify/core/codegen-runtime`), which is
 * semver-covered for exactly the reason this module is not.
 *
 * @packageDocumentation
 */

// Parameter deserialisation primitives the validator itself consumes:
// media-type pattern pre-compilation and Content-Type matching.
// (`deserialize` / `matchParsedMediaType` / `matchResponseKey` are
// emit-side and live in ./codegen-runtime.js.)
export {
  // Resolves the schema positions scalar coercion reads, so a parameter
  // behind a `$ref` coerces. The AOT emitter needs it to bake the same
  // schema the runtime would coerce against.
  coercionView,
  compileMediaTypePatterns,
  matchMediaType,
  type ParsedMediaTypePattern,
  schemaRefResolverFor,
  type SchemaRefResolver,
} from "./deserialize.js";

// Object assembly helpers. Handle the OAS shapes that spread an object
// across several wire keys: in the query, `style: form + explode: true`
// (the default) and `style: deepObject`; in a cookie, OpenAPI 3.2's
// `style: cookie` when exploded.
export {
  assembleDeepObject,
  assembleFormExplodedObject,
  assembleObjectCookieParam,
  assembleObjectQueryParam,
  coerceQueryScalar,
} from "./param-assembly.js";

// The shared OpenAPI schema-position traversal. Internal rather than
// public: it is a tool for building checks over a document, not part of
// the request/response validation surface, and it should not become
// semver-covered by accident.
export { escapePointer, walkDocumentSchemas, type DocumentWalkHooks } from "./document-walk.js";

// The served-location rule and its message, so the AOT emitter refuses
// the same documents in the same words rather than carrying a second
// copy of the list (#829). `assertServedParameterLocations` is the
// whole gate; the other two are for a caller applying the rule to one
// parameter at a time.
export {
  assertServedParameterLocations,
  isServedParameterLocation,
  unservedParameterLocationMessage,
} from "./parameter-locations.js";

// Body extraction from a Web Standards `Request` / `Response`. The
// `httpRequestFromFetch` / `httpResponseFromFetch` wrappers around it
// are emit-side (./codegen-runtime.js); this half is reached directly
// only by tests and adapters.
export { readBodyFromFetch } from "./from-fetch.js";

// The `maxTotalBytes` allow-list, so every surface that accepts the
// option rejects the same values with the same message. The AOT
// emitter validates at emit time rather than baking a value the
// reader would reject on every request.
export { isValidMaxTotalBytes, maxTotalBytesErrorMessage } from "./from-fetch.js";
