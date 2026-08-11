/**
 * What `check` reports, and the vocabulary a consumer re-splits it by.
 *
 * The finding contract is the reason this package exists. Every pass
 * produces its own issue shape; `checkSpec` normalises them into one
 * array so a caller reads one type rather than six, and `class` is what
 * lets them be taken apart again.
 *
 * @packageDocumentation
 */

import type { RejectionReason } from "@oaverify/internal-core";
import type { SourceAddress } from "@oaverify/internal-spec";
import type { CheckCode } from "./codes.js";

/**
 * A single finding from a `check` run, normalised across the classes so
 * one array can carry all of them.
 *
 * One array rather than a union of per-pass shapes, because the classes
 * run together by construction: a caller asking "what is wrong with this
 * document" wants one answer, not six to reassemble. `class` is required
 * so the array can be taken apart again by a consumer who does want one
 * layer at a time.
 *
 * @public
 */
export interface CheckFinding {
  /**
   * Which check produced this, matching the three-class model in
   * docs/strictness.md.
   *
   * Not the same set as {@link CHECK_CLASSES}, which is what `--only`
   * selects. A malformed schema is found by compiling, which is what the
   * `schema` class does, so it cannot be requested on its own; it is
   * reported under its own class because it is a different kind of
   * problem with a different remedy, and a consumer re-splitting the
   * array should not have to match on `code` to find it.
   */
  class: "hygiene" | "schema" | "malformed" | "conformance" | "examples" | "redos";
  /**
   * What this means for you, independent of which check found it.
   *
   * Separate from `class` on purpose. Class says which pass produced a
   * finding; severity says whether it breaks anything. Conflating them
   * is what made `--fail-on` useless: `path-param-undeclared` violates
   * the OpenAPI spec and `unused-tag` is housekeeping, but both are
   * `hygiene`, so gating on the class meant gating on both or neither.
   *
   * - `"fatal"`: act before shipping anything else. The `malformed`
   *   class owns this today, because a document that cannot be compiled
   *   is the one thing that stops everything.
   * - `"error"`: legal to parse, but violates the OpenAPI specification.
   * - `"warning"`: legal, and probably not what the author meant.
   *
   * A regrading moves this rank and nothing else. The CLI's exit code 4
   * tracks the `malformed` class rather than `"fatal"`, so promoting a
   * finding to `"fatal"` never claims the document failed to compile.
   */
  severity: CheckSeverity;
  /**
   * The class-specific code, e.g. `"unused-component"`,
   * `"unknown-keyword"`.
   *
   * Typed as the known set widened by `string`, which is deliberate and
   * is not the same as `string`. The intersection makes every code in
   * {@link CheckCode} autocomplete and keeps an unknown one assignable,
   * so adding a code is not a breaking change.
   *
   * A closed union would break every exhaustive `switch` each time a
   * code is added, and codes are added often: three arrived in the week
   * before this package existed. A bare `string` would throw away the
   * registry #641 built. This keeps both.
   *
   * The consequence to know about: a `switch` over this cannot be
   * exhaustive, so write a `default`. That is the honest shape, because
   * a consumer pinned at one version will meet codes from a later one.
   */
  code: CheckCode | (string & {});
  /**
   * Where it is, for a human. Display text, and the format varies by
   * class: a pointer for the classes that address the document, an
   * operation label plus a path within the schema for the classes that
   * do not.
   *
   * **Never parse this.** It carries no stable grammar and is free to
   * change wording. {@link CheckFinding.target} is the machine address
   * and is the field to switch on, key off, or map to a source line.
   *
   * Unchanged since before `target` existed, deliberately: the point of
   * adding a machine contract was to stop a consumer needing this one,
   * not to alter what a reader sees.
   */
  location: string;
  message: string;
  /**
   * How many operations reported this same defect, when more than one.
   * Absent for a single occurrence.
   *
   * Schemas compile per operation, so a component reached from several
   * of them is checked several times and produces one finding each. They
   * are one defect and one edit. `location` names the first operation
   * that reached it; the rest are collapsed into this count rather than
   * printed again.
   */
  occurrences?: number;
  /**
   * Structured cause data: every leaf the underlying check rejected the
   * value on. The machine half of `message`, so a consumer never
   * recovers `allowed` / `actual` by parsing prose (#580).
   *
   * Populated by the `examples` class only. Absent on every other
   * class, which means "this class does not produce leaf-level causes",
   * not "this finding had none". The field is class-agnostic by
   * construction, so `conformance` (whose issues are validation
   * failures of the same shape) can adopt it later without a rename.
   *
   * Uncapped, and so longer than `message` where `message` truncated.
   * See {@link ExampleIssue.reasons}.
   */
  reasons?: readonly RejectionReason[];
  /**
   * Where each located reason came from in the files that were read.
   *
   * Sparse and index-keyed rather than parallel to `reasons`: a reason
   * appears only when it names a position of its own **and** a source
   * node corresponds to that position. `index` is its index in
   * `reasons`, which is how a consumer joins the two.
   *
   * Absence carries the same meaning it does on
   * {@link FindingTarget.source}, one level down. A reason missing here
   * is a reason whose position no source node corresponds to, which
   * under an overlay means the node it names was rewritten after
   * resolution and its position in the file would be stale. Deriving
   * the address instead, by appending the reason's path to
   * `target.source.pointer`, is what produced a confident region over
   * bytes the overlay had removed (#776).
   *
   * Populated by the `examples` class, and only when the spec carried
   * regions. Absent entirely otherwise, exactly as `target.source` is.
   *
   * ## On the wire, deliberately
   *
   * `check --format json` serializes findings verbatim, so this travels
   * with them: about 20% of that report on `twilio.json`, 7% on
   * `github.json`. Kept rather than trimmed, for two reasons.
   *
   * It is not recoverable. A consumer cannot rebuild these addresses by
   * appending a reason's path to `target.source.pointer`, because doing
   * exactly that is the defect #776 fixed. Withholding them would leave
   * a JSON consumer with the choice between no positions and the wrong
   * ones.
   *
   * And the obvious trim is a trap. Every entry's `uri` and `via`
   * currently equal the finding's, so storing a bare pointer looks
   * free. That equality holds only because the resolver does not follow
   * a `$ref` inside example data, which is a fact about today's one
   * producing class rather than about the field: `reasons` is
   * class-agnostic by construction, and a class whose sub-positions can
   * cross a document would break it silently. Assuming structure about
   * a position is the shape of the bug this field exists to fix, so it
   * is not repeated one level down to save bytes.
   *
   * SARIF is unaffected: `renderSarif` reads this to place related
   * locations and does not emit the field.
   */
  reasonSources?: readonly ReasonSource[];
  /**
   * Where this finding is, for a machine. The counterpart to
   * `location`, which stays prose.
   *
   * Absent means **no pointer into the resolved document resolves to
   * this finding**, which is a fact about the finding rather than an
   * omission, and never an instruction to parse `location` instead.
   * External `$ref` targets and anchors name a schema and no position
   * in this document; a hand-built route has no addressable operation.
   * A synthesized pointer that resolves nowhere, or worse resolves
   * somewhere wrong, is the failure this field exists to prevent.
   *
   * Populated per class:
   * - `hygiene`, `conformance`, `examples`, `redos`: always, anchored
   *   at the offending node.
   * - `schema`: whenever the compile knew where its schema sat in the
   *   document, which is every schema `check` compiles.
   * - `malformed`: the schema that would not compile, addressed as the
   *   successful path would have addressed it. Where the failure is
   *   operation-wide rather than owned by one schema (an unresolvable
   *   `$ref` that aborts the build), the pointer names the operation
   *   instead, which is the smallest unit that failed. Absent for a
   *   security compile, which has no document position of its own.
   *
   * One finding can stand for several occurrences of the same defect
   * (see `occurrences`), and `target` then addresses the first one
   * reached, exactly as `location` does. It locates the defect; it does
   * not enumerate every site affected.
   */
  target?: FindingTarget;
}

