/**
 * Which part of a node a finding wants pointed at, per code.
 *
 * A span request takes `want: "key" | "value"` and defaults to the
 * value. That default is right for most codes and wrong for the ones
 * whose subject *is* the name: `unused-component` on a 25-line schema
 * addresses the whole body when the reader wants the component's name,
 * and an editor squiggles 25 lines.
 *
 * Three things are deliberately kept apart here, because collapsing
 * them is what makes this look simpler than it is:
 *
 * - **The span primitive** ({@link @oaverify/core/spec!SpanRequest}) means
 *   exactly what it says. `want: "key"` against an array element or the
 *   document root has no answer and resolves to `undefined`. That stays
 *   true; nothing in this file changes it.
 * - **The recommendation** is this table: for this code, which part
 *   usually reads better.
 * - **Applying one** is best-effort, and that is why
 *   {@link spanFor} falls back.
 *
 * The invariant that follows, and the reason the fallback exists:
 * **a recommendation may narrow a span, and must never be the reason a
 * finding loses one.** `unused-tag` addresses `/tags/3`, an array
 * element with no key; a code marked `"key"` that lands somewhere
 * without one has to come back with the value rather than with nothing,
 * or the finding silently drops to addressing its file.
 *
 * Keyed by code rather than carried on each finding, because no code's
 * answer varies by instance. `FindingAnchor` is a different axis and
 * cannot stand in for this one: `unknown-keyword` is `"node"` or
 * `"definition"` depending on how it was reached, and wants the keyword
 * key either way. If a rule ever does need to vary per instance, a
 * `target` field can override this later without changing what the
 * table means.
 *
 * ## Positions inside a rejected value
 *
 * The second half of this file answers a different question with the
 * same kind of table. A finding carrying `reasons` was rejected in
 * several places at once, and each reason names its own position with a
 * path *within the rejected value* (#773). {@link locatedReasonsFor}
 * turns those into source spans so a consumer can point at each one
 * rather than read them out of a joined sentence.
 *
 * Two facts make that arithmetic rather than a second resolution pass,
 * and both are worth knowing before changing it:
 *
 * - An example value is data, and the resolver does not follow a `$ref`
 *   inside one. The value in the resolved document and the value in the
 *   file are the same bytes, so a path that addresses one addresses the
 *   other and `source.pointer` plus the path is the source position.
 * - A path that fails to resolve therefore does not mean the file moved
 *   underneath us. It means the path names something the value does not
 *   contain, which is a property of the reason's code and is what
 *   {@link reasonTargetFor} exists to state.
 *
 * @packageDocumentation
 */

import type { PathSegment, RejectionReason } from "@oaverify/internal-core";
import type { SourceSpan, SpanRequest, SpanTarget } from "@oaverify/internal-spec";
import type { CheckFinding } from "./finding.js";

/**
 * Codes whose subject is the name rather than what it holds.
 *
 * Every entry must be able to resolve a key, which is a property of the
 * pointers the code emits rather than of the code's meaning:
 * `unreachable-defs` qualifies because its pointer always ends at a
 * named `$defs` entry, even though the walk that finds it descends
 * through arrays. `span-target.test.ts` asserts that for each entry
 * against a fixture, because the failure is silent.
 */
const KEY_CODES: ReadonlySet<string> = new Set([
  "unused-component",
  "unreachable-defs",
  "path-template-malformed",
  "unknown-keyword",
]);

/**
 * Which part of its node a code reads better pointed at.
 *
 * `"value"` for anything not listed, including a code this build has
 * never heard of, so a consumer pinned to an older version degrades to
 * the behaviour it already had.
 *
 * @public
 */
export function spanTargetFor(code: string): SpanTarget {
  return KEY_CODES.has(code) ? "key" : "value";
}

/**
 * Separator for the dedupe key below. An escape rather than the byte
 * itself: a literal control character makes the source a binary blob
 * to git and to anything that copies the text, and neither a URI nor a
 * pointer can contain one, so no two distinct requests collide.
 */
const SEP = "\u0000";

