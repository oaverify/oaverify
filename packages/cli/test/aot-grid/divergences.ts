/**
 * The divergence registry: the differences between `createValidator`
 * and a `compile-spec` module that this gate accepts, and what each one
 * is.
 *
 * **An entry does not excuse a case. An entry asserts what the
 * difference is.** Four rules keep that from being a place to bury a
 * defect. `gate.ts` enforces the first three at run time; the fourth is
 * enforced by {@link DivergenceEntry}'s own shape, so `pnpm typecheck`
 * is what rejects it.
 *
 * 1. An entry whose predicate matches no case fails the run, so a fixed
 *    defect cannot leave a stale exemption behind.
 * 2. A listed signature no case produced fails the run too. Once an
 *    entry lists several, the signature is the exemption, so a dead one
 *    cannot sit waiting for the next difference shaped like it.
 * 3. A case whose observed signature is not one the entry lists fails
 *    the run. Widening an entry is a visible edit to a signature rather
 *    than a predicate quietly growing.
 * 4. `open-defect` and `intentional` are not interchangeable. An
 *    `open-defect` entry names the issue and is expected to stop
 *    matching when that issue is fixed. An `intentional` entry has to
 *    say why the difference is correct, because nothing else will.
 *
 * The predicate reads the structured axes of a case, never its id.
 * Keying on ids would rot every entry the moment the generator gains an
 * axis, which is exactly when someone is least willing to rewrite them.
 *
 * Every entry below was written from the grid's first run against an
 * empty registry, and none of them was written before it. That run is
 * reproduced in this directory's README, and reproducing it is one
 * edit: empty this array.
 */

import type { CaseAxes } from "./cases.js";
import type { CaseResult } from "./run.js";

/** The fields both kinds of entry carry. */
interface DivergenceEntryBase {
  /** Short name, used in the report. */
  name: string;
  /** Matches on axes and on the wire input, never on the case id. */
  match: (axes: CaseAxes, wireId: string) => boolean;
  /**
   * Every signature this divergence is allowed to produce, as
   * `signatureOf` renders it. A case the predicate claims whose
   * signature is not listed fails the run, so an entry cannot quietly
   * come to cover a second, different defect in the same shape.
   */
  signatures: string[];
}

/**
 * A registry entry, in the two kinds rule 4 keeps apart.
 *
 * A union rather than one interface with an optional `why`, so the rule
 * is a thing you cannot write rather than a thing something checks: an
 * `intentional` entry without a justification does not compile, and
 * `pnpm typecheck` is where it fails. The previous shape stated the
 * rule in prose above and enforced it nowhere, which is the failure
 * this instrument exists to catch, one level up.
 *
 * `why` is absent on `open-defect` for the same reason it is required
 * on `intentional`: the issue number is the justification there, and a
 * second free-text field would be a place to argue that a defect is
 * fine.
 */
export type DivergenceEntry =
  | (DivergenceEntryBase & {
      kind: "open-defect";
      /**
       * The defect this difference is. Fixing it is what makes the
       * entry go stale and fail the run, which is the whole of the
       * justification and why there is no `why` beside it.
       */
      issue: string;
      why?: never;
    })
  | (DivergenceEntryBase & {
      kind: "intentional";
      /** Why this difference is correct, in the emitter's own terms. */
      why: string;
      /**
       * Absent, and not by omission. An issue number here reads as the
       * defect that will retire the entry, and an `intentional` entry
       * has none: it is expected to keep matching. Four of these
       * carried `#895` and would have gone on matching after it closed,
       * with the report line inviting a reader to think otherwise.
       * Discussion belongs in `why`, which has room for a sentence.
       */
      issue?: never;
    });

/**
 * `ignoreUndocumented` and `ignorePaths` produce the same difference:
 * the runtime passes a request the emitted module 404s.
 *
 * Two entries rather than one. A merged entry spanning both options
 * would pass the gate today, so this is not a rule the accounting
 * enforces; what it buys is that each option's exemption dies on its
 * own. Give one of the two an emitter counterpart and its entry goes
 * stale and fails the run, where a merged entry would still match the
 * surviving option, still produce this signature, and carry the fixed
 * one silently.
 */
const ROUTE_SIGNATURE = 'verdict:valid->invalid | leaves:[]->[{"code":"route","path":[]}]';

