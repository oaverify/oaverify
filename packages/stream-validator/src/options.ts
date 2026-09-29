/**
 * The public option surface and shared path types for the streaming
 * validator.
 *
 * @packageDocumentation
 */

import type { FormatDefinition, PathSegment } from "@oaverify/internal-core";
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
 *   - **Dialect selection** (`dialect`, `openApiVersion`): which keyword
 *     set the delegate compiles under.
 *   - **Format policy** (`unknownFormats`): what an unregistered
 *     `format` name does.
 *   - **Input encoding** (`utf8`): whether malformed UTF-8 in the input
 *     bytes fails the stream.
 *   - **Observability** (`keyEvents`, `valueEvents`, `warn`): opt-in,
 *     compile-time-gated channels.
 *   - **Resource limits** (`maxBufferedBytes`, `maxDepth`,
 *     `maxTotalBytes`, `maxUniqueItems`, `enforceBounds`): all default off
 *     (unset = zero overhead). They bound the dimensions a
 *     forward-decidable schema leaves open.
 *   - **Member-edit caps** (`maxMemberPrefixBytes`, `maxMemberDropBytes`):
 *     `maxMemberPrefixBytes` is the exception to the line above. It
 *     defaults *finite*, because it bounds a buffer the edit itself
 *     introduces rather than one the schema left open, so there is no
 *     "unset costs nothing" version of it. `maxMemberDropBytes` is a
 *     policy limit and defaults off.
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
   *     of the input to output unchanged. With `editMember` hooks, the
   *     seal waits until no member edit is in flight (a member being
   *     dropped, or one whose hook has not run yet), so the edited output
   *     and the raw tail join into valid JSON. Until then the input is
   *     still parsed and hooks keep firing, so a hook error (such as a
   *     rename collision) is fatal there as it is before the budget.
   *
   * A parse error is always terminal regardless of policy.
   */
  policy?: "terminate" | "detach";

  /**
   * Extra format validators merged on top of `builtInFormats`, the same
   * shape and the same merge as `createValidator`'s option of this
   * name. One registry for every format whatever JSON type it
   * constrains; see {@link FormatDefinition}.
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
   *
   * Under a dialect that asserts `format`, a node carrying the keyword
   * is routed to a BUFFER island and asserted there; the forward path
   * never sees one. So these reach every `format` the engine asserts,
   * and under a non-asserting dialect neither engine asserts at all.
   */
  formats?: Record<string, FormatDefinition>;

  /**
   * What to do about a `format` with no validator registered under its
   * name: `"ignore"` (default) leaves it asserting nothing, `"error"`
   * makes construction throw, before any input byte is processed.
   *
   * Only the BUFFER-island delegate asserts `format`, so this is scoped
   * to the same place {@link StreamValidatorOptions.formats} is.
   *
   * Registered is asked of the built-ins merged under
   * {@link StreamValidatorOptions.formats}, not of that option alone, so
   * `formats: {}` refuses nothing. A name `builtInFormats` does not
   * carry (`password`, say) has to be registered before `"error"` will
   * construct on a document declaring it, as `false` where the name is
   * meant to assert nothing.
   *
   * See `CompileOptions.unknownFormats`.
   */
  unknownFormats?: "ignore" | "error";

  /**
   * Input encoding policy for strings and object keys.
   *
   * - `"reject"` (default): malformed UTF-8 rejects the stream and `result`
   *   with a `JsonParseError` at the first byte of the malformed sequence.
   * - `"replace"`: decode malformed sequences to U+FFFD and validate the
   *   replacement text, matching `Buffer#toString`. This preserves the
   *   previous behavior for closed ecosystems.
   *
   * Encoded U+FFFD and JSON surrogate escapes are accepted under either
   * setting, subject to the schema. Bytes above 0x7F outside strings remain
   * parse errors. The echoed bytes are unchanged by this option; abort or
   * discard stored output when validation fails.
   */
  utf8?: "reject" | "replace";

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
   *
   * By default, schema patterns compile in Unicode mode, retrying without
   * flags if that fails. Patterns invalid in both modes fail through the
   * stream's fatal error channel when first used. The `regex` format checks
   * data strings in Unicode mode only. A supplied compiler overrides both
   * policies, with no native retry. Its schema-pattern exceptions are fatal;
   * for `format: regex`, an exception means the data string fails validation.
   */
  regexCompiler?: RegexCompiler;

  /**
   * Force exact `@oaverify/internal-schema` message parity by classifying `oneOf` /
   * `anyOf` as BUFFER, so the
   * in-memory engine produces the violation messages. Default `false`
   * (stream where possible). Off by default because it trades the
   * streaming property for message fidelity.
   */
  parity?: boolean;

  /**
   * Emit a `key` event for matching scopes. Absent = off: the spine does
   * no key-event work. `true` emits for every key;
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
   * Depth limit whose measurement depends on the validation path.
   * Defaults to uncapped. Use it to reject excessively nested input on
   * the forward path and guard recursive delegates against native-stack
   * overflow.
   *
   * Forward validation limits the number of open container frames on the
   * streaming stack. With `maxDepth: 1`, `[1]` fits the depth limit but
   * `[[1]]` reports a `depth` violation on this path.
   *
   * In-memory delegates receive the same number as
   * `@oaverify/internal-schema`'s `CompileOptions.maxDepth`: a limit on
   * recursive, cycle-closing `$ref` calls. They do not count all JSON
   * containers, and non-recursive schemas are not instrumented. A value
   * can therefore pass that limit in a delegate but exceed the forward
   * container limit. Leaving this option unset disables both limits.
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
   * Cap on the separators and whitespace held around an object member's
   * key for an `editMember` hook. The editing echo holds each member's
   * prefix, from the comma before it (or the `{`) through the key and
   * colon to the value, until the hook decides the member, since a drop
   * removes it and a keep may remove its comma. JSON permits unbounded
   * whitespace on both sides of the key, so those bytes are capped;
   * over-cap is fatal. The key token itself is not counted: the cap does
   * not bound key length or key memory, which `maxTotalBytes` bounds for
   * the whole input. Once any `editMember` hook is registered it applies to
   * every member an edit can reach: members of streamed objects, not those
   * inside a dropped member or a value checked by composition or
   * buffering. Unlike the schema-bound resource limits above, this
   * defaults *finite* ({@link DEFAULT_MAX_MEMBER_PREFIX_BYTES}, 4 KB),
   * because it bounds a buffer the edit itself introduces. Raise it for
   * runs of whitespace around keys longer than that.
   */
  maxMemberPrefixBytes?: number;

  /**
   * Refuse a member an `editMember` hook drops when its span, from the key's
   * opening quote to the value's end, exceeds this many bytes. Whitespace
   * after the value does not count. Over-cap is fatal (`MemberEditError`,
   * at the span's start plus the cap). Unset: no limit, since a dropped
   * member is discarded as it streams and never held.
   *
   * A string, object or array is refused while it streams, at the latest
   * at the end of the write that carries it past the cap. A number or
   * `true` / `false` / `null` is refused when its token ends: the tokenizer
   * reports it whole, so the hook decides the member only then. A value
   * over the limit fails this way even when it also fails validation: a
   * validation failure inside a dropped value waits for the value's end.
   */
  maxMemberDropBytes?: number;

  /**
   * Turn the classifier's unbounded-* warnings into compile errors: an
   * unbounded `pattern` / `format` string, or `uniqueItems` with no
   * `maxItems`. The recommended
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
