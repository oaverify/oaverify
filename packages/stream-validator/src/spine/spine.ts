/**
 * The forward validation spine: a {@link JsonEventHandler} that validates
 * a streaming JSON value against a resolved schema in one pass, carrying
 * scope on an explicit heap stack, and produces a verdict.
 *
 * A scope holds the AND-list of schemas its value must satisfy
 * (structural applicator overlap plus `$ref` expansion all combine as
 * "must satisfy every one"); `$ref` is followed by expansion, so deep
 * recursion grows the heap scope stack, never the native call stack.
 *
 * A value is handled by one of three strategies:
 *
 *   - **STREAM**: validated on the forward state machines in one pass.
 *   - **TEE**: forward composition (`allOf` / `anyOf` / `oneOf` / `not` /
 *     `if`, all branches forward). The value's events are fanned out to
 *     one forward sub-spine per branch (no materialization) and the
 *     combinators are evaluated at scope-close; this is what keeps a
 *     composition body streaming.
 *   - **BUFFER island**: anything that needs the whole value (object/array
 *     `enum` / `const`, `dependentSchemas`, `discriminator`, `contains`,
 *     `uniqueItems`, a composition with a non-forward branch, or `format`
 *     under an asserting dialect). The value is materialized via
 *     {@link ValueBuilder} and handed to the injected
 *     {@link IslandDelegate} (the in-memory engine).
 *
 * BUFFER dominates TEE (a value needing both materializes). With no
 * delegate wired (a bare spine), a BUFFER value throws
 * {@link SpineUnsupportedError}; forward composition still TEEs.
 * `maxBufferedBytes` caps a single island (and forced-buffer scalar);
 * `maxDepth` records a `depth` violation.
 *
 * @packageDocumentation
 */

import type { PathSegment, SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import type { RegexCompiler } from "@oaverify/internal-schema";
import type { Strategy } from "../classifier/strategy.js";
import type { JsonEventHandler } from "../tokenizer/index.js";
import { resolveRef } from "../ref-resolve.js";
import { ValueBuilder } from "./value-builder.js";

/** A construct the spine cannot handle without a delegate (no classification wired). */
export class SpineUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpineUnsupportedError";
  }
}

/**
 * Internal control-flow signal: the validation budget (`maxErrors`) has
 * been reached, so the spine stops feeding the tokenizer. The engine
 * catches it and applies the terminal policy; it is not a parse error.
 */
export class BudgetReached extends Error {
  constructor() {
    super("validation budget reached");
    this.name = "BudgetReached";
  }
}

/**
 * A buffered island exceeded the configured `maxBufferedBytes`. Fatal.
 *
 * One of the package's resource-limit errors (alongside
 * {@link UniqueItemsLimitError} and `MaxTotalBytesError`): a fatal `error`
 * channel throw distinct from a {@link SchemaViolation} (a well-formed but
 * invalid value). Caught with `instanceof` to tell "too big" from
 * "invalid".
 */
export class BufferLimitError extends Error {
  /** The `maxBufferedBytes` value that was exceeded. */
  readonly limit: number;
  /** Stream-absolute byte offset at which the cap was crossed. */
  readonly byteOffset: number;
  constructor(limit: number, byteOffset: number) {
    super(`buffered island exceeded maxBufferedBytes=${limit} (at byte ${byteOffset})`);
    this.name = "BufferLimitError";
    this.limit = limit;
    this.byteOffset = byteOffset;
  }
}

/**
 * A `uniqueItems` array buffered for delegation exceeded the configured
 * `maxUniqueItems` element count. Fatal: the array cannot be validated
 * within the seen-set budget, so it is refused rather than held unbounded.
 *
 * A resource-limit error (see {@link BufferLimitError}).
 */
export class UniqueItemsLimitError extends Error {
  /** The `maxUniqueItems` value that was exceeded. */
  readonly limit: number;
  /** Stream-absolute byte offset at which the cap was crossed. */
  readonly byteOffset: number;
  constructor(limit: number, byteOffset: number) {
    super(`uniqueItems array exceeded maxUniqueItems=${limit} (at byte ${byteOffset})`);
    this.name = "UniqueItemsLimitError";
    this.limit = limit;
    this.byteOffset = byteOffset;
  }
}

/**
 * A member edit could not be applied. Fatal (the `error` channel), distinct
 * from a {@link SchemaViolation}: the input may be valid, but the requested
 * rename/drop cannot be carried out safely or unambiguously.
 *
 * Covers the member-edit failure modes:
 *   - the held key-to-value span exceeded `maxMemberPrefixBytes`;
 *   - a dropped member's span exceeded `maxMemberDropBytes`;
 *   - a rename produced a duplicate key in the same object;
 *   - a `drop` targeted a container value (not supported on the stream
 *     path yet).
 */
export class MemberEditError extends Error {
  /** Stream-absolute byte offset at which the failure was detected. */
  readonly byteOffset: number;
  constructor(message: string, byteOffset: number) {
    super(message);
    this.name = "MemberEditError";
    this.byteOffset = byteOffset;
  }
}

/** Validates a materialized island value against schemas; returns flat violations. */
export type IslandDelegate = (
  schemas: SchemaObject[],
  value: unknown,
  startPath: PathSegment[],
  byteOffset: number,
) => SchemaViolation[];

/**
 * A non-fatal schema violation: a well-formed value that failed the
 * schema, reported on the `violation` side channel (distinct from the
 * fatal `error` channel). Shares `code` and `path` with `@oaverify/internal-core`'s
 * `ValidationError` and adds `byteOffset`.
 *
 * `message` / `params` / `children` are populated on the BUFFER (island)
 * path, where the in-memory engine produces them; on the forward STREAM
 * path they are absent (a leaf violation carries `code` + `path` +
 * `byteOffset`). They are optional so stream-path enrichment can land
 * additively; stream-path codes are coarse and the channel layer
 * refines them.
 */
export interface SchemaViolation {
  code: string;
  path: PathSegment[];
  /**
   * Byte offset in the input stream nearest the violation (for re-sync).
   * Stream-absolute: counted from the first byte fed to the validator,
   * never reset or rebased. A future per-record (sequence) lifecycle
   * reports record position additively on its own item channel and does
   * not redefine this field, so a consumer can treat this offset as a
   * stable, monotonic coordinate.
   * On the BUFFER path every node of one island (a violation and its
   * `children`) shares the island's start offset; per-child precision is
   * not tracked.
   */
  byteOffset: number;
  /** Human-readable message (BUFFER path only; absent on the STREAM path). */
  message?: string;
  /** Keyword-specific machine-readable detail (BUFFER path only). */
  params?: Record<string, unknown>;
  /** Child violations, e.g. per-branch composition failures (BUFFER path only). */
  children?: SchemaViolation[];
}