export const DIVERGENCES: DivergenceEntry[] = [
  // Runtime options the emitted module cannot express.
  //
  // Kept apart from #895 on a distinction the grid measured. Each of
  // these four has the emitted module agreeing with `createValidator`
  // at its defaults and differing only once the caller opts in, so the
  // artifact matches a real runtime configuration and names which one.
  // #895's security case matches none: the emitted module always checks
  // operation-level security, and no setting of `validateSecurity`
  // produces that. Matching the default is a limit; matching nothing is
  // the defect.
  //
  // The limit is documented in packages/cli/README.md under
  // "Not serialised". An `intentional` entry asserts a difference is
  // correct, and an undocumented difference is known rather than
  // correct.
  {
    name: "options/strict-query",
    kind: "intentional",
    why:
      "`strictQueryParameters` refuses a query key the operation does not declare. " +
      "The emitted module has no such option and answers as the runtime does by default, " +
      "which is to ignore the extra key.",
    match: (axes, wireId) =>
      axes.shape === "runtime-options/strict-query" &&
      axes.runtimeOptions.strictQueryParameters === true &&
      wireId === "undeclaredQueryKey",
    signatures: [
      'verdict:invalid->valid | leaves:[{"code":"query-param","path":["query","extra"]}]->[]',
    ],
  },
  {
    name: "options/ignore-undocumented",
    kind: "intentional",
    why:
      "`ignoreUndocumented` passes a request to a path the document does not declare. " +
      "The emitted module has no such option and 404s it, as the runtime does by default.",
    match: (axes, wireId) =>
      axes.shape === "runtime-options/ignore-undocumented" &&
      axes.runtimeOptions.ignoreUndocumented === true &&
      wireId === "undeclaredPath",
    signatures: [ROUTE_SIGNATURE],
  },
  {
    name: "options/ignore-paths",
    kind: "intentional",
    why:
      "`ignorePaths` passes a request whose path the caller's own predicate exempts. " +
      "The emitted module has no such option and 404s it, as the runtime does by default. " +
      "The option is function-valued, so an emitter counterpart would have to be something " +
      "other than a flag baked into the module.",
    match: (axes, wireId) =>
      axes.shape === "runtime-options/ignore-paths" &&
      axes.runtimeOptions.ignorePaths !== undefined &&
      wireId === "ignoredPath",
    signatures: [ROUTE_SIGNATURE],
  },
  {
    name: "options/bracketed-arrays",
    kind: "intentional",
    why:
      "`allowBracketedQueryArrays` reads `?p[]=a&p[]=b` as `p`. The emitted module has no " +
      "such option and refuses it, as the runtime does by default. The only one of the four " +
      "that moves the value channel as well as the verdict, because the option decides " +
      "whether a value arrives at all.",
    match: (axes, wireId) =>
      axes.shape === "runtime-options/bracketed-arrays" &&
      axes.runtimeOptions.allowBracketedQueryArrays === true &&
      wireId === "bracketed",
    signatures: [
      'verdict:valid->invalid | leaves:[]->[{"code":"query-param","path":["query","p"]}] | ' +
        'value:{"path":{},"query":{"p":["a","b"]},"headers":{},"cookies":{}}->' +
        '{"path":{},"query":{},"headers":{},"cookies":{}}',
    ],
  },
  {
    name: "options/bracketed-arrays-optional",
    kind: "intentional",
    why:
      "The same option against an optional parameter, where absence is valid on both sides " +
      "and the only thing that moves is the delivered value. Separate from the required " +
      "entry because the signature has no verdict in it: a comparison of verdicts alone " +
      "calls this agreement, which is the half of #888 that shipped.",
    // No wireId pin, unlike its required sibling. The explanation is
    // that the option decides the value whatever spelling arrives, and
    // both spellings produce one signature, so pinning one would make
    // the predicate narrower than the claim rather than equal to it.
    match: (axes) =>
      axes.shape === "runtime-options/bracketed-arrays-optional" &&
      axes.runtimeOptions.allowBracketedQueryArrays === true,
    signatures: [
      'value:{"path":{},"query":{"p":["a","b"]},"headers":{},"cookies":{}}->' +
        '{"path":{},"query":{},"headers":{},"cookies":{}}',
    ],
  },
];

/** The entry claiming a case, or undefined when nothing claims it. */
export function entryFor(c: CaseResult): DivergenceEntry | undefined {
  return DIVERGENCES.find((e) => e.match(c.axes, c.wireId));
}