/**
 * Every span request a caller must resolve to place these findings.
 *
 * Pass the result to a {@link @oaverify/core/spec!SourceSpanResolver} in
 * one batch, and hand the answers back as the `spanOf` option to
 * {@link renderSarif}. Building the batch and reading it are the same
 * policy, so they live in one place: a caller that assembled the batch
 * itself would have to reproduce the fallback rule below, and would
 * drift from it.
 *
 * Two requests are emitted for a finding whose code recommends a key:
 * the key and the value, because the fallback needs both resolved
 * before it can choose. That costs a lookup and no extra parse, since a
 * resolver groups a batch by document and parses each once.
 *
 * Hops are requested as values. A hop addresses the `$ref` node that
 * pulled a document in, so a recommendation about the finding's own
 * code has nothing to say about it.
 *
 * @public
 */
export function spanRequestsFor(findings: readonly CheckFinding[]): SpanRequest[] {
  const seen = new Set<string>();
  const requests: SpanRequest[] = [];
  const add = (uri: string, pointer: string, want: SpanTarget): void => {
    const key = `${uri}${SEP}${pointer}${SEP}${want}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ uri, pointer, want });
  };
  for (const finding of findings) {
    const source = finding.target?.source;
    if (source === undefined) continue;
    const want = spanTargetFor(finding.code);
    add(source.uri, source.pointer, want);
    if (want !== "value") add(source.uri, source.pointer, "value");
    for (const hop of source.via) add(hop.uri, hop.pointer, "value");
    // One request per reason that asks for a position, at the position
    // its code names. One, not a pair: there is no fallback to resolve
    // against, per the invariant on `reasonTargetFor`.
    for (const reason of finding.reasons ?? []) {
      const path = locatedPathOf(reason);
      if (path === undefined) continue;
      add(source.uri, pointerFor(source.pointer, path), "value");
    }
  }
  return requests;
}

/**
 * Where a reason's ruling applies, relative to the reason's own `path`.
 *
 * @public
 */
export type ReasonTarget =
  /** The path itself. The value it names is the value that was rejected. */
  | "self"
  /**
   * The parent of the path. The path's final segment names a member the
   * value does not contain, so nothing addresses it.
   */
  | "container";

/**
 * Codes whose `path` ends at a member that is absent by construction.
 *
 * The entry criterion, and the only one: a code belongs here when the
 * final segment of its `path` names a value the instance **does not
 * hold**, so no node in the document corresponds to it and the ruling is
 * about the container. `required` qualifies, and its `params.missing`
 * carries the same name the segment does. `dependentRequired` would
 * qualify on the same grounds. `type` does not: the value is there and
 * is the wrong shape.
 *
 * This is a statement about what a code means, not a repair for paths
 * that failed to resolve. A code left out of this table and pointed at a
 * position the file does not contain comes back with no span, and
 * {@link locatedReasonsFor} drops it. Walking up from a failed lookup
 * would turn a wrong entry here into a plausible location instead of a
 * missing one, which is the outcome this table exists to avoid.
 *
 * Measured against the three real-world specs in `conformance/`: 283 of
 * 283 `required` reasons resolve at the container and none at the path,
 * and all 423 reasons of every other code resolve at the path.
 * `span-target.test.ts` pins both halves.
 */
const CONTAINER_CODES: ReadonlySet<string> = new Set(["required", "dependentRequired"]);

/**
 * Where a reason's ruling applies, given the keyword that made it.
 *
 * `"self"` for anything not listed, including a code this build has
 * never heard of, which is the same degradation {@link spanTargetFor}
 * offers: an unknown code is located at the position it names, and is
 * dropped rather than guessed at if that position does not exist.
 *
 * @public
 */
export function reasonTargetFor(code: string): ReasonTarget {
  return CONTAINER_CODES.has(code) ? "container" : "self";
}

/**
 * The path a reason is located at, or `undefined` where it has no
 * position of its own.
 *
 * Nothing for an empty path, and for a one-segment path whose code is
 * `"container"`: both name the rejected value as a whole, which the
 * finding's own location already addresses. A related location there
 * repeats the primary one and restates the finding's message.
 *
 * The parent is taken from the segments before any of them is escaped,
 * so a property name containing `/` or `~` cannot be split by it.
 */
function locatedPathOf(reason: RejectionReason): readonly PathSegment[] | undefined {
  if (reason.path.length === 0) return undefined;
  if (reasonTargetFor(reason.code) === "self") return reason.path;
  return reason.path.length === 1 ? undefined : reason.path.slice(0, -1);
}

/** A path within a value, appended to the pointer that value sits at. */
function pointerFor(pointer: string, path: readonly PathSegment[]): string {
  let out = pointer;
  for (const segment of path) {
    out += `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`;
  }
  return out;
}

/**
 * One reason of a finding, and the source position it was located at.
 *
 * Self-contained on purpose: `uri`, `pointer` and `span` together are
 * everything an editor or a SARIF location needs, so a consumer never
 * re-derives the address from the reason and the finding. `index` is the
 * reason's position in {@link CheckFinding.reasons}, which is how a
 * consumer joins a located item back to the uncapped structured cause it
 * came from.
 *
 * @public
 */
export interface LocatedReason {
  /** The reason itself, unchanged, `path` included. */
  reason: RejectionReason;
  /** Its index in the finding's `reasons`. */
  index: number;
  /** Whether `pointer` is the reason's path or its container. */
  at: ReasonTarget;
  /** The document, the same one the finding's own location addresses. */
  uri: string;
  /** RFC 6901 pointer to the located node, within that document. */
  pointer: string;
  /** Where that node is in the text. Never absent; see the note below. */
  span: SourceSpan;
}

/**
 * Every reason of a finding that could be located, in `reasons` order.
 *
 * A reason appears when three things hold, and is absent otherwise:
 *
 * 1. the finding has a `target.source`, so there is a document to
 *    address at all;
 * 2. it names a position of its own, per {@link locatedPathOf}; and
 * 3. a span resolves at the position its code names.
 *
 * Absence is therefore never a guess and never a repeat. A caller that
 * wired no `spanOf`, or one whose document has no span backend, gets an
 * empty list rather than a list of file-level items that say only
 * "somewhere in the file the finding already names". That follows the
 * rule the SARIF emitter states for regions: no position is better than
 * a position that is not the one meant.
 *
 * Reasons themselves are uncapped, and so is this. See
 * {@link ExampleIssue.reasons} for why the cause list is not truncated,
 * and `sarif.ts` for why the located items are not either.
 *
 * @param finding - The finding to locate the reasons of.
 * @param spanOf - A lookup over {@link spanRequestsFor}'s requests.
 *
 * @public
 */
export function locatedReasonsFor(
  finding: CheckFinding,
  spanOf: (of: SpanRequest) => SourceSpan | undefined,
): LocatedReason[] {
  const source = finding.target?.source;
  if (source === undefined) return [];
  const located: LocatedReason[] = [];
  (finding.reasons ?? []).forEach((reason, index) => {
    const path = locatedPathOf(reason);
    if (path === undefined) return;
    const pointer = pointerFor(source.pointer, path);
    const span = spanOf({ uri: source.uri, pointer, want: "value" });
    if (span === undefined) return;
    located.push({
      reason,
      index,
      at: reasonTargetFor(reason.code),
      uri: source.uri,
      pointer,
      span,
    });
  });
  return located;
}

/**
 * The span to place a finding's own location at, given a lookup over
 * {@link spanRequestsFor}'s requests.
 *
 * Applies the code's recommendation and falls back to the value where
 * it has no answer, which is the invariant this module exists to hold.
 * `undefined` here means the address itself has no span: no text was
 * supplied for that document, or no backend claimed its syntax.
 *
 * @public
 */
export function spanFor(
  finding: CheckFinding,
  spanOf: (of: SpanRequest) => SourceSpan | undefined,
): SourceSpan | undefined {
  const source = finding.target?.source;
  if (source === undefined) return undefined;
  const want = spanTargetFor(finding.code);
  if (want === "value") return spanOf({ uri: source.uri, pointer: source.pointer, want });
  return (
    spanOf({ uri: source.uri, pointer: source.pointer, want }) ??
    spanOf({ uri: source.uri, pointer: source.pointer, want: "value" })
  );
}
