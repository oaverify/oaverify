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
 * consumer that cannot live with that is `oaverify compile-spec`, whose
 * emitted output imports only from `./codegen-runtime.js`
 * (`@oaverify/core/codegen-runtime`), semver-covered for exactly the
 * reason this module is not.
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

// Object assembly pieces the validator itself consumes: the per-style
// builders and the scalar coercion a property of an assembled object
// reads by. (`assembleObjectQueryParam` / `assembleObjectCookieParam`,
// the two location dispatchers, are emit-side and live in
// ./codegen-runtime.js.)
export {
  assembleDeepObject,
  assembleFormExplodedObject,
  coerceQueryScalar,
} from "./param-assembly.js";

// The shared OpenAPI schema-position traversal. Internal rather than
// public: it is a tool for building checks over a document, not part of
// the request/response validation surface, and it should not become
// semver-covered by accident.
export {
  escapePointer,
  recordDocumentRefSiblingSuppression,
  walkDocumentSchemas,
  type DocumentWalkHooks,
} from "./document-walk.js";

// The served-location rule and its messages, so the AOT emitter and
// `check` refuse the same documents in the same words rather than
// carrying a second copy of the list (#829).
export {
  assertServedParameterLocations,
  describeParameterLocation,
  isServedParameterLocation,
  listUnservedParameterLocations,
  renderParameterLocation,
  unservedParameterLocationMessage,
  type UnservedParameterLocation,
} from "./parameter-locations.js";

// The one rule for header parameters OpenAPI says to ignore, and the
// walk that locates them for a report.
export { isIgnoredHeaderParameter, isIgnoredResponseHeader } from "./headers.js";
export { listIgnoredHeaders, type IgnoredHeader } from "./ignored-headers.js";

// Body extraction from a Web Standards `Request` / `Response`. The
// package root exports it too, as the reader a custom
// `FetchRequestOptions.readBody` delegates to.
export { readBodyFromFetch } from "./from-fetch.js";

// The `maxTotalBytes` allow-list, so every surface that accepts the
// option rejects the same values with the same message. The AOT
// emitter validates at emit time rather than baking a value the
// reader would reject on every request.
export { isValidMaxTotalBytes, maxTotalBytesErrorMessage } from "./from-fetch.js";

// Used by `compile-spec` to bake an object-typed flag onto each emitted
// parameter, so the generated module can answer #889 without the
// codegen runtime gaining a symbol.
export { effectiveType } from "./schema-type.js";

// Baked onto each emitted parameter the same way, so the emitted module
// reads a simple header's field lines as createValidator does (#1240).
export { joinsFieldLines } from "./deserialize.js";

export { checkDocumentExamplesInContext } from "./example-check.js";

// The body projection's opaque-binary rule, so compile-spec's
// unknown-format scan skips what the projection removes (#1239).
export { isBinaryStringSchema } from "./body-schema-transform.js";

// The HTTP body projection (readOnly/writeOnly by direction, opaque
// binary properties), so the AOT emitter compiles bodies the way
// `createValidator` does.
export {
  type BodyDirection,
  createDirectionResolver,
  transformBodySchemaForDirection,
} from "./body-schema-transform.js";

// How a non-schema object reached through `$ref` is followed, chains
// included, so the AOT emitter reads the objects createValidator reads.
export { resolveOperationRef } from "./operation-cache.js";

export { resolvePathItem } from "./path-item.js";
