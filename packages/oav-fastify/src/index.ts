/**
 * The public `@oaverify/fastify` surface plus the type shape every adapter
 * in the family shares.
 *
 * - {@link validateRequests}: preValidation hook factory; the 80% case.
 * - {@link validateResponses}: opt-in response-validation `onSend` hook
 *   (no monkey-patching); off in production by convention.
 * - {@link httpRequestFromFastify}: standalone extractor; for
 *   callers composing their own hooks.
 * - {@link renderProblemDetails}: the default error renderer;
 *   reusable from any custom hook.
 * - {@link ResponseValidationError}: thrown by the default
 *   `validateResponses` failure path.
 *
 * Naming and option shapes are deliberately consistent with the
 * sibling `@oaverify/express4` / `@oaverify/express5` adapters.
 *
 * Fastify is async-native: the returned hook is `async`, and
 * thrown errors / rejected promises propagate to Fastify's error
 * handler without explicit try/catch.
 *
 * @packageDocumentation
 */

export { httpRequestFromFastify } from "./extract.js";
export { renderProblemDetails } from "./render.js";
export { validateRequests, type ValidateRequestsOptions } from "./middleware.js";
export { validateResponses, type ValidateResponsesOptions } from "./validate-responses.js";
export { ResponseValidationError } from "./response-error.js";
export type { ErrorHandler, FastifyContext } from "./types.js";

// Re-export the types that appear in our own option signatures. Strictly
// not duplication of @oaverify/core's surface; these ARE the adapter's
// public contract, just borrowed for non-duplication reasons. Importing
// them from this package means consumers don't have to know which
// package owns them.
export type { HttpRequest, ValidationError } from "@oaverify/internal-core";
export type { Validator } from "@oaverify/internal-validator";