/** Options for {@link SpineValidator}. */
export interface SpineOptions {
  /** Called as each violation is recorded (lets a driver enforce a budget / terminate). */
  onViolation?: (violation: SchemaViolation) => void;
  /** Per-node strategy from the classifier. Absent: every node is treated as `stream`. */
  strategyOf?: (node: SchemaOrBoolean) => Strategy;
  /**
   * Document root for `$ref` resolution, when it differs from the
   * validation root (a TEE sub-spine validates a branch but resolves refs
   * against the whole document). Defaults to the validation root.
   */
  refRoot?: SchemaOrBoolean;
  /**
   * Validates a materialized BUFFER island against its schemas (the
   * in-memory engine). Required for any non-stream node; absent, such a
   * node throws {@link SpineUnsupportedError}.
   */
  delegate?: IslandDelegate;
  /** Stop recording after this many violations, throwing {@link BudgetReached}. Default unlimited. */
  maxErrors?: number;
  /**
   * Track only a boolean verdict, not the violation list (used by TEE
   * branch sub-spines, which the parent reads as valid/invalid). Keeps a
   * branch over a large value O(1) in memory. Default false.
   */
  verdictOnly?: boolean;
  /** Cap on a single buffered island's UTF-8 source-byte span (and forced-buffer scalar). Unset: no cap. */
  maxBufferedBytes?: number;
  /** Cap on the element count of a buffered `uniqueItems` array (its seen-set is O(that)). Unset: no cap. */
  maxUniqueItems?: number;
  /** Maximum nesting depth. Exceeding it is a `depth` violation. Unset: no cap. */
  maxDepth?: number;
  /** Regex engine for `pattern` (e.g. RE2). Hardens the spine's own regex use. */
  regexCompiler?: RegexCompiler;
  /**
   * The active dialect asserts `format` (OpenAPI). When true, a schema
   * carrying `format` is delegated so the in-memory engine asserts it
   * (the spine has no format assertion of its own).
   */
  assertsFormat?: boolean;
  /**
   * Observability hook fired for every object key, with the enclosing
   * scope's path. Set only when key events are requested (so the spine
   * pays nothing when they are off); the driver applies any path filter.
   */
  keyEvent?: (scopePath: readonly PathSegment[], key: string, byteOffset: number) => void;
  /**
   * Fired when a scalar object-member value completes, with the enclosing
   * scope path, the member key, the value's absolute input-byte span, its
   * JSON type, and (when this member is being captured) the decoded value.
   * Fires for every scalar member, whether validated on the STREAM path or
   * routed to a scalar BUFFER island (a `format`-bearing string, a
   * buffered scalar): the value is materialized for the delegate either
   * way. Array elements, the root value, and TEE composition members are
   * not reported. Set only when value events are requested (so the spine
   * pays nothing when they are off); the driver applies any path filter
   * and routes the event.
   */
  valueEvent?: (
    scopePath: readonly PathSegment[],
    key: string,
    valueStart: number,
    valueEnd: number,
    type: "string" | "number" | "boolean" | "null",
    value: string | number | boolean | null | undefined,
    truncated: boolean,
  ) => void;
  /**
   * Whether a matched member's decoded scalar should be captured (retained
   * and delivered on {@link SpineOptions.valueEvent}). Consulted at a
   * STREAM string's first byte to gate text retention, and at completion
   * for values already in hand. Set only when capture is requested; an
   * offsets-only value subscription leaves it unset and the spine buffers
   * nothing.
   */
  shouldCapture?: (scopePath: readonly PathSegment[], key: string) => boolean;
  /** Cap on a captured scalar's source-byte span; past it the value is dropped and `truncated` is set. Unset: no cap. */
  maxCaptureBytes?: number;
  /**
   * Fired when a forward-decidable (STREAM) object/array scope closes,
   * after its verdict is known and before its delimiter, for edit hooks.
   * Islands (composition / buffered scopes) are not reported: their
   * verdict is not final at the streaming close.
   */
  onScopeClose?: (close: ScopeClose) => void;
  /**
   * Resolve a member-edit decision for a STREAM object member, called at
   * the member's value start (so the value type is known). Returns the
   * effective edit, or `null`/`{kind:"keep"}` for a pass-through. Set only
   * when member-edit hooks are registered; the engine owns hook matching
   * and conflict resolution, the spine owns offsets, the prefix cap, and
   * same-scope output-key collision.
   */
  memberEdit?: (
    scopePath: readonly PathSegment[],
    key: string,
    valueType: "object" | "array" | "string" | "number" | "boolean" | "null",
  ) => MemberDecision | null;
  /** Emit a key-token replacement (rename): replace input `[start, end)` with `bytes`. */
  emitReplace?: (start: number, end: number, bytes: string) => void;
  /** Emit a member deletion (drop): delete input `[start, end)` (delimiter ownership resolved by the spine). */
  emitDelete?: (start: number, end: number) => void;
  /** Cap on the held key-to-value span for a member edit; over-cap is fatal. */
  maxMemberPrefixBytes?: number;
  /** Cap on a dropped member's withheld span; over-cap is fatal. */
  maxMemberDropBytes?: number;
}

/**
 * A resolved member-edit decision (engine-resolved from the registered
 * hooks). `keep` passes through; `rename` rewrites the key token and
 * streams the value; `drop` suppresses the member.
 */
export type MemberDecision = { kind: "keep" } | { kind: "rename"; key: string } | { kind: "drop" };

/** The verdict of a streaming validation. */
export interface StreamVerdict {
  valid: boolean;
  violations: SchemaViolation[];
  /**
   * High-water buffered wire bytes (UTF-8 source span), the runtime companion
   * to `analyzeStreamability().peakBytes`. This is an upper-bound *estimate*
   * in the analyzer's concurrency model, not an exact live-heap gauge: a
   * single BUFFER island is exact, sibling buffers take the max, and a TEE
   * sums its branch peaks (conservative, since branches overlap but the sum
   * assumes full concurrency). The engine adds its edit-retention echo on top.
   * Interpret it as the analyzer-model peak, comparable to the predicted
   * `peakBytes`:
   *
   *   - `0` means no buffering happened (a fully-streamable validation with no
   *     edit hooks).
   *   - A non-zero value is how close real traffic came to the buffer budget
   *     (`maxBufferedBytes`), in the same unit.
   *
   * A proportional proxy for heap, not a heap figure (the materialized value
   * is larger than its source span).
   */
  peakBufferedBytes: number;
}

type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

interface Applicable {
  schemas: SchemaObject[];
  hasFalse: boolean;
}

interface ObjectFrame {
  kind: "object";
  schemas: SchemaObject[];
  seen: Set<string>;
  count: number;
  pendingKey: string | null;
  violationsAtOpen: number;
  // Member-edit bookkeeping (set only when member edits are active).
  // Byte span of the pending key's token, for a rename replacement.
  pendingKeyStart: number;
  pendingKeyEnd: number;
  // Effective output names seen in this object, each flagged whether it
  // came from a rename, to make a rename-induced duplicate key fatal while
  // leaving a pre-existing input duplicate alone.
  outputKeys: Map<string, boolean> | null;
  // Offset just past the last kept/renamed member's value (the left bound
  // when deleting a trailing dropped member, to absorb its leading comma).
  // Initialized to the offset just after the opening `{`.
  lastKeptValueEnd: number;
  // A dropped member awaiting delimiter resolution (at the next member key
  // or the object close).
  pendingDrop: { keyStart: number; valueEnd: number } | null;
}

interface ArrayFrame {
  kind: "array";
  schemas: SchemaObject[];
  count: number;
  violationsAtOpen: number;
}

// The combinator obligations a TEE value must satisfy. Each sub-spine
// validates the same value against one branch; verdicts are read at close.
interface TeeObligations {
  required: SpineValidator[]; // all must be valid (own keywords + allOf)
  anyOf: SpineValidator[][]; // each group: >= 1 valid
  oneOf: SpineValidator[][]; // each group: exactly 1 valid
  not: SpineValidator[]; // each must be INVALID
  ite: Array<{
    ifSub: SpineValidator;
    thenSub: SpineValidator | null;
    elseSub: SpineValidator | null;
  }>;
  hasFalse: boolean;
}

/** A forward-decidable (STREAM) scope closing, reported for edit hooks. */
export interface ScopeClose {
  path: PathSegment[];
  kind: "object" | "array";
  valid: boolean;
  /**
   * Members (object) or elements (array) seen in the *input*. The observe
   * count, surfaced verbatim as `ScopeContext.memberCount`.
   */
  memberCount: number;
  /**
   * Members that survive to the *output* after member edits: kept + renamed,
   * excluding dropped. Equals {@link memberCount} when no member edits apply.
   * Drives the leading-comma decision in `ScopeContext.field()`, so an
   * appended field after an all-members drop does not emit a stray comma.
   */
  outputMemberCount: number;
  /** Byte offset of the closing delimiter (`}` / `]`). */
  delimiterOffset: number;
}

type Frame = ObjectFrame | ArrayFrame;

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

function typeMatches(declared: string | string[], actual: JsonType): boolean {
  const allow = Array.isArray(declared) ? declared : [declared];
  for (const t of allow) {
    if (t === actual) return true;
    if (t === "number" && actual === "integer") return true;
  }
  return false;
}

const STREAM_COMPOSITION = ["allOf", "anyOf", "oneOf", "not", "if"];

/**
 * Validates a streaming JSON value against `root`, emitting violations
 * and a final verdict. Drive it by feeding tokenizer events; read the
 * verdict with {@link SpineValidator.verdict} after `end`.
 *
 * @public
 */
