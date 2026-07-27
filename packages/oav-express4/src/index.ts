/**
 * The public `@oaverify/express4` surface plus the type shape every adapter
 * in the family shares.
 *
 * - {@link validateRequests}: request-validation middleware; the 80% case.
 * - {@link validateResponses}: opt-in response-validation middleware
 *   (wraps `res.json` / `res.send`); off in production by convention.
 * - {@link httpRequestFromExpress}: standalone extractor; for
 *   callers composing their own middleware.
 * - {@link renderProblemDetails}: the default error renderer;
 *   reusable from any custom middleware.
 * - {@link ResponseValidationError}: thrown by the default
 *   `validateResponses` failure path.
 *
 * Naming and option shapes are deliberately consistent with the
 * sibling `@oaverify/express5` / `@oaverify/fastify` adapters.
 *
 * @packageDocumentation
 */

export { httpRequestFromExpress } from "./extract.js";
export { renderProblemDetails } from "./render.js";
export { validateRequests, type ValidateRequestsOptions } from "./middleware.js";
export { validateResponses, type ValidateResponsesOptions } from "./validate-responses.js";
export { ResponseValidationError } from "./response-error.js";
export type { ErrorHandler, ExpressContext } from "./types.js";

// Re-export the types that appear in our own option signatures. Strictly
// not duplication of @oaverify/core's surface; these ARE the adapter's
// public contract, just borrowed for non-duplication reasons. Importing
// them from this package means consumers don't have to know which
// package owns them.
export type { HttpRequest, ValidationError } from "@oaverify/internal-core";
export type { Validator } from "@oaverify/internal-validator";