/**
 * What a {@link CheckFinding.target} pointer means for the reader who
 * follows it.
 *
 * Derived from what the analysis actually did rather than declared per
 * rule, with one exception noted on `scoped-definition`.
 *
 * @public
 */
export type FindingAnchor =
  /**
   * The pointer is the finding's own address, reached without crossing
   * a `$ref`, so editing there affects nothing else. Usually the
   * offending node; for an operation-wide build failure it is the
   * operation, which is the smallest unit that failed.
   */
  | "node"
  /**
   * A `$ref` was crossed, and the pointer names the shared definition
   * the text is written in. Editing there affects every use site, and
   * `location` may name an operation this pointer does not address.
   */
  | "definition"
  /**
   * A `$ref` was crossed, the pointer names the shared definition, and
   * the finding is **scoped to the route** named by `location`. The
   * text at the pointer may be correct for the definition's other
   * users.
   *
   * The one anchor that is not a property of the walk alone: it also
   * depends on whether a rule's verdict varies by the route taken to
   * reach a node. Today that is `silent-rewrite/required-not-in-properties`
   * alone, which asks which property names are reachable at an
   * *instance* position, and a component says different things at
   * different use sites.
   */
  | "scoped-definition";

/**
 * One reason's address in the files that were read.
 *
 * See {@link CheckFinding.reasonSources}, which explains why this is
 * sparse and why absence is a fact about the node rather than an
 * omission.
 *
 * @public
 */
