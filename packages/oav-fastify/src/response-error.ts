import type { ValidationError } from "@oaverify/internal-core";

/**
 * Thrown by the default {@link validateResponses} `onError` when an
 * outgoing response fails validation. A response-validation failure is
 * a server bug, so the default routes it through the host's error
 * pipeline (Fastify's error handler) rather than rendering a body
 * here. `statusCode` is `500` so the default error handler answers 500;
 * `errors` carries the failing leaves for a custom handler to inspect.
 *
 * @public
 */
export class ResponseValidationError extends Error {
  /** The failing leaves from {@link Validator.validateResponse}. */
  readonly errors: ValidationError[];
  /** Surfaced to the host error handler so the client sees a 500. */
  readonly statusCode = 500;

  constructor(errors: ValidationError[]) {
    super(
      `oav: outgoing response failed validation (${errors.length} issue${errors.length === 1 ? "" : "s"})`,
    );
    this.name = "ResponseValidationError";
    this.errors = errors;
  }
}