export class SpineValidator implements JsonEventHandler {
  private readonly root: SchemaOrBoolean;
  private readonly refRoot: SchemaObject;
  private readonly violations: SchemaViolation[] = [];
  private readonly path: PathSegment[] = [];
  private readonly frames: Frame[] = [];
  private readonly regexCache = new Map<string, { test(s: string): boolean }>();
  // Memoized `$ref` / `$dynamicRef` resolution against the fixed `refRoot`.
  // `expand` runs per value, so without this an anchor ref (`#name`) would
  // re-scan the whole document via `walkSubschemas` on every occurrence
  // (O(N*M) across a large array or broad object). Keyed by ref string,
  // which is stable because `refRoot` is immutable for the spine's life;
  // `undefined` (a dangling/external ref) is cached too via `has`.
  private readonly refCache = new Map<string, SchemaOrBoolean | undefined>();
  // Memoized per-node stream/tee/buffer decision (see nodeKind).
  private readonly kindCache = new Map<SchemaObject, "stream" | "tee" | "buffer">();
  private readonly onViolation: ((violation: SchemaViolation) => void) | undefined;
  private readonly strategyOf: (node: SchemaOrBoolean) => Strategy;
  private readonly delegate: IslandDelegate | undefined;
  private readonly maxErrors: number;
  private readonly maxBufferedBytes: number | undefined;
  // High-water mark of buffered wire bytes (see {@link StreamVerdict.peakBufferedBytes}).
  // Bumped where a buffer's span is known: the island cap check, the
  // forced-buffer scalar close, and a TEE close (sum of branch peaks).
  private peakBufferedBytes = 0;
  private readonly maxUniqueItems: number | undefined;
  private readonly maxDepth: number | undefined;
  private readonly regexCompiler: RegexCompiler | undefined;
  private readonly assertsFormat: boolean;
  private readonly keyEvent:
    | ((scopePath: readonly PathSegment[], key: string, byteOffset: number) => void)
    | undefined;
  private readonly valueEvent:
    | ((
        scopePath: readonly PathSegment[],
        key: string,
        valueStart: number,
        valueEnd: number,
        type: "string" | "number" | "boolean" | "null",
        value: string | number | boolean | null | undefined,
        truncated: boolean,
      ) => void)
    | undefined;
  private readonly shouldCapture:
    | ((scopePath: readonly PathSegment[], key: string) => boolean)
    | undefined;
  private readonly maxCaptureBytes: number | undefined;
  private readonly onScopeClose: ((close: ScopeClose) => void) | undefined;
  private readonly memberEdit: SpineOptions["memberEdit"];
  private readonly emitReplace: SpineOptions["emitReplace"];
  private readonly emitDelete: SpineOptions["emitDelete"];
  // Off until `enableMemberEdits()`; gates all member-edit work so a stream
  // with no hooks pays nothing.
  private memberEditActive = false;
  private readonly maxMemberPrefixBytes: number;
  private readonly maxMemberDropBytes: number;
  // A key seen (onKey) whose member-edit decision is pending until its
  // value starts; the editing echo holds bytes from here so a rename can
  // rewrite the key. `+Infinity` when no decision is pending.
  private pendingDecisionKeyStart = Number.POSITIVE_INFINITY;
  // A string value member's resolved decision, carried from its start
  // (`onStringStart`) to its end (`onStringEnd`, where the value end
  // finalizes a drop span); null when no decision is pending.
  private pendingStringDecision: MemberDecision | null = null;
  // Verdict-only mode (TEE branch sub-spines): track a single invalid flag
  // instead of retaining a violation per failure, so a branch over a huge
  // array stays O(1) memory. The parent only reads `verdict().valid`.
  private readonly verdictOnly: boolean;
  private invalid = false;
  private depthReported = false;

  // Byte offset of the event currently being validated; stamped onto
  // violations so a consumer can re-sync against the byte stream.
  private curOffset = 0;

  // A value string in progress: its applicable schemas, whether the full
  // text is needed (pattern / enum / const, or an island), the accumulated
  // text, and whether the string position is a BUFFER island.
  private str: {
    app: Applicable;
    needText: boolean;
    text: string;
    offset: number;
    island: boolean;
    // `capture`: retain the decoded text for a `value` event (decided at
    // string start from `shouldCapture`). `captureTruncated`: the captured
    // span passed `maxCaptureBytes`, so the value is dropped (span still
    // reported). Independent of `needText` / `maxBufferedBytes`, which
    // govern validation buffering.
    capture: boolean;
    captureTruncated: boolean;
    // Eager `maxLength`: the tightest applicable cap (min across schemas, a
    // STREAM string only; an island string's length is the delegate's job),
    // a running code-point count, and a once-fired flag. `undefined` cap =
    // no `maxLength` applies, so the per-chunk counter is skipped entirely.
    maxLen: number | undefined;
    cp: number;
    lenFailed: boolean;
  } | null = null;

  // An open BUFFER island being materialized for delegation.
  private island: {
    schemas: SchemaObject[];
    path: PathSegment[];
    builder: ValueBuilder;
    byteStart: number;
    // Element-count cap when this island is a `uniqueItems` array and
    // `maxUniqueItems` is set; `undefined` otherwise (no count enforced).
    uniqueCap: number | undefined;
  } | null = null;

  // An open TEE: the value's events are forwarded to one forward sub-spine
  // per composition branch (no materialization); combined at scope-close.
  private tee: {
    obligations: TeeObligations;
    subs: SpineValidator[]; // flat list, for event forwarding
    depth: number;
    inString: boolean;
    started: boolean;
    // The tee'd value opened a container (so it is a container member): used
    // to record its value-end for a later trailing-drop delete.
    sawContainer: boolean;
  } | null = null;

  constructor(root: SchemaOrBoolean, options: SpineOptions = {}) {
    this.root = root;
    const ref = options.refRoot ?? root;
    this.refRoot = isObjectSchema(ref) ? ref : ({} as SchemaObject);
    this.onViolation = options.onViolation;
    this.strategyOf = options.strategyOf ?? (() => "stream");
    this.delegate = options.delegate;
    this.maxErrors = options.maxErrors ?? Number.POSITIVE_INFINITY;
    this.verdictOnly = options.verdictOnly ?? false;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.maxUniqueItems = options.maxUniqueItems;
    this.maxDepth = options.maxDepth;
    this.regexCompiler = options.regexCompiler;
    this.assertsFormat = options.assertsFormat ?? false;
    this.keyEvent = options.keyEvent;
    this.valueEvent = options.valueEvent;
    this.shouldCapture = options.shouldCapture;
    this.maxCaptureBytes = options.maxCaptureBytes;
    this.onScopeClose = options.onScopeClose;
    this.memberEdit = options.memberEdit;
    this.emitReplace = options.emitReplace;
    this.emitDelete = options.emitDelete;
    this.maxMemberPrefixBytes = options.maxMemberPrefixBytes ?? Number.POSITIVE_INFINITY;
    this.maxMemberDropBytes = options.maxMemberDropBytes ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Turn on member-edit processing. Off by default so a stream with no
   * `editMember` hooks pays nothing (the per-value decision, key-offset
   * tracking, and output-key sets are all gated on this). Called by the
   * engine when the first member hook registers.
   */
  enableMemberEdits(): void {
    this.memberEditActive = true;
  }

  /**
   * The lowest input-byte offset whose emission must wait for a member-edit
   * decision: a key onKey'd but not yet decided, or a dropped member awaiting
   * delimiter resolution. `+Infinity` when nothing is pending. Combined with
   * the tokenizer's mid-key hold offset by the editing echo.
   */
  get editSafeOffset(): number {
    let s = this.pendingDecisionKeyStart;
    const top = this.frames[this.frames.length - 1];
    if (top !== undefined && top.kind === "object" && top.pendingDrop !== null) {
      s = Math.min(s, top.pendingDrop.keyStart);
    }
    return s;
  }

  // Record a member's effective output name, making a rename-induced
  // duplicate within the same object fatal. A pre-existing input duplicate
  // (two kept members with the same key) is left alone; we only police
  // collisions an edit introduced.
  private recordOutputKey(top: ObjectFrame, name: string, fromRename: boolean): void {
    const keys = top.outputKeys as Map<string, boolean>;
    const existing = keys.get(name);
    if (existing !== undefined && (fromRename || existing)) {
      throw new MemberEditError(
        `member rename produced a duplicate key ${JSON.stringify(name)} in the same object`,
        this.curOffset,
      );
    }
    keys.set(name, fromRename || (existing ?? false));
  }

  // Resolve a member-edit decision at the member's value start: enforce the
  // prefix cap, consult the engine, apply collision rules, and emit a rename
  // replacement. Returns the decision so the caller can finalize the member
  // (a drop's span, or advancing `lastKeptValueEnd`) once its value end is
  // known. A no-op `keep` decision when member edits are off or this is not
  // an object member.
  private decideMember(
    valueType: "object" | "array" | "string" | "number" | "boolean" | "null",
    valueStart: number,
  ): MemberDecision {
    this.pendingDecisionKeyStart = Number.POSITIVE_INFINITY;
    const top = this.frames[this.frames.length - 1];
    if (!this.memberEditActive || top === undefined || top.kind !== "object") {
      return { kind: "keep" };
    }
    const key = top.pendingKey as string;
    if (valueStart - top.pendingKeyEnd > this.maxMemberPrefixBytes) {
      throw new MemberEditError(
        `member ${JSON.stringify(key)} key-to-value span exceeded maxMemberPrefixBytes=${this.maxMemberPrefixBytes}`,
        valueStart,
      );
    }
    const decision = this.memberEdit!(this.path, key, valueType) ?? { kind: "keep" };
    switch (decision.kind) {
      case "keep":
        this.recordOutputKey(top, key, false);
        break;
      case "rename":
        this.recordOutputKey(top, decision.key, true);
        this.emitReplace!(top.pendingKeyStart, top.pendingKeyEnd, JSON.stringify(decision.key));
        break;
      case "drop":
        if (valueType === "object" || valueType === "array") {
          throw new MemberEditError(
            `dropping a container-valued member (${JSON.stringify(key)}) is not supported on the stream path`,
            valueStart,
          );
        }
        // Hold from the key right away (value end filled in at finalize), so
        // the dropped value's bytes are not flushed before the delete is
        // resolved at the next sibling key or the object close.
        top.pendingDrop = { keyStart: top.pendingKeyStart, valueEnd: -1 };
        break;
    }
    return decision;
  }

  // After a container value (object/array) member closes, advance the
  // enclosing object's `lastKeptValueEnd` to just past it. Container members
  // are always kept (a container drop is unsupported), so this records the
  // value-end that a later trailing-drop delete needs as its left bound.
  private noteContainerMemberEnd(closeOffset: number): void {
    if (!this.memberEditActive) return;
    const parent = this.frames[this.frames.length - 1];
    if (parent !== undefined && parent.kind === "object") parent.lastKeptValueEnd = closeOffset + 1;
  }

  // Finalize a scalar member once its value end is known: record a dropped
  // member's span (bounded by `maxMemberDropBytes`) for delimiter resolution,
  // or advance `lastKeptValueEnd` for a kept/renamed member.
  private finalizeScalarMember(decision: MemberDecision, valueEnd: number): void {
    if (!this.memberEditActive) return;
    const top = this.frames[this.frames.length - 1];
    if (top === undefined || top.kind !== "object") return;
    if (decision.kind === "drop") {
      // `pendingDrop` was opened at the decision (value start) to hold the
      // value's bytes; fill in its end and enforce the span cap.
      if (valueEnd - top.pendingKeyStart > this.maxMemberDropBytes) {
        throw new MemberEditError(
          `dropped member ${JSON.stringify(top.pendingKey)} span exceeded maxMemberDropBytes=${this.maxMemberDropBytes}`,
          valueEnd,
        );
      }
      if (top.pendingDrop !== null) top.pendingDrop.valueEnd = valueEnd;
    } else {
      top.lastKeptValueEnd = valueEnd;
    }
  }

  // The enclosing object member's key, when the value about to / just
  // completed is an object member (not an array element or the root
  // value). Gates value events to scalar object members.
  private memberKey(): string | null {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined || top.kind !== "object") return null;
    return top.pendingKey;
  }

