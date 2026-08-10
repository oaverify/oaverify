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
 * @packageDocumentation
 */

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
  }
  return requests;
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
