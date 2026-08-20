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
 * A reason's address is **resolved, never derived**, and that is the
 * thing to know before changing any of this.
 *
 * Deriving one looks safe and is not. The reasoning that tempts you:
 * an example value is data the resolver does not follow a `$ref` into,
 * so the value in the resolved document and the value in the file are
 * the same bytes, so `source.pointer` plus the path is the source
 * position. The first two clauses hold and the conclusion does not. An
 * overlay rewrites nodes *after* resolution, and `withOverlayChanges`
 * holes what it changed while a container keeps its own address, so
 * appending a path to that address walks straight past the hole and
 * lands on bytes the overlay removed (#776).
 *
 * So {@link reasonPointersFor} builds the pointer in the resolved
 * document, `checkSpec` maps it through `sourceOf` exactly as it maps
 * the finding's own pointer, and what reaches this file is an address
 * and not a recipe for one. A reason with no address is a reason with
 * no located item.
 *
 * The other half holds either way: a path that resolves to nothing is
 * not the file moving underneath us. It is either a node an overlay
 * rewrote, or a path naming something the value does not contain, which
 * is a property of the reason's code and is what
 * {@link reasonTargetFor} exists to state.
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
 * {@link renderSarif}, to {@link spanFor}, or to
 * {@link locatedReasonsFor}. Building the batch and reading it are the
 * same policy, so they live in one place: a caller that assembled the
 * batch itself would have to reproduce the rules below, and would drift
 * from them.
 *
 * **This is the whole batch, and each reader takes its part of it.**
 * Resolving a smaller one leaves the reader that wanted the missing
 * request unable to tell "no position for this" from "you did not ask",
 * and both of them answer by omitting something. Three kinds are
 * emitted:
 *
 * - **The finding's own address**, read back by {@link spanFor}. Two
 *   requests for a code that recommends a key, the key and the value,
 *   because the fallback needs both resolved before it can choose.
 * - **Each hop**, as a value. A hop addresses the `$ref` node that
 *   pulled a document in, so a recommendation about the finding's own
 *   code has nothing to say about it.
 * - **Each reason that has an address**, read back by
 *   {@link locatedReasonsFor}, at the address `checkSpec` resolved for
 *   it and recorded in {@link CheckFinding.reasonSources}. One request
 *   rather than a pair: there is no fallback, so nothing needs a second
 *   answer. A reason whose node an overlay rewrote has no address and
 *   so gets no request (#776).
 *
 * A request emitted here may still resolve to nothing, and for a reason
 * that is an ordinary outcome rather than a failure; see
 * {@link locatedReasonsFor}.
 *
 * The extra requests cost lookups and no extra parse, since a resolver
 * groups a batch by document and parses each once.
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
    // One request per reason that has an address, at that address. One,
    // not a pair: there is no fallback to resolve against, per the
    // invariant on `reasonTargetFor`.
    //
    // From `reasonSources` rather than from arithmetic on
    // `source.pointer`: a reason whose node an overlay rewrote has no
    // address, and asking for a span at a derived pointer is what put a
    // region over stale bytes (#776).
    for (const { source: at } of finding.reasonSources ?? []) {
      add(at.uri, at.pointer, "value");
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
 * carries the same name the segment does. `dependentRequired` and
 * `dependencies` qualify on the same grounds, and `dependencies` is
 * here because it behaves identically rather than by analogy: against
 * `{credit_card: "4111"}` under `dependencies: {credit_card:
 * ["billing_address"]}` it emits code `dependencies`, path
 * `["billing_address"]` and `params.missing` `"billing_address"`, which
 * is the same triple `required` emits. It is the 3.0 spelling of the
 * keyword and reachable under 3.1 too, both dialects carrying it in
 * `applicatorVocabulary`. `type` does not qualify: the value is there
 * and is the wrong shape.
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
const CONTAINER_CODES: ReadonlySet<string> = new Set([
  "required",
  "dependentRequired",
  "dependencies",
]);

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
 * Where each reason of a finding sits in the **resolved** document.
 *
 * The input to source attribution rather than its output: a caller maps
 * these through `sourceOf` to get the address in the file, exactly as
 * `checkSpec` already does for the finding's own pointer. Reasons with
 * no position of their own are absent, so the result is sparse and its
 * `index` is the reason's index in {@link CheckFinding.reasons}.
 *
 * Exported within the package so the pointer arithmetic lives in one
 * place, and kept out of {@link locatedReasonsFor}: doing it there means
 * doing it against `target.source`, which assumes a path means the same
 * thing in the resolved document and in the file. An overlay breaks that
 * assumption (#776), so an address is resolved the same way every other
 * address is, never derived.
 *
 * Deliberately not on the package's public surface. Its output is only
 * useful to something holding the spec's regions, which is `checkSpec`
 * and nothing outside; a consumer wanting located reasons wants
 * {@link locatedReasonsFor}, which takes addresses already resolved.
 * Exporting it later is additive.
 */
export function reasonPointersFor(finding: CheckFinding): { index: number; pointer: string }[] {
  const target = finding.target;
  if (target === undefined) return [];
  const out: { index: number; pointer: string }[] = [];
  (finding.reasons ?? []).forEach((reason, index) => {
    const path = locatedPathOf(reason);
    if (path === undefined) return;
    out.push({ index, pointer: pointerFor(target.pointer, path) });
  });
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
  /**
   * The path `pointer` addresses, within the rejected value. The
   * reason's own path where `at` is `"self"`, and one segment shorter
   * where it is `"container"`.
   *
   * Carried rather than left to the reader to derive, so nothing outside
   * this module has to know that `"container"` means exactly one segment
   * or that a one-segment container never reaches here. A renderer that
   * recomputed it would silently produce an empty path the day either
   * rule changed.
   */
  path: readonly PathSegment[];
  /**
   * The document the reason's own node came from.
   *
   * Equal to the finding's own `target.source.uri` in every case seen
   * so far, and incidentally rather than structurally: it holds because
   * the resolver does not follow a `$ref` inside example data, so no
   * region boundary falls between an example node and a node inside it.
   * Read this rather than the finding's, since the two are resolved
   * independently and a class whose sub-positions can cross a document
   * would separate them.
   */
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
 * 1. the finding has a `target.source`, so the result it supports has
 *    an address of its own;
 * 2. it has an entry in {@link CheckFinding.reasonSources}, so a source
 *    node corresponds to the position its code names, and it names a
 *    position at all per {@link locatedPathOf}; and
 * 3. a span resolves at that address.
 *
 * The second is what makes this safe under an overlay. The address is
 * resolved by `checkSpec` through `sourceOf`, the same way the
 * finding's own is, rather than derived here by appending the reason's
 * path to `target.source.pointer`. Deriving assumed a path means the
 * same thing in the resolved document and in the file, which an overlay
 * that rewrote the node makes false (#776).
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
  // A related location supports a result. A result carrying none of its
  // own while pointing related ones into a file is incoherent, so the
  // finding having an address is a precondition here, independently of
  // each reason resolving its own.
  if (finding.target?.source === undefined) return [];
  const reasons = finding.reasons ?? [];
  const located: LocatedReason[] = [];
  for (const { index, source } of finding.reasonSources ?? []) {
    const reason = reasons[index];
    if (reason === undefined) continue;
    const path = locatedPathOf(reason);
    if (path === undefined) continue;
    const span = spanOf({ uri: source.uri, pointer: source.pointer, want: "value" });
    if (span === undefined) continue;
    located.push({
      reason,
      index,
      at: reasonTargetFor(reason.code),
      uri: source.uri,
      pointer: source.pointer,
      path,
      span,
    });
  }
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
