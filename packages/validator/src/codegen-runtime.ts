/**
 * The emit-side runtime for `oaverify compile-spec`, exposed as
 * `@oaverify/core/codegen-runtime`.
 *
 * **Everything here is semver-covered.** `compile-spec` writes an
 * `import ... from "@oaverify/core/codegen-runtime"` line into the
 * consumer's generated module, and that import resolves at *their*
 * install, in a file this repo does not control and will not be
 * editing. Renaming or removing a member breaks a generated file in a
 * stranger's repo with no code of ours in the stack trace, so a member
 * leaves this module only across a major, and `emit-spec.ts` moves in
 * the same commit.
 *
 * The membership rule is mechanical: a value belongs here exactly when
 * emitted output imports it (see the import block `emit-spec.ts`
 * writes), plus the types those values' signatures need. Helpers that
 * only our own code or advanced tooling reach for stay on
 * `./validator/internals`, which promises nothing.
 *
 * @packageDocumentation
 */

// Dispatch table. The emitted module builds its router once at module
// load; the router package is workspace-private, so this re-export is
// the only path a generated file can reach it by.
export { createRouter, type RouteMatch, type Router } from "@oaverify/internal-router";

// Result reshaping, so the AOT output's result shape matches
// `createValidator` exactly: `reshapeResult` for
// `validate{Request,Response}`, `toFetchResult` for the
// `validateFetch*` wrappers. Sourced from the standalone `./reshape.js`
// so this module does not pull the validator's `node:fs`-bearing graph
// into the compile-spec bundle.
export { reshapeResult, toFetchResult } from "./reshape.js";

// Fetch-adapter halves of the emitted `validateFetchRequest` /
// `validateFetchResponse` helpers.
export {
  FetchBodyParseError,
  httpRequestFromFetch,
  httpResponseFromFetch,
  type FetchRequestOptions,
} from "./from-fetch.js";

// Request-time halves of validation the emitted module performs
// itself: parameter deserialisation, content-type negotiation,
// response-status key matching, and the pre-compiled security plan.
export {
  deserialize,
  matchParsedMediaType,
  matchResponseKey,
  normalizeRequestQuery,
} from "./deserialize.js";
export { checkSecurity, compileOperationSecurity } from "./security.js";

// Operation-level `$ref` resolver, called while the emitted module
// assembles its per-operation table.
export { resolveOperationRef } from "./operation-cache.js";

// The AOT-emitted validator builds the same content-type diagnostics as
// the interpreted one. Sharing the builder is what stops the two
// wordings drifting apart.
export { contentTypeErrorMessage } from "./headers.js";