  // The path to the value currently being read, including its own segment
  // (mirrors what `pushSegment` would push at value start). Used to report
  // an eager scalar failure at the same path the close-time check would.
  private pendingPath(): PathSegment[] {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return [...this.path]; // root value
    return [...this.path, top.kind === "object" ? (top.pendingKey as string) : top.count];
  }

  // Report a completed scalar object-member value through the one emit
  // path every scalar uses (no per-type drift). Call only when
  // `valueEvent` is set (the callers guard, matching `keyEvent?.()`).
  //
  // Capture mode (`shouldCapture` set): the spine applies the filter here
  // and the driver trusts it, so the filter runs once per member, not
  // again in the driver. A non-matching member emits nothing; a matching
  // one carries `decoded` (or nothing when `truncated`). A STREAM string
  // decided its match at string start (to gate text retention) and passes
  // it as `precomputedMatch` so the filter is not re-run; other scalars
  // have it in hand at completion and let this method evaluate it.
  //
  // Span-only mode (`shouldCapture` unset): every scalar member is emitted
  // with no value, and the driver applies any path filter.
  private emitScalarMember(
    valueStart: number,
    valueEnd: number,
    type: "string" | "number" | "boolean" | "null",
    decoded: string | number | boolean | null,
    truncated: boolean,
    precomputedMatch?: boolean,
  ): void {
    const key = this.memberKey();
    if (key === null) return;
    if (this.shouldCapture === undefined) {
      this.valueEvent!(this.path, key, valueStart, valueEnd, type, undefined, false);
      return;
    }
    const matched = precomputedMatch ?? this.shouldCapture(this.path, key);
    if (!matched) return;
    this.valueEvent!(
      this.path,
      key,
      valueStart,
      valueEnd,
      type,
      truncated ? undefined : decoded,
      truncated,
    );
  }

  /** The verdict so far (final once `end` has been called on the tokenizer). */
  verdict(): StreamVerdict {
    const peakBufferedBytes = this.peakBufferedBytes;
    if (this.verdictOnly)
      return { valid: !this.invalid, violations: this.violations, peakBufferedBytes };
    return { valid: this.violations.length === 0, violations: this.violations, peakBufferedBytes };
  }

  /** The buffered-bytes high-water reached so far. Read by an enclosing TEE
   * to sum its branch sub-spines' peaks. */
  peakBuffered(): number {
    return this.peakBufferedBytes;
  }

  // Raise the buffered-bytes high-water to `bytes` if it exceeds the current
  // mark. Called where a buffer's span is known (island cap check, scalar
  // close, TEE close).
  private notePeakBuffered(bytes: number): void {
    if (bytes > this.peakBufferedBytes) this.peakBufferedBytes = bytes;
  }

  private fail(code: string, path: PathSegment[] = this.path): void {
    this.record({ code, path: [...path], byteOffset: this.curOffset });
  }

  // Record a violation and enforce the budget. Once `maxErrors` is
  // reached, throw {@link BudgetReached} so the spine stops feeding the
  // tokenizer (the verdict carries exactly `maxErrors` violations, and no
  // further work runs this chunk).
  private record(violation: SchemaViolation): void {
    if (this.verdictOnly) {
      // A TEE branch: an invalid result is data the combinator needs, not
      // a parent violation. Flag and keep going (no retention, no throw).
      this.invalid = true;
      return;
    }
    this.violations.push(violation);
    this.onViolation?.(violation);
    if (this.violations.length >= this.maxErrors) throw new BudgetReached();
  }

  private regex(pattern: string): { test(s: string): boolean } {
    let re = this.regexCache.get(pattern);
    if (re === undefined) {
      // Route through the hardening compiler (e.g. RE2) when provided;
      // the spine's regex runs against attacker-controlled input bytes.
      re =
        this.regexCompiler !== undefined ? this.regexCompiler(pattern) : new RegExp(pattern, "u");
      this.regexCache.set(pattern, re);
    }
    return re;
  }

  // Expand a schema into the object schemas whose own keywords apply,
  // following `$ref` and `$dynamicRef`. A `false` sets hasFalse; a `true`
  // contributes nothing.
  //
  // The `seen` cycle guard is allocated lazily, only when a `$ref` is
  // actually followed: a ref-free schema (the hot path) expands without
  // allocating a Set at all.
  private expand(s: SchemaOrBoolean | undefined, out: Applicable, seen?: Set<object>): void {
    if (s === undefined || s === true) return;
    if (s === false) {
      out.hasFalse = true;
      return;
    }
    if (!isObjectSchema(s)) return;
    out.schemas.push(s);
    // `$dynamicRef` is resolved statically against the anchor map, the
    // same limitation @oaverify/internal-schema documents. Refs resolve against the
    // document root (may differ from the validation root in a sub-spine).
    const ref = (s as Record<string, unknown>).$ref ?? (s as Record<string, unknown>).$dynamicRef;
    if (typeof ref !== "string") return;
    let target: SchemaOrBoolean | undefined;
    if (this.refCache.has(ref)) {
      target = this.refCache.get(ref);
    } else {
      target = resolveRef(this.refRoot, ref);
      this.refCache.set(ref, target);
    }
    if (target === undefined) return;
    if (!isObjectSchema(target)) {
      this.expand(target, out, seen); // boolean target
      return;
    }
    if (seen?.has(target)) return; // cycle
    const guard = seen ?? new Set<object>();
    guard.add(target);
    this.expand(target, out, guard);
  }

