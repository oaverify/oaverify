/**
 * The public option surface and shared path types for the streaming
 * validator.
 *
 * @packageDocumentation
 */

import type { PathSegment } from "@oaverify/internal-core";
import type { CustomKeywordValidator, Dialect, RegexCompiler } from "@oaverify/internal-schema";

/**
 * A JSON instance location, as an array of property names and array
 * indices from the document root. The root is the empty array `[]`. The
 * same `PathSegment[]` shape `@oaverify/internal-core` errors carry, so violation
 * paths line up with the in-memory engine's.
 *
 * @public
 */
export type JsonPath = readonly PathSegment[];

/**
 * Selects scopes by path. Either an exact path (matched by value) or a
 * predicate over the path and the scope kind. The predicate form is what
 * lets a filter match a family of scopes (e.g. every element of an
 * array, or every scope at a given depth through a recursive `$ref`).
 *
 * @public
 */
export type PathFilter = JsonPath | ((path: JsonPath, kind: "object" | "array") => boolean);

/**
 * Options for a streaming validator.
 *
 * Field groups:
 *
 *   - **Verdict policy** (`maxErrors`, `policy`): how many violations to
 *     collect and whether the first one tears down the stream.
 *   - **Schema semantics** (`formats`, `keywords`, `regexCompiler`,
 *     `parity`): shared with `@oaverify/internal-schema`'s `CompileOptions` where they
 *     overlap; threaded into the BUFFER-island delegate.
 *   - **Observability** (`keyEvents`): an opt-in, compile-time-gated key
 *     channel.
 *   - **Resource limits** (`maxBufferedBytes`, `maxDepth`,
 *     `maxTotalBytes`, `maxUniqueItems`, `enforceBounds`): all default off
 *     (unset = zero overhead). They bound the dimensions a
 *     forward-decidable schema leaves open.
 *
 * @public
 */
export interface StreamValidatorOptions {
  /**
   * OpenAPI version of the schema. `"3.0"` normalizes the schema to
   * 2020-12 shape before classification; all three select OpenAPI
   * semantics (`format` asserts). Omit for raw JSON Schema 2020-12. This
   * is the raw-schema analog of `@oaverify/internal-validator` reading the version off
   * the spec; pair it with `dialect` only to override.
   */
  openApiVersion?: "3.0" | "3.1" | "3.2";

  /**
   * Dialect whose keyword set drives classification, matching
   * `@oaverify/internal-schema`'s `CompileOptions.dialect` / `@oaverify/internal-validator`'s
   * `ValidatorOptions.dialect`. Defaults to `jsonSchemaDialect` (or the
   * OpenAPI dialect when `openApiVersion` is set); set it only to
   * override that choice.
   */
  dialect?: Dialect;

  /**
   * How many violations to collect before sealing the verdict. Defaults
   * to `1` (Ajv-parity fast-fail), matching `@oaverify/internal-schema`. `Infinity`
   * collects every violation.
   */
  maxErrors?: number;

  /**
   * What happens when the validation budget (`maxErrors`) is reached.
   *
   *   - `"terminate"` (default): destroy the stream on the budget-th
   *     violation; `pipeline` rejects with `ValidationFailedError`.
   *   - `"detach"`: stop validating, seal the verdict, raw-copy the tail
   *     of the input to output unchanged.
   *
   * A parse error is always terminal regardless of policy.
   */
  policy?: "terminate" | "detach";

  /**
   * Extra format validators merged on top of `builtInFormats`, the same
   * shape and the same merge as `createValidator`'s option of this name.
   * A name registered here wins over a built-in of that name.
   *
   * Threaded into the BUFFER-island delegate's in-memory compile; they
   * take effect only where that engine asserts `format` (an OpenAPI
   * dialect, or the 2020-12 format-assertion vocabulary). The forward
   * STREAM path treats `format` as an annotation and never runs these.
   *
   * A format name with no validator under it asserts nothing, per JSON
   * Schema, and reports nothing. Enumerating the formats a spec uses
   * today therefore leaves a later addition silently unchecked, which is
   * why the built-ins are the base rather than the whole set.
   */
  formats?: Record<string, (value: string) => boolean>;

  /**
   * What to do about a `format` with no validator registered under its
   * name: `"ignore"` (default) leaves it asserting nothing, `"error"`
   * refuses to build the island delegate.
   *
   * Only the BUFFER-island delegate asserts `format`, so this is scoped
   * to the same place {@link StreamValidatorOptions.formats} is.
   *
   * See `CompileOptions.unknownFormats`.
   */
  unknownFormats?: "ignore" | "error";

  /**
   * Custom keywords registered with the in-memory compiler. A keyword
   * present here is delegable (its subtree is classified BUFFER); one
   * absent that appears in a schema is a compile-time REJECT, never a
   * silent pass. Threaded into the BUFFER-island delegate's
   * `compileSchema` call.
   */
  keywords?: Record<string, CustomKeywordValidator>;

  /**
   * Regex engine for `pattern` / `format`, e.g. RE2 for untrusted input
   * (ReDoS hardening). Hardens the spine's own regex use and is threaded
   * into the BUFFER-island delegate. Same option as
   * `@oaverify/internal-schema`'s `CompileOptions.regexCompiler`.
   */
  regexCompiler?: RegexCompiler;

  /**
   * Force exact `@oaverify/internal-schema` message parity by classifying `oneOf` /
   * `anyOf` (and other TEE-eligible composition) as BUFFER, so the
   * in-memory engine produces the violation messages. Default `false`
   * (stream where possible). Off by default because it trades the
   * streaming property for message fidelity.
   */
  parity?: boolean;

