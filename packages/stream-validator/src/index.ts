/**
 * `@oaverify/internal-stream-validator`: a streaming JSON Schema 2020-12 validator. It
 * validates a JSON document against a resolved schema as the bytes stream,
 * echoing them through unchanged while reporting violations on a side
 * channel. Memory is bounded for forward-decidable schemas with structural
 * bounds, so multi-GB bodies validate without materializing in heap.
 *
 * This is a second engine, push-based over a token stream, distinct from
 * `@oaverify/internal-schema`'s pull-based compiler. It reuses `@oaverify/internal-schema`'s
 * in-memory validator for subtrees a compile-time classifier marks
 * BUFFER (so format assertion and built-in formats come from that
 * delegate), and reuses `@oaverify/internal-core`'s flat error model.
 *
 * Published as `@oaverify/stream`, versioned independently
 * of the `oav-core` family (its own version line).
 *
 * @packageDocumentation
 */

export type { JsonPath, PathFilter, StreamValidatorOptions } from "./options.js";
export {
  createStreamValidator,
  DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_MAX_MEMBER_PREFIX_BYTES,
  MaxTotalBytesError,
  ValidationFailedError,
  type Bytes,
  type MemberContext,
  type MemberEdit,
  type MemberEditor,
  type ScopeContext,
  type ScopeEditor,
  type ScopeObserver,
  // Exported as a type only: construct through `createStreamValidator`.
  // The factory is the construction contract; a type-only export keeps
  // `instanceof` and the `new` constructor out of the public surface, so
  // a later engine refactor (a shared base transform, a different
  // lifecycle class) does not break consumers.
  type StreamValidator,
  type ValueEvent,
} from "./engine/index.js";
export {
  analyzeSpec,
  analyzeStreamability,
  type BodyBudget,
  type BodyBudgetBase,
  type BufferPosition,
  type ByteSize,
  type OperationBudget,
  type SpecBudget,
  type StreamabilityReport,
  type StreamClass,
} from "./analyzer/index.js";
export { type OperationLocator, streamValidatorForOperation } from "./operation.js";
export { BufferLimitError, MemberEditError, UniqueItemsLimitError } from "./spine/index.js";
export type { StreamVerdict, SchemaViolation } from "./spine/index.js";
export { toValidationError } from "./violation.js";