  // The AND-list of schemas the value about to be parsed must satisfy.
  private schemasForValue(): Applicable {
    const out: Applicable = { schemas: [], hasFalse: false };
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) {
      this.expand(this.root, out);
    } else if (top.kind === "object") {
      for (const s of top.schemas) this.collectObjectValue(s, top.pendingKey as string, out);
    } else {
      // Over-limit is verdict-decided the moment the (max+1)th element
      // starts, before it streams: fail eagerly (`=== count`, so once) so
      // `terminate` aborts the tail instead of echoing the whole over-count
      // body. `minItems` stays at close (you cannot know you are under until
      // the array ends). See {@link onEndArray}.
      for (const s of top.schemas)
        if (s.maxItems !== undefined && top.count === s.maxItems) this.fail("maxItems");
      for (const s of top.schemas) this.collectArrayElement(s, top.count, out);
    }
    return out;
  }

  private collectObjectValue(s: SchemaObject, key: string, out: Applicable): void {
    let matched = false;
    if (s.properties !== undefined && Object.hasOwn(s.properties, key)) {
      this.expand(s.properties[key], out);
      matched = true;
    }
    if (s.patternProperties !== undefined) {
      for (const pat of Object.keys(s.patternProperties)) {
        if (this.regex(pat).test(key)) {
          this.expand(s.patternProperties[pat], out);
          matched = true;
        }
      }
    }
    if (!matched && s.additionalProperties !== undefined) {
      this.expand(s.additionalProperties, out);
    }
  }

  private collectArrayElement(s: SchemaObject, index: number, out: Applicable): void {
    if (s.prefixItems !== undefined && index < s.prefixItems.length) {
      this.expand(s.prefixItems[index], out);
    } else if (s.items !== undefined) {
      this.expand(s.items, out);
    }
  }

  // Whether a single schema must be materialized + delegated (BUFFER): a
  // keyword the spine cannot stream forward. Composition is NOT here (it
  // is handled by TEE unless a branch itself buffers, which the classifier
  // folds into `strategyOf === "buffer"`).
  // The handling a single schema node needs, memoized per node. Computing
  // it touches a dozen `key in schemaObject` checks across objects of
  // varying shape (megamorphic, and the dominant cost in profiling); the
  // same node validates every element of an array, so caching collapses
  // that to one Map lookup per value. The result is stable per node (it
  // depends only on the node's keywords, `strategyOf`, and the fixed
  // `assertsFormat`).
  private nodeKind(s: SchemaObject): "stream" | "tee" | "buffer" {
    let k = this.kindCache.get(s);
    if (k !== undefined) return k;
    k = this.computeKind(s);
    this.kindCache.set(s, k);
    return k;
  }

  private computeKind(s: SchemaObject): "stream" | "tee" | "buffer" {
    // BUFFER: anything the spine cannot stream forward (composition with a
    // non-forward branch folds into strategyOf === "buffer").
    if (this.strategyOf(s) === "buffer") return "buffer";
    if ("contains" in s) return "buffer"; // forward streaming of contains is not implemented
    if ("dependentSchemas" in s || "discriminator" in s) return "buffer";
    if (this.assertsFormat && "format" in s) return "buffer"; // no spine-side format assertion
    if (s.uniqueItems === true) return "buffer"; // canonical hashing not streamed
    const complex = (v: unknown): boolean => typeof v === "object" && v !== null;
    if (Array.isArray(s.enum) && s.enum.some(complex)) return "buffer"; // object/array equality
    if ("const" in s && complex((s as { const?: unknown }).const)) return "buffer";
    // TEE: forward composition.
    for (const k of STREAM_COMPOSITION) if (k in s) return "tee";
    return "stream";
  }

  // BUFFER dominates TEE: if any applicable schema must materialize, the
  // whole value is an island; otherwise forward composition is TEE'd.
  private needsIsland(app: Applicable): boolean {
    return app.schemas.some((s) => this.nodeKind(s) === "buffer");
  }

  private needsTee(app: Applicable): boolean {
    let tee = false;
    for (const s of app.schemas) {
      const k = this.nodeKind(s);
      if (k === "buffer") return false; // island dominates
      if (k === "tee") tee = true;
    }
    return tee;
  }

  // No delegate wired (e.g. a bare spine without a classifier): such a
  // value cannot be validated. Surface it rather than mis-stream.
  private requireDelegate(): IslandDelegate {
    if (this.delegate === undefined) {
      throw new SpineUnsupportedError(
        "schema requires materialization but no in-memory delegate is configured",
      );
    }
    return this.delegate;
  }

  // Validate an already-materialized scalar / string value in-memory.
  private delegateScalar(app: Applicable, value: unknown): void {
    const delegate = this.requireDelegate();
    this.pushSegment();
    if (app.hasFalse) this.fail("false");
    for (const v of delegate(app.schemas, value, [...this.path], this.curOffset)) this.record(v);
    this.popSegment();
    this.advance();
  }

  // Open a BUFFER island for a container value: materialize it from the
  // events, then delegate at its close.
  private beginContainerIsland(app: Applicable): void {
    this.requireDelegate();
    this.pushSegment();
    if (app.hasFalse) this.fail("false");
    // A `uniqueItems` array island's seen-set is O(element count); cap it
    // when `maxUniqueItems` is set so the buffered array cannot grow
    // unbounded on hostile input. Other islands (object `const`, `contains`,
    // ...) are bounded by `maxBufferedBytes` only.
    const uniqueCap =
      this.maxUniqueItems !== undefined && app.schemas.some((s) => s.uniqueItems === true)
        ? this.maxUniqueItems
        : undefined;
    this.island = {
      schemas: app.schemas,
      path: [...this.path],
      builder: new ValueBuilder(),
      byteStart: this.curOffset,
      uniqueCap,
    };
  }

  // Forward an event into the open island, enforcing the buffer caps, and
  // finalize when the island's value is complete.
  private forwardIsland(feed: (b: ValueBuilder) => void): void {
    const island = this.island as NonNullable<typeof this.island>;
    feed(island.builder);
    // The island's source span grows monotonically as it buffers; the last
    // event before close carries its full span, so noting it per event lands
    // the peak without a separate close hook. On the completing event
    // `curOffset` is the closing `}` / `]`, whose own byte is part of the
    // buffered span, so add it (the cap check keeps the pre-close convention).
    const span = this.curOffset - island.byteStart;
    this.notePeakBuffered(island.builder.complete ? span + 1 : span);
    if (this.maxBufferedBytes !== undefined && span > this.maxBufferedBytes) {
      throw new BufferLimitError(this.maxBufferedBytes, this.curOffset);
    }
    // The island's root array grows one entry per top-level element; refuse
    // a `uniqueItems` array past its element cap before the rest buffers.
    if (island.uniqueCap !== undefined) {
      const v = island.builder.value;
      if (Array.isArray(v) && v.length > island.uniqueCap) {
        throw new UniqueItemsLimitError(island.uniqueCap, this.curOffset);
      }
    }
    if (island.builder.complete) this.finalizeIsland();
  }

  private finalizeIsland(): void {
    const island = this.island as NonNullable<typeof this.island>;
    const delegate = this.delegate as IslandDelegate;
    this.island = null;
    for (const v of delegate(island.schemas, island.builder.value, island.path, island.byteStart)) {
      this.record(v);
    }
    this.popSegment();
    this.advance();
    // A container island is always a kept member (container drop is
    // unsupported); record its value-end for a later trailing-drop delete.
    this.noteContainerMemberEnd(this.curOffset);
  }

  // A sub-spine validating the same value against one composition branch.
  // It streams (forward), resolves refs against the document root, and
  // delegates / islands its own non-forward parts; it surfaces nothing
  // (its verdict is read at the TEE's close).
  private makeSub(branch: SchemaOrBoolean): SpineValidator {
    const opts: SpineOptions = {
      strategyOf: this.strategyOf,
      refRoot: this.refRoot,
      assertsFormat: this.assertsFormat,
      verdictOnly: true, // only the branch's boolean verdict is needed
    };
    if (this.delegate !== undefined) opts.delegate = this.delegate;
    if (this.maxBufferedBytes !== undefined) opts.maxBufferedBytes = this.maxBufferedBytes;
    if (this.maxUniqueItems !== undefined) opts.maxUniqueItems = this.maxUniqueItems;
    if (this.maxDepth !== undefined) opts.maxDepth = this.maxDepth;
    if (this.regexCompiler !== undefined) opts.regexCompiler = this.regexCompiler;
    return new SpineValidator(branch, opts);
  }

  // Decompose the applicable schemas into combinator obligations, each
  // backed by a sub-spine. A schema's own (non-composition) keywords are a
  // required obligation alongside its `allOf` members.
  private beginTee(app: Applicable): void {
    const obligations: TeeObligations = {
      required: [],
      anyOf: [],
      oneOf: [],
      not: [],
      ite: [],
      hasFalse: app.hasFalse,
    };
    for (const s of app.schemas) {
      obligations.required.push(this.makeSub(stripComposition(s)));
      if (Array.isArray(s.allOf))
        for (const b of s.allOf) obligations.required.push(this.makeSub(b));
      if (Array.isArray(s.anyOf)) obligations.anyOf.push(s.anyOf.map((b) => this.makeSub(b)));
      if (Array.isArray(s.oneOf)) obligations.oneOf.push(s.oneOf.map((b) => this.makeSub(b)));
      if (s.not !== undefined) obligations.not.push(this.makeSub(s.not));
      if (s.if !== undefined) {
        obligations.ite.push({
          ifSub: this.makeSub(s.if),
          thenSub: s.then === undefined ? null : this.makeSub(s.then),
          elseSub: s.else === undefined ? null : this.makeSub(s.else),
        });
      }
    }
    const subs = [
      ...obligations.required,
      ...obligations.anyOf.flat(),
      ...obligations.oneOf.flat(),
      ...obligations.not,
      ...obligations.ite.flatMap((t) =>
        [t.ifSub, t.thenSub, t.elseSub].filter((x): x is SpineValidator => x !== null),
      ),
    ];
    this.pushSegment();
    this.tee = {
      obligations,
      subs,
      depth: 0,
      inString: false,
      started: false,
      sawContainer: false,
    };
  }

  private teeFeed(feed: (s: SpineValidator) => void): void {
    for (const s of (this.tee as NonNullable<typeof this.tee>).subs) feed(s);
  }

  private teeComplete(): boolean {
    const t = this.tee as NonNullable<typeof this.tee>;
    return t.started && t.depth === 0 && !t.inString;
  }

  private finalizeTee(): void {
    const t = this.tee as NonNullable<typeof this.tee>;
    const o = t.obligations;
    const sawContainer = t.sawContainer;
    // The branches buffered concurrently, so their peak is the sum of the
    // per-branch peaks: a safe upper bound that does not chase exact overlap
    // under nested tees. Each sub-spine ran its own buffering (islands,
    // scalars, nested tees), so this rolls those up recursively.
    let branchSum = 0;
    for (const sub of t.subs) branchSum += sub.peakBuffered();
    this.notePeakBuffered(branchSum);
    this.tee = null;
    if (!combineTee(o)) this.fail("composition");
    this.popSegment();
    this.advance();
    // A container-valued tee'd member is kept; record its value-end. A
    // scalar/string tee'd member already had its end recorded at the scalar
    // finalize, so skip it here to avoid overshooting.
    if (sawContainer) this.noteContainerMemberEnd(this.curOffset);
  }

  // A scalar value at a TEE position: feed the single event to every sub
  // and combine immediately.
  private teeScalar(app: Applicable, feed: (s: SpineValidator) => void): void {
    this.beginTee(app);
    this.teeFeed(feed);
    this.tee!.started = true;
    this.finalizeTee();
  }

  private pushSegment(): void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return; // root value: no segment
    this.path.push(top.kind === "object" ? (top.pendingKey as string) : top.count);
  }

  private popSegment(): void {
    if (this.frames.length > 0) this.path.pop();
  }

  // Record a `depth` violation (once) when a new container would exceed
  // maxDepth. The spine's scope stack is on the heap, so this caps the
  // verdict as a client error rather than guarding a native overflow
  // (that is the in-memory island delegate's `maxDepth`).
  private checkDepth(): void {
    if (this.maxDepth !== undefined && this.frames.length >= this.maxDepth && !this.depthReported) {
      this.fail("depth");
      this.depthReported = true;
    }
  }

  // After a complete value, advance the enclosing scope.
  private advance(): void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) return;
    if (top.kind === "object") top.pendingKey = null;
    else top.count += 1;
  }

  private checkType(schemas: SchemaObject[], actual: JsonType): void {
    for (const s of schemas) {
      if (s.type !== undefined && !typeMatches(s.type, actual)) this.fail("type");
    }
  }

  // const / enum against an object or array value. A complex candidate
  // would have made the schema BUFFER (deep equality), so any const / enum
  // reaching the stream path has only scalar candidates - which a
  // container can never equal.
  private checkContainerEquality(schemas: SchemaObject[]): void {
    for (const s of schemas) {
      if ("const" in s) this.fail("const");
      else if (Array.isArray(s.enum)) this.fail("enum");
    }
  }

  private checkScalar(
    schemas: SchemaObject[],
    actual: JsonType,
    value: string | number | boolean | null,
    codePoints: number,
  ): void {
    for (const s of schemas) {
      if ("enum" in s && Array.isArray(s.enum) && !s.enum.some((e) => e === value))
        this.fail("enum");
      if ("const" in s && (s as { const?: unknown }).const !== value) this.fail("const");
      if (actual === "string") {
        const str = value as string;
        // `maxLength` is enforced eagerly during streaming (see
        // {@link onStringChunk}); only the under-limit closes here.
        if (s.minLength !== undefined && codePoints < s.minLength) this.fail("minLength");
        if (s.pattern !== undefined && !this.regex(s.pattern).test(str)) this.fail("pattern");
      } else if (actual === "number" || actual === "integer") {
        const num = value as number;
        if (s.minimum !== undefined && num < s.minimum) this.fail("minimum");
        if (s.maximum !== undefined && num > s.maximum) this.fail("maximum");
        if (typeof s.exclusiveMinimum === "number" && num <= s.exclusiveMinimum)
          this.fail("exclusiveMinimum");
        if (typeof s.exclusiveMaximum === "number" && num >= s.exclusiveMaximum)
          this.fail("exclusiveMaximum");
        if (s.multipleOf !== undefined && !isMultipleOf(num, s.multipleOf)) this.fail("multipleOf");
      }
    }
  }

  // A scalar value (number / boolean / null, or a finished string).
  private scalar(
    actual: JsonType,
    value: string | number | boolean | null,
    codePoints: number,
    app: Applicable,
  ): void {
    if (this.needsIsland(app)) {
      this.delegateScalar(app, value);
      return;
    }
    this.pushSegment();
    if (app.hasFalse) this.fail("false");
    this.checkType(app.schemas, actual);
    this.checkScalar(app.schemas, actual, value, codePoints);
    this.popSegment();
    this.advance();
  }

  onStartObject(offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onStartObject(offset));
      this.tee.depth += 1;
      this.tee.started = true;
      this.tee.sawContainer = true;
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onStartObject());
      return;
    }
    // A rename of this object-valued member rewrites only its key (the value
    // streams); a drop of a container value is not supported on the stream
    // path. Decided before the value's own classification.
    if (this.memberEditActive) this.decideMember("object", offset);
    const app = this.schemasForValue();
    if (this.needsIsland(app)) {
      this.beginContainerIsland(app);
      this.forwardIsland((b) => b.onStartObject());
      return;
    }
    if (this.needsTee(app)) {
      this.beginTee(app);
      this.teeFeed((s) => s.onStartObject(offset));
      this.tee!.depth = 1;
      this.tee!.started = true;
      this.tee!.sawContainer = true;
      return;
    }
    this.checkDepth();
    this.pushSegment();
    if (app.hasFalse) this.fail("false");
    this.checkType(app.schemas, "object");
    this.checkContainerEquality(app.schemas);
    this.frames.push({
      kind: "object",
      schemas: app.schemas,
      seen: new Set(),
      count: 0,
      pendingKey: null,
      violationsAtOpen: this.violations.length,
      pendingKeyStart: 0,
      pendingKeyEnd: 0,
      outputKeys: this.memberEditActive ? new Map() : null,
      lastKeptValueEnd: offset + 1,
      pendingDrop: null,
    });
  }

  onEndObject(offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onEndObject(offset));
      this.tee.depth -= 1;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onEndObject());
      return;
    }
    const frame = this.frames.pop() as ObjectFrame;
    if (this.memberEditActive && frame.pendingDrop !== null) {
      // A trailing dropped member (last in the object): delete from the last
      // kept value's end through the dropped member, absorbing the preceding
      // comma and leaving valid JSON.
      this.emitDelete!(frame.lastKeptValueEnd, frame.pendingDrop.valueEnd);
      frame.pendingDrop = null;
    }
    for (const s of frame.schemas) {
      if (Array.isArray(s.required)) {
        for (const r of s.required) if (!frame.seen.has(r)) this.fail("required");
      }
      // `maxProperties` is enforced eagerly at the offending key (see
      // {@link onKey}); only the under-limit closes here.
      if (s.minProperties !== undefined && frame.count < s.minProperties)
        this.fail("minProperties");
      const dep = s.dependentRequired;
      if (dep !== undefined) {
        for (const k of Object.keys(dep)) {
          if (frame.seen.has(k)) {
            for (const need of dep[k] as string[])
              if (!frame.seen.has(need)) this.fail("dependentRequired");
          }
        }
      }
      // draft-07 `dependencies`, array form (a property-presence
      // dependency, like dependentRequired). Schema-form entries make the
      // node BUFFER (handled by the island delegate), so only array
      // entries reach here.
      const deps = (s as Record<string, unknown>).dependencies;
      if (deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
        for (const [k, entry] of Object.entries(deps as Record<string, unknown>)) {
          if (Array.isArray(entry) && frame.seen.has(k)) {
            for (const need of entry as string[])
              if (!frame.seen.has(need)) this.fail("dependencies");
          }
        }
      }
    }
    this.onScopeClose?.({
      path: [...this.path],
      kind: "object",
      valid: this.violations.length === frame.violationsAtOpen,
      memberCount: frame.count,
      // Surviving output members: kept + renamed (a drop never enters
      // `outputKeys`). Null when member edits are off, where output == input.
      outputMemberCount: frame.outputKeys !== null ? frame.outputKeys.size : frame.count,
      delimiterOffset: offset,
    });
    this.popSegment();
    this.advance();
    this.noteContainerMemberEnd(offset);
  }

  onStartArray(offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onStartArray(offset));
      this.tee.depth += 1;
      this.tee.started = true;
      this.tee.sawContainer = true;
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onStartArray());
      return;
    }
    // Renaming an array-valued member rewrites only its key; the array
    // streams unbuffered (the headline case). A container drop is unsupported.
    if (this.memberEditActive) this.decideMember("array", offset);
    const app = this.schemasForValue();
    if (this.needsIsland(app)) {
      this.beginContainerIsland(app);
      this.forwardIsland((b) => b.onStartArray());
      return;
    }
    if (this.needsTee(app)) {
      this.beginTee(app);
      this.teeFeed((s) => s.onStartArray(offset));
      this.tee!.depth = 1;
      this.tee!.started = true;
      this.tee!.sawContainer = true;
      return;
    }
    this.checkDepth();
    this.pushSegment();
    if (app.hasFalse) this.fail("false");
    this.checkType(app.schemas, "array");
    this.checkContainerEquality(app.schemas);
    this.frames.push({
      kind: "array",
      schemas: app.schemas,
      count: 0,
      violationsAtOpen: this.violations.length,
    });
  }

  onEndArray(offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onEndArray(offset));
      this.tee.depth -= 1;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onEndArray());
      return;
    }
    const frame = this.frames.pop() as ArrayFrame;
    for (const s of frame.schemas) {
      // `maxItems` is enforced eagerly at the offending element's start
      // (see {@link schemasForValue}); only the under-limit closes here.
      if (s.minItems !== undefined && frame.count < s.minItems) this.fail("minItems");
    }
    this.onScopeClose?.({
      path: [...this.path],
      kind: "array",
      valid: this.violations.length === frame.violationsAtOpen,
      memberCount: frame.count,
      // Array elements are never member-dropped, so output == input.
      outputMemberCount: frame.count,
      delimiterOffset: offset,
    });
    this.popSegment();
    this.advance();
    this.noteContainerMemberEnd(offset);
  }

  onKey(value: string, codePoints: number, startOffset: number, endOffset = startOffset): void {
    this.curOffset = startOffset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onKey(value, codePoints, startOffset));
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onKey(value));
      return;
    }
    this.keyEvent?.(this.path, value, startOffset);
    const top = this.frames[this.frames.length - 1] as ObjectFrame;
    if (this.memberEditActive) {
      // A preceding dropped member ends at this sibling's key: delete it
      // through to here, absorbing the following comma + whitespace.
      if (top.pendingDrop !== null) {
        this.emitDelete!(top.pendingDrop.keyStart, startOffset);
        top.pendingDrop = null;
      }
      top.pendingKeyStart = startOffset;
      top.pendingKeyEnd = endOffset;
      this.pendingDecisionKeyStart = startOffset;
    }
    for (const s of top.schemas) {
      if (s.propertyNames !== undefined) this.checkPropertyName(s.propertyNames, value, codePoints);
      // Over-limit is decided at the (max+1)th key, before its value
      // streams: fail eagerly (`=== count`, so once). `minProperties` stays
      // at close. See {@link onEndObject}.
      if (s.maxProperties !== undefined && top.count === s.maxProperties)
        this.fail("maxProperties");
    }
    top.seen.add(value);
    top.count += 1;
    top.pendingKey = value;
  }

  // Validate a key against a `propertyNames` subschema. With a delegate
  // the key is validated in-memory (sound for any subschema: enum, const,
  // format, composition, $ref, ...). Without one (a bare spine) it falls
  // back to the forward string keywords only.
  private checkPropertyName(propertyNames: SchemaOrBoolean, key: string, codePoints: number): void {
    const app: Applicable = { schemas: [], hasFalse: false };
    this.expand(propertyNames, app);
    const keyPath = [...this.path, key];
    if (app.hasFalse) this.fail("propertyNames", keyPath);
    if (app.schemas.length === 0) return;
    if (this.delegate !== undefined) {
      for (const v of this.delegate(app.schemas, key, keyPath, this.curOffset)) this.record(v);
      return;
    }
    for (const ps of app.schemas) {
      if (ps.type !== undefined && !typeMatches(ps.type, "string"))
        this.fail("propertyNames", keyPath);
      if (ps.minLength !== undefined && codePoints < ps.minLength)
        this.fail("propertyNames", keyPath);
      if (ps.maxLength !== undefined && codePoints > ps.maxLength)
        this.fail("propertyNames", keyPath);
      if (ps.pattern !== undefined && !this.regex(ps.pattern).test(key))
        this.fail("propertyNames", keyPath);
    }
  }

  onStringStart(offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onStringStart(offset));
      this.tee.inString = true;
      this.tee.started = true;
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onStringStart());
      return;
    }
    // Decide the member edit at value start (key known, value type known),
    // before the value's own classification (a tee'd or island string value
    // is still an editable member of a streamed object). Carry the decision
    // to onStringEnd, where the value end finalizes a drop span.
    this.pendingStringDecision = this.memberEditActive ? this.decideMember("string", offset) : null;
    const app = this.schemasForValue();
    if (this.needsTee(app)) {
      this.beginTee(app);
      this.teeFeed((s) => s.onStringStart(offset));
      this.tee!.inString = true;
      this.tee!.started = true;
      this.str = null;
      return;
    }
    const island = this.needsIsland(app);
    // Buffer the text when a forward keyword needs it (pattern / enum /
    // const) or when the value is a BUFFER island (delegated whole).
    const needText =
      island || app.schemas.some((s) => s.pattern !== undefined || "enum" in s || "const" in s);
    // Capture is STREAM-member-only: an island string is delegated whole
    // and does not emit a value event, so never retain it for capture.
    let capture = false;
    if (!island && this.shouldCapture !== undefined) {
      const key = this.memberKey();
      capture = key !== null && this.shouldCapture(this.path, key);
    }
    // The tightest applicable `maxLength` for eager enforcement. An island
    // string is delegated whole, so its length is the delegate's job; only
    // a STREAM string is bounded here.
    let maxLen: number | undefined;
    if (!island) {
      for (const s of app.schemas)
        if (s.maxLength !== undefined)
          maxLen = maxLen === undefined ? s.maxLength : Math.min(maxLen, s.maxLength);
    }
    this.str = {
      app,
      needText,
      text: "",
      offset,
      island,
      capture,
      captureTruncated: false,
      maxLen,
      cp: 0,
      lenFailed: false,
    };
  }

  onStringChunk(chunk: string, offset: number): void {
    this.curOffset = offset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onStringChunk(chunk, offset));
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onStringChunk(chunk));
      return;
    }
    // Eager `maxLength`: count code points as they arrive (for..of yields one
    // per code point, matching the tokenizer's lead-byte count) and fail the
    // moment the cap is first exceeded, before the rest of the string
    // streams. Skipped entirely when no `maxLength` applies. `minLength`
    // necessarily waits for string close (see {@link checkScalar}).
    if (this.str !== null && this.str.maxLen !== undefined && !this.str.lenFailed) {
      for (const _ of chunk) this.str.cp += 1;
      if (this.str.cp > this.str.maxLen) {
        this.fail("maxLength", this.pendingPath());
        this.str.lenFailed = true;
      }
    }
    if (this.str !== null && (this.str.needText || this.str.capture)) {
      const span = offset - this.str.offset;
      if (this.str.needText) {
        this.str.text += chunk;
        // A forced-buffer scalar (pattern / enum / const) accumulates; cap
        // its source-byte span so it can't grow unbounded on hostile input.
        if (this.maxBufferedBytes !== undefined && span > this.maxBufferedBytes) {
          throw new BufferLimitError(this.maxBufferedBytes, offset);
        }
        // The same text serves capture; drop delivery (not the run) past
        // the capture cap.
        if (this.str.capture && this.maxCaptureBytes !== undefined && span > this.maxCaptureBytes) {
          this.str.captureTruncated = true;
        }
      } else if (!this.str.captureTruncated) {
        // Capture-only accumulation: bound retention by the decoded length
        // *before* appending, so a single large chunk (a long string in
        // one input buffer) cannot be retained past the cap. `span` is
        // measured to this chunk's start, so it would pass for a one-shot
        // chunk; the held length is the real memory bound. Decoded UTF-16
        // length <= the source-byte span, so a length over the cap implies
        // the span is too, and onStringEnd's source-span check sets the
        // verdict. Soft limit: drop the held text, never fatal, keep
        // parsing.
        if (
          this.maxCaptureBytes !== undefined &&
          this.str.text.length + chunk.length > this.maxCaptureBytes
        ) {
          this.str.captureTruncated = true;
          this.str.text = "";
        } else {
          this.str.text += chunk;
        }
      }
    }
  }

  onStringEnd(codePoints: number, startOffset: number, endOffset: number): void {
    this.curOffset = endOffset;
    // Finalize a string member's edit at its value end, which is known here
    // regardless of how the value itself classifies (a tee'd or island value
    // still completes via this handler). Runs before the value's own
    // tee/island handling below.
    if (this.pendingStringDecision !== null) {
      this.finalizeScalarMember(this.pendingStringDecision, endOffset);
      this.pendingStringDecision = null;
    }
    if (this.tee !== null) {
      this.teeFeed((s) => s.onStringEnd(codePoints, startOffset, endOffset));
      this.tee.inString = false;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      // Enforce the cap on the full span (a large single-chunk island
      // string never triggered the per-chunk check).
      this.forwardIsland((b) => b.onStringEnd());
      return;
    }
    const s = this.str as NonNullable<typeof this.str>;
    this.str = null;
    // A forced-buffer scalar held its full text (`s.text`); its source span
    // is the buffered-byte cost, known in full only now. (Capture-only
    // retention is bounded by `maxCaptureBytes`, a separate budget, and is
    // not counted here.)
    if (s.needText) this.notePeakBuffered(endOffset - s.offset);
    // Close the single-chunk bypass: cap the forced-buffer scalar on its
    // full source-byte span, known only now.
    if (
      s.needText &&
      this.maxBufferedBytes !== undefined &&
      endOffset - s.offset > this.maxBufferedBytes
    ) {
      throw new BufferLimitError(this.maxBufferedBytes, endOffset);
    }
    // Capture cap on the full span (a single-chunk string skipped the
    // per-chunk check above).
    let captureTruncated = s.captureTruncated;
    if (
      s.capture &&
      this.maxCaptureBytes !== undefined &&
      endOffset - s.offset > this.maxCaptureBytes
    ) {
      captureTruncated = true;
    }
    this.curOffset = s.offset;
    if (s.island) {
      // A scalar string routed to a BUFFER island (e.g. `format` under an
      // asserting dialect) is still a scalar member with a known span, and
      // its text is already materialized for the delegate. Report it like
      // any other scalar member, so the channel is uniform across STREAM
      // and buffer-delegated scalars. The match is decided at completion
      // (the text is in hand, not gated at string start); the cap is a
      // delivery gate, the bytes already bounded by `maxBufferedBytes`.
      if (this.valueEvent !== undefined) {
        const truncated =
          this.maxCaptureBytes !== undefined && endOffset - s.offset > this.maxCaptureBytes;
        this.emitScalarMember(s.offset, endOffset, "string", s.text, truncated);
      }
      this.delegateScalar(s.app, s.text);
      return;
    }
    // STREAM string member: report the span (opening quote .. past closing
    // quote, so a slice is valid JSON); deliver the decoded text only when
    // captured and within the cap. The match was decided at string start
    // (to gate text retention), so reuse it rather than re-run the filter.
    if (this.valueEvent !== undefined)
      this.emitScalarMember(s.offset, endOffset, "string", s.text, captureTruncated, s.capture);
    this.scalar("string", s.needText ? s.text : "", codePoints, s.app);
  }

  onNumber(value: number, raw: string, startOffset: number, endOffset: number): void {
    this.curOffset = startOffset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onNumber(value, raw, startOffset, endOffset));
      this.tee.started = true;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onNumber(value));
      return;
    }
    if (this.memberEditActive)
      this.finalizeScalarMember(this.decideMember("number", startOffset), endOffset);
    const app = this.schemasForValue();
    const type = Number.isInteger(value) ? "integer" : "number";
    if (this.needsTee(app)) {
      this.teeScalar(app, (s) => s.onNumber(value, raw, startOffset, endOffset));
      return;
    }
    if (this.valueEvent !== undefined)
      this.emitScalarMember(startOffset, endOffset, "number", value, false);
    this.scalar(type, value, 0, app);
  }

  onBoolean(value: boolean, startOffset: number, endOffset: number): void {
    this.curOffset = startOffset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onBoolean(value, startOffset, endOffset));
      this.tee.started = true;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onBoolean(value));
      return;
    }
    if (this.memberEditActive)
      this.finalizeScalarMember(this.decideMember("boolean", startOffset), endOffset);
    const app = this.schemasForValue();
    if (this.needsTee(app)) {
      this.teeScalar(app, (s) => s.onBoolean(value, startOffset, endOffset));
      return;
    }
    if (this.valueEvent !== undefined)
      this.emitScalarMember(startOffset, endOffset, "boolean", value, false);
    this.scalar("boolean", value, 0, app);
  }

  onNull(startOffset: number, endOffset: number): void {
    this.curOffset = startOffset;
    if (this.tee !== null) {
      this.teeFeed((s) => s.onNull(startOffset, endOffset));
      this.tee.started = true;
      if (this.teeComplete()) this.finalizeTee();
      return;
    }
    if (this.island !== null) {
      this.forwardIsland((b) => b.onNull());
      return;
    }
    if (this.memberEditActive)
      this.finalizeScalarMember(this.decideMember("null", startOffset), endOffset);
    const app = this.schemasForValue();
    if (this.needsTee(app)) {
      this.teeScalar(app, (s) => s.onNull(startOffset, endOffset));
      return;
    }
    if (this.valueEvent !== undefined)
      this.emitScalarMember(startOffset, endOffset, "null", null, false);
    this.scalar("null", null, 0, app);
  }
}