  /**
   * Emit a `key` event for matching scopes. Absent = off, and codegen is
   * byte-identical to the no-events spine. `true` emits for every key;
   * `{ at }` filters by path. Observe-and-abort only; it cannot rewrite
   * or dedupe output.
   */
  keyEvents?: boolean | { at: PathFilter };

  /**
   * Emit a `value` event when a scalar object-member value completes,
   * carrying the member's absolute input-byte span (`valueStart` /
   * `valueEnd`, the same pre-injection space `editClose` and violations
   * use) so a consumer can slice and parse it off its own copy of the
   * input without a second parser. Absent = off: the spine does no
   * value-event work and emits nothing (one unsubscribed early-return per
   * scalar, no allocation).
   *
   *   - `true`: emit for every scalar member, span only (no decode).
   *   - `{ at }`: restrict to members whose **full path** (the enclosing
   *     scope path plus the key) matches the filter, so a value filter
   *     targets one field (`["meta", "id"]`), not a whole scope. That full
   *     path is also the event's {@link ValueEvent.path}, so the filter and
   *     the event use one coordinate: a top-level member `{version}` is
   *     `["version"]` (length 1), not `[]`. This differs from `keyEvents.at`,
   *     which matches (and reports) the enclosing scope path.
   *   - `{ at, capture: true }`: also decode the matched scalar and deliver
   *     it as `value` on the event, bounded by `maxCaptureBytes` (a value
   *     larger than the cap is reported with `value` omitted and
   *     `truncated: true`; its span is still reported). Capture defaults to
   *     a {@link DEFAULT_MAX_CAPTURE_BYTES}-byte cap when `maxCaptureBytes`
   *     is unset; pass `Infinity` to disable the cap (retain the whole
   *     value, the way the other `max*` options read `Infinity`).
   *
   * Scope is scalar object members. Every scalar member fires, whether
   * validated on the STREAM path or routed to a scalar BUFFER island, so a
   * `format`-bearing string (`date-time`, `uri`, `uuid`) reports its value
   * even under an asserting OpenAPI dialect, where it would otherwise be
   * delegated silently. Array elements, the root value, and members routed
   * to a TEE composition branch (`oneOf`/`anyOf`/...) are not reported; an
   * object- or array-valued member is a container, not a scalar, and never
   * fires. See {@link ValueEvent}.
   */
  valueEvents?: boolean | { at: PathFilter; capture?: boolean; maxCaptureBytes?: number };

  /**
   * Cap on any single internal buffer (a forced-buffer scalar or a
   * BUFFER island), in **UTF-8 source bytes** spanned by the buffered
   * region. A proportional proxy for heap, not an exact heap bound; size
   * it with headroom. Default off.
   */
  maxBufferedBytes?: number;

  /**
   * Maximum nesting depth. Bounds spine-stack growth and guards the
   * native-stack `RangeError` an in-memory island delegate would throw
   * on a deeply nested island. Default off. Same option as
   * `@oaverify/internal-schema`'s `CompileOptions.maxDepth`.
   */
  maxDepth?: number;

  /**
   * Refuse input larger than this many bytes regardless of validity. A
   * policy lever; the STREAM path does not otherwise need it. Default
   * off.
   */
  maxTotalBytes?: number;

  /**
   * Cap on the element count of a `uniqueItems` array (its seen-set is
   * O(array length) memory, not covered by `maxBufferedBytes`, which bounds
   * UTF-8 bytes). A `uniqueItems` array buffers as a BUFFER island
   * delegated to the in-memory engine; this refuses one whose element count
   * exceeds the cap, before the rest of the array buffers, failing the
   * stream fatally. The bound survives the streaming canonical-hash mode
   * (which will cap the streamed seen-set by the same count). Default off.
   */
  maxUniqueItems?: number;

  /**
   * Cap on the held key-to-value span (key bytes + colon + whitespace)
   * for an `editMember` hook. JSON permits unbounded whitespace between
   * the colon and the value, so this span is bounded separately from the
   * value itself; over-cap is fatal. Unlike the schema-bound resource
   * limits above, this defaults *finite*
   * ({@link DEFAULT_MAX_MEMBER_PREFIX_BYTES}, 4 KB), because it bounds a
   * buffer the edit itself introduces. Raise it only for unusually
   * whitespace-heavy input.
   */
  maxMemberPrefixBytes?: number;

  /**
   * Cap on the withheld span of a dropped member (key + value +
   * delimiter), for an `editMember` hook that returns `drop`. A member
   * whose span exceeds the cap fails the stream fatally rather than
   * buffering unbounded. Defaults *finite* ({@link
   * DEFAULT_MAX_CAPTURE_BYTES}, 64 KB), the same "small member" size as
   * scalar capture but an independent knob: raise it to drop a larger
   * (still bounded) scalar member. Dropping a container-valued member is
   * not supported on the stream path (it throws `MemberEditError`), so
   * this cap only ever bounds a scalar span.
   */
  maxMemberDropBytes?: number;

  /**
   * Turn the classifier's unbounded-* warnings into compile errors: an
   * unbounded `pattern` / `format` string, an unbounded BUFFER island,
   * unbounded depth, or `uniqueItems` with no `maxItems`. The recommended
   * setting for untrusted input. Named for the resource-bound axis it
   * governs, distinct from `@oaverify/internal-validator`'s schema-lint `strict` mode.
   * Default `false`.
   */
  enforceBounds?: boolean;

  /**
   * Sink for non-fatal compile-time warnings (the unbounded-* dimensions
   * the classifier flags). Matches `@oaverify/internal-validator`'s
   * `ValidatorOptions.warn`. Absent: warnings are dropped (unless
   * `enforceBounds` escalates them to a thrown error).
   */
  warn?: (message: string) => void;
}