export interface ReasonSource {
  /** The reason's index in {@link CheckFinding.reasons}. */
  index: number;
  /** Where the node that reason addresses came from. */
  source: SourceAddress;
}

/**
 * A finding's machine-readable address.
 *
 * One object rather than two optional fields, because the two are
 * coupled in both directions: an anchor is meaningless without a
 * pointer, and a pointer is ambiguous without an anchor. Splitting
 * them would admit two states that should be unrepresentable.
 *
 * @public
 */
export interface FindingTarget {
  /**
   * RFC 6901 pointer into the resolved document, percent-decoded with
   * `~0` / `~1` retained. Guaranteed to resolve against the document
   * `check` graded; that guarantee is why the field is absent rather
   * than best-effort.
   */
  pointer: string;
  /** What following `pointer` gets you, and what editing there affects. */
  anchor: FindingAnchor;
  /**
   * Where the node at `pointer` came from in the files that were read:
   * which document, where in it, and the references that reached it.
   *
   * `pointer` addresses the **resolved** document, which for a spec
   * assembled from several files names a node no author typed, in a
   * component the resolver may have invented. This is the address in
   * the file the author would open.
   *
   * Absent means one of two things, and which one is decided by the
   * spec that was checked rather than by the finding:
   *
   * - **The resolved spec carried regions** (it was loaded or resolved
   *   with `provenance: true`). Absence is then a fact about the node:
   *   no source node corresponds to it. The resolver invented the
   *   container that holds hoisted schemas, or the root extension that
   *   stitched externals live under, or an overlay rewrote or added the
   *   node after resolution and its position in a source file would be
   *   stale.
   * - **It did not.** Source attribution was unavailable for the whole
   *   run, so every target lacks this field and none of them is saying
   *   anything about its node.
   *
   * A caller tells the two apart the way `sourceOf` says to: by whether
   * regions were recorded, which is a property of the `ResolvedSpec`
   * they passed in and which they already know. `oaverify check` always
   * loads with `provenance: true`, so in CLI output only the first case
   * arises.
   *
   * Present or absent as a unit, never partly filled. See
   * {@link SourceAddress}, which also states the one thing this does not
   * claim: it addresses the node the resolved node was built from, and
   * does not promise the two hold the same value.
   */
  source?: SourceAddress;
}

/**
 * The classes a run can *select*, which the CLI spells `--only`. See
 * {@link CheckFinding.class} for the classes a finding can be
 * *reported* under, which additionally includes `"malformed"`.
 *
 * The two sets differ on purpose and the asymmetry is load-bearing: a
 * malformed schema is found by compiling, which is what the `schema`
 * class does, so it cannot be requested on its own.
 */
export const CHECK_CLASSES = ["hygiene", "schema", "conformance", "examples", "redos"] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

/**
 * Every severity, ordered least to most serious, so a consumer gating on
 * a threshold can compare by index. The CLI's `--fail-on` is one such
 * gate: it fires on its own level and everything above it, so
 * `--fail-on error` catches specification violations and ignores the
 * rest.
 *
 * No `info` level, deliberately. Adding one and putting the tidiness
 * codes in it would have changed what `--fail-on warning` does: it
 * historically meant "any finding at all", and demoting
 * `unused-component` below the threshold would silently stop an
 * existing CI gate from firing. `warning` is also the honest level for
 * those codes: declaring a component nothing reaches is legal, and
 * probably not what the author meant, which is what warning means here.
 * An `info` level can be added when something actually belongs in it.
 */
export const CHECK_SEVERITIES = ["warning", "error", "fatal"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];