// A shallow copy of a schema with its composition keywords removed: the
// schema's own (non-composition) obligation for a TEE.
function stripComposition(s: SchemaObject): SchemaObject {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "allOf" || k === "anyOf" || k === "oneOf" || k === "not" || k === "if") continue;
    if (k === "then" || k === "else") continue; // partners of `if`
    out[k] = v;
  }
  return out as SchemaObject;
}

// Combine TEE sub-spine verdicts per the composition combinators.
function combineTee(o: TeeObligations): boolean {
  if (o.hasFalse) return false;
  for (const s of o.required) if (!s.verdict().valid) return false;
  // An empty anyOf / oneOf is vacuously valid (matches @oaverify/internal-schema, which
  // emits no check for an empty composition array).
  for (const group of o.anyOf) {
    if (group.length > 0 && !group.some((s) => s.verdict().valid)) return false;
  }
  for (const group of o.oneOf) {
    if (group.length > 0 && group.filter((s) => s.verdict().valid).length !== 1) return false;
  }
  for (const s of o.not) if (s.verdict().valid) return false;
  for (const t of o.ite) {
    const ifValid = t.ifSub.verdict().valid;
    if (ifValid && t.thenSub !== null && !t.thenSub.verdict().valid) return false;
    if (!ifValid && t.elseSub !== null && !t.elseSub.verdict().valid) return false;
  }
  return true;
}

// Mirror @oaverify/internal-schema's tolerant multipleOf check so verdicts agree on
// floating-point divisors (see packages/schema/src/keywords/number.ts).
function isMultipleOf(value: number, divisor: number): boolean {
  const q = value / divisor;
  const tol = 16 * Number.EPSILON * Math.max(1, Math.abs(q), Math.abs(divisor));
  return Math.abs(q - Math.round(q)) <= tol;
}
