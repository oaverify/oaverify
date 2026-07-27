/**
 * The public `@oaverify/core` validator surface. One audience: callers
 * building a request/response validator from a resolved OpenAPI
 * document: `createValidator`, the `Validator` instance it returns,
 * the options, and the Fetch-API adapters for consumers plugging the
 * validator into Next.js / Hono / Bun / Deno handlers.
 *
 * Parameter deserialisation primitives, query-assembly helpers, and
 * the operation-level `$ref` resolver live behind
 * `@oaverify/core/validator/internals`. Reach for them only when a
 * tool needs the same style/explode or `$ref` rules outside the normal
 * validator flow; nothing there is covered by semver.
 *
 * @packageDocumentation
 */

export {
  createValidator,
  type PredicateValidator,
  type RouteMatchResult,
  type TreeValidator,
  type Validator,
  type ValidatorOptions,
  type ValidatorStats,
} from "./validator.js";
export { combineValidators, type CombineOptions } from "./combine.js";
// Re-exported from `@oaverify/internal-router` so consumers of the validator surface
// get the `Validator.routes` element type without reaching across into
// the router package.
export type { RouteInfo } from "@oaverify/internal-router";
export {
  httpRequestFromFetch,
  httpResponseFromFetch,
  readBodyFromFetch,
  type FetchRequestOptions,
} from "./from-fetch.js";
export type {
  CompiledRegex,
  CustomKeywordFailure,
  CustomKeywordValidator,
  RegexCompiler,
} from "@oaverify/internal-schema";
