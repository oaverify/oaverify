/**
 * Edit-hook types. Hooks fire at a forward-decidable scope's close, after
 * its verdict is known and before its delimiter; they observe the scope
 * or append sibling bytes (append-only, never validated).
 *
 * Scope coverage is STREAM-only: hooks fire for forward-decidable
 * (STREAM) scopes, not for scopes the classifier routes to a BUFFER
 * island (e.g. `uniqueItems`, `contains`, an object-valued `const`) or a
 * TEE composition branch (`oneOf`/`anyOf`/`allOf`). The set of scopes a
 * hook observes is a function of the schema's classification, so a hook
 * meant for generic JSON transformation will appear to fire
 * intermittently if the schema mixes streamable and buffered subtrees.
 *
 * @packageDocumentation
 */

import type { JsonValue, PathSegment } from "@oaverify/internal-core";

/**
 * Default cap on a captured scalar's source-byte span, applied when
 * `valueEvents.capture` is on and `maxCaptureBytes` is unset. Capture is
 * meant for small scalars (an id, a version, a timestamp); a member whose
 * value exceeds this is reported with `value` omitted and `truncated`
 * set, never buffered past the cap.
 */
export const DEFAULT_MAX_CAPTURE_BYTES = 65536;

/**
 * A `value` event: a scalar object-member value completed (validated on
 * the STREAM path or routed to a scalar BUFFER island, e.g. a
 * `format`-bearing string). Reports the member location and the value's
 * absolute input-byte span; carries the decoded value only when capture
 * is on.
 *
 * `valueStart` / `valueEnd` are absolute offsets into the **input** byte
 * stream, in the pre-injection space `editClose` and violations share. A
 * consumer slices `[valueStart, valueEnd)` from its own copy of the input
 * (the bytes include a string's surrounding quotes, so the slice is
 * itself valid JSON to `JSON.parse`). Slice the input, not the echoed
 * output: under `editClose` the output is respliced and its offsets no
 * longer line up.
 *
 * @public
 */
export interface ValueEvent {
  /**
   * Full path to the value: the enclosing scope path plus the member key.
   * This is the same coordinate `valueEvents.at` matches, so the filter and
   * the event speak the same path (a top-level member `{version}` is
   * `["version"]`, not `[]`). The last segment equals {@link key}.
   */
  path: PathSegment[];
  /** The member key (the last segment of {@link path}). */
  key: string;
  /** Byte offset of the value's first byte (a string's opening quote). */
  valueStart: number;
  /** Byte offset just past the value's last byte. */
  valueEnd: number;
  /** JSON type of the value. */
  type: "string" | "number" | "boolean" | "null";
  /**
   * The decoded value, present only when `valueEvents.capture` is on and
   * the value fit within `maxCaptureBytes`; otherwise `undefined`.
   */
  value?: string | number | boolean | null;
  /** True when capture was requested but the value exceeded `maxCaptureBytes` (the span is still reported). */
  truncated: boolean;
}

/** Bytes an `editClose` hook may append. A string is encoded as UTF-8. */
export type Bytes = Buffer | Uint8Array | string;

/** Context passed to a scope-close hook. */
export interface ScopeContext {
  /** Path to the closing scope. The root scope is `[]`. */
  readonly path: PathSegment[];
  readonly kind: "object" | "array";
  /** The scope's own verdict (its subtree validated clean). */
  readonly verdict: "valid" | "invalid";
  /** Members (object) or elements (array) seen in the scope. */
  readonly memberCount: number;
  /**
   * Build an object member to append, handling the leading comma: returns
   * `"name":value` when no member survives to the output (an empty scope, or
   * one whose every member was dropped by `editMember`), `,"name":value`
   * otherwise. The comma tracks surviving output members, not the input
   * {@link memberCount}. For object scopes; arrays append their own element
   * bytes.
   */
  field(name: string, value: JsonValue): string;
}

/** An observe hook (no output) bound to a path filter. */
export type ScopeObserver = (ctx: ScopeContext) => void;

/** An edit hook: returns bytes to append before the delimiter, or null for no-op. */
export type ScopeEditor = (ctx: ScopeContext) => Bytes | null;

/**
 * Default cap on the held key-to-value span (key bytes + colon +
 * whitespace) for an `editMember` hook, applied when `maxMemberPrefixBytes`
 * is unset. JSON allows unbounded whitespace between the colon and the
 * value, so this span needs its own bound: a legitimate key plus even
 * deep pretty-print indentation is well under this, while a whitespace-
 * padding attack trips it. Unlike the schema-bound resource limits
 * (`maxBufferedBytes`, ...), the edit caps default finite, because they
 * bound buffers the edit itself introduces. Over-cap is fatal.
 */
export const DEFAULT_MAX_MEMBER_PREFIX_BYTES = 4096;

/**
 * Context passed to a member-edit hook. Fires at the member's value start
 * (after its key, before the value streams), so {@link valueType} is
 * known.
 *
 * @public
 */
export interface MemberContext {
  /**
   * Full path to the member: the enclosing object's path plus the member
   * key. The same coordinate `editMember`'s `at` filter matches (a
   * top-level member `{version}` is `["version"]`), so the filter and the
   * context speak one path. The last segment equals {@link key}.
   */
  readonly path: PathSegment[];
  /** The member's current (pre-edit) key. */
  readonly key: string;
  /** JSON type of the member's value. */
  readonly valueType: "object" | "array" | "string" | "number" | "boolean" | "null";
}

/**
 * The edit a member-edit hook returns.
 *
 *   - `keep`: pass the member through unchanged (also the `null` no-op).
 *   - `rename`: substitute the key token (`JSON.stringify(key)`); the
 *     value streams verbatim, so a rename never buffers the value.
 *   - `drop`: suppress the member (key + value + one delimiter).
 *
 * A rename whose target collides with another key in the same object, and
 * two hooks returning conflicting edits for one member, are both fatal.
 *
 * @public
 */
export type MemberEdit =
  | { action: "keep" }
  | { action: "rename"; key: string }
  | { action: "drop" };

/**
 * A member-edit hook: decides whether to keep, rename, or drop a matched
 * object member. Returns `null` for a no-op (equivalent to `keep`).
 *
 * @public
 */
export type MemberEditor = (member: MemberContext) => MemberEdit | null;

/** Build the {@link MemberContext} for a member at its value start. */
export function makeMemberContext(
  path: PathSegment[],
  key: string,
  valueType: MemberContext["valueType"],
): MemberContext {
  return { path, key, valueType };
}

/** Coerce hook output to a Buffer (a string is UTF-8 encoded). */
export function toBuffer(bytes: Bytes): Buffer {
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  return Buffer.from(bytes);
}

/**
 * Build the {@link ScopeContext} for a closing scope. `memberCount` is the
 * input-observed count surfaced on the context; `outputMemberCount` is the
 * post-edit surviving count (kept + renamed) that drives `field()`'s leading
 * comma, so an appended field after all members were dropped does not emit a
 * stray comma. The two differ only under member edits; otherwise pass the
 * same value.
 */
export function makeScopeContext(
  path: PathSegment[],
  kind: "object" | "array",
  valid: boolean,
  memberCount: number,
  outputMemberCount: number,
): ScopeContext {
  return {
    path,
    kind,
    verdict: valid ? "valid" : "invalid",
    memberCount,
    field(name: string, value: JsonValue): string {
      const lead = outputMemberCount > 0 ? "," : "";
      return `${lead}${JSON.stringify(name)}:${JSON.stringify(value)}`;
    },
  };
}
