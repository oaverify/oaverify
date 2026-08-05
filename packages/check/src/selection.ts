/**
 * One selection grammar over the finding vocabulary, with the two stages
 * assigned to the two polarities.
 *
 * `--only` and `--skip` are not one axis with opposite polarity, which is
 * what #661 assumed. `--only` decides which passes run and is allowed to
 * turn detection off; `--skip` decides which produced findings are
 * reported and is not. On a 7.6MB document that difference is 0.16s and
 * 136MB against 13.4s and 2.7GB, and on an uncompilable document it is
 * exit 0 against exit 4. Collapsing them into a single post-filter would
 * lose the first; collapsing them into a single pre-filter would let an
 * exclusion silence a `malformed` finding, which `skip.ts` refuses to
 * allow.
 *
 * So one flag, one grammar, and the stages split by sign:
 *
 * > Positive terms decide what runs. Negative terms subtract from what
 * > was produced. With no positive term, everything runs.
 *
 * A term is a no-op when deleting it from the command would not change
 * the selected set. That is decided here, statically, against the other
 * terms, which is what separates "this exclusion named work that was
 * never selected" from "this exclusion was live and dropped nothing",
 * the signal {@link SkipReportEntry} exists for.
 *
 * @packageDocumentation
 */

import { CODES_BY_CLASS, MALFORMED_CODES } from "./codes.js";
import { parseFindingKey, type FindingKey } from "./finding-key.js";
import { CHECK_CLASSES, type CheckClass } from "./finding.js";

/** Thrown by {@link parseFindingTerms} for input it will not accept. */
export class FindingTermError extends Error {}

/**
 * Every code a term may name.
 *
 * `malformed-schema` is excluded, which is what makes the malformed
 * class unselectable and unexcludable in one place rather than two. It
 * is produced as a side effect of schema compilation and survives every
 * filter; see {@link FindingSelection.compileSchemas}.
 */
export const SELECTABLE_CODES: ReadonlySet<string> = new Set(
  CHECK_CLASSES.flatMap((cls) => [...CODES_BY_CLASS[cls]]),
);

/** One parsed term, sign and key. */
export interface FindingTerm {
  /** The term as written, `-` included. Reported back verbatim. */
  readonly text: string;
  /** Whether it subtracts. */
  readonly exclude: boolean;
  readonly key: FindingKey;
}

/**
 * What one term did, for the report.
 *
 * A term is either live or a no-op, and a no-op says why in the words a
 * reader needs to fix the command. Live exclusion terms additionally
 * carry a count, filled in after the passes run by
 * {@link applySkip}; live inclusion terms carry no count because they
 * select rather than drop.
 *
 * @public
 */
export interface TermReport {
  /** The term as written. */
  readonly term: string;
  /** Absent when the term is live. */
  readonly noop?: string;
}

/**
 * A resolved `--findings` value: what runs, what is reportable, and what
 * each term did.
 *
 * @public
 */
export interface FindingSelection {
  /**
   * The reportable universe the inclusion terms chose, before exclusions.
   *
   * Every inclusion term's codes unioned, or {@link SELECTABLE_CODES}
   * when there are none. This is what decides work: a pass runs when it
   * owns a member.
   */
  readonly base: ReadonlySet<string>;
  /** Classes whose pass must run, derived from {@link base}. */
  readonly classes: ReadonlySet<CheckClass>;
  /**
   * Whether the schema compile prepass runs.
   *
   * Split out of {@link classes} because the schema class holds two
   * products with a 1600x cost difference: `format-not-validated` is a
   * document walk, and every other schema code comes from compiling the
   * whole document (8ms against 13.1s on `stripe.json`). A selection
   * naming only the walk pays only for the walk.
   *
   * This is also the switch that decides whether `malformed` findings
   * can exist at all, since compiling is what finds them. That is the
   * one place the malformed guarantee is conditional, and it is
   * conditional on the same thing today: `--only hygiene` has never
   * reported a malformed schema.
   */
  readonly compileSchemas: boolean;
  /**
   * Live exclusion keys, in written order, for {@link applySkip}.
   *
   * No-op exclusions are absent: they would report a count of zero,
   * which is the signal a live exclusion uses to say "this suppression
   * has gone stale", and a no-op term must not be able to imitate it.
   */
  readonly excludeKeys: readonly FindingKey[];
  /** Every term, in written order. */
  readonly terms: readonly TermReport[];
}

/**
 * Parse the `--findings` grammar into terms.
 *
 * One comma-separated list. A term is an exact code
 * (`unsatisfiable/pattern-length`), a family (`unsatisfiable/*`), or a
 * class (`redos`), optionally prefixed `-` to exclude it. The same key
 * space `--severity` grades over, checked the same way by
 * {@link parseFindingKey}, so a typo is refused rather than silently
 * selecting nothing.
 *
 * The value is single, not variadic, and that is a constraint rather
 * than a preference: commander passes a `-`-prefixed value through on a
 * single-value option and rejects the second one on a variadic option
 * (`--skip -redos -schema` fails with "unknown option '-schema'").
 *
 * **An empty value is refused.** A CI variable that expanded to nothing
 * must not silently mean "everything"; that is the same failure the
 * unknown-key refusal exists to prevent.
 *
 * **`malformed` cannot be named**, in either polarity, for the reason on
 * {@link parseSkipKeys}: it means the document does not compile, which
 * is not a matter of taste. There is no `all` term either, since a
 * selection with no inclusion term already means every code, so `all`
 * would be a no-op by construction.
 *
 * @throws FindingTermError with the offending text.
 *
 * @public
 */
export function parseFindingTerms(value: string): FindingTerm[] {
  if (value.trim() === "") {
    throw new FindingTermError(
      "no terms; omit the flag to report everything rather than passing an empty value",
    );
  }

  const terms: FindingTerm[] = [];

  for (const entry of value.split(",")) {
    const text = entry.trim();
    if (text === "") continue;

    const exclude = text.startsWith("-");
    const bare = exclude ? text.slice(1) : text;

    if (bare === "malformed" || bare === "malformed-schema") {
      throw new FindingTermError(
        `"${text}": a malformed schema means the document cannot be compiled, so it cannot be selected or excluded`,
      );
    }

    const parsed = parseFindingKey(bare);
    if (!parsed.ok) throw new FindingTermError(`"${text}": ${parsed.reason}`);
    terms.push({ text, exclude, key: parsed.key });
  }

  if (terms.length === 0) {
    throw new FindingTermError(
      "no terms; omit the flag to report everything rather than passing an empty value",
    );
  }

  return terms;
}

/**
 * The one schema-class code produced by a document walk rather than by
 * compiling (#644). Named here because it is what splits the class's
 * cost; see {@link FindingSelection.compileSchemas}.
 */
export const FORMAT_WALK_CODE = "format-not-validated";

/** Every selectable code one key names. */
function expand(key: FindingKey): Set<string> {
  switch (key.kind) {
    case "code":
      return new Set(SELECTABLE_CODES.has(key.value) ? [key.value] : []);
    case "family":
      return new Set([...SELECTABLE_CODES].filter((code) => code.startsWith(`${key.value}/`)));
    case "class":
      return new Set(CODES_BY_CLASS[key.value as CheckClass]);
  }
}

/** Whether every member of `subset` is in `of`. */
function isSubsetOf(subset: ReadonlySet<string>, of: ReadonlySet<string>): boolean {
  for (const member of subset) if (!of.has(member)) return false;
  return true;
}

/**
 * Resolve parsed terms into what runs and what is reportable.
 *
 * The rule, whole: **the base is the union of the inclusion terms, or
 * every selectable code when there are none; a pass runs when it owns a
 * member of the base; exclusion terms drop findings the passes
 * produced.** Order never matters.
 *
 * A term is reported as a no-op when deleting it would not change the
 * selected set: an inclusion whose codes another inclusion already
 * covers, or an exclusion whose codes are outside the base or already
 * removed by another exclusion. Reported rather than refused, because
 * `-a,-b` is what a script produces when it unions two exclusion lists
 * and refusing it would make exclusion lists uncomposable. A no-op
 * changes no exit code.
 *
 * @public
 */
export function resolveFindingSelection(terms: readonly FindingTerm[]): FindingSelection {
  // Position-keyed throughout, so a term repeated verbatim reports the
  // first occurrence live and the second redundant rather than both.
  const codes = terms.map((term) => expand(term.key));
  const noop = terms.map((): string | undefined => undefined);

  const identities = new Set<string>();
  for (const [i, term] of terms.entries()) {
    const identity = `${term.exclude ? "-" : "+"}${term.key.kind}:${term.key.value}`;
    if (identities.has(identity)) noop[i] = "repeats an earlier term";
    else identities.add(identity);
  }

  const at = (i: number): Set<string> => codes[i] ?? new Set<string>();
  const live = (i: number): boolean => noop[i] === undefined;
  const indices = terms.map((_, i) => i);
  const includes = indices.filter((i) => !terms[i]?.exclude);
  const excludes = indices.filter((i) => terms[i]?.exclude);

  const base = new Set<string>(
    includes.length === 0 ? SELECTABLE_CODES : includes.flatMap((i) => [...at(i)]),
  );

  // The only inclusion is never redundant: deleting it would widen the
  // base to everything rather than leave it alone.
  if (includes.length > 1) {
    for (const i of includes) {
      if (!live(i)) continue;
      const others = new Set(includes.filter((j) => j !== i && live(j)).flatMap((j) => [...at(j)]));
      if (isSubsetOf(at(i), others)) noop[i] = "already selected by another term";
    }
  }

  // Two terms that cover each other cannot both be redundant, since
  // deleting both would change the selection. The earlier one is the one
  // reported, which is the only order-dependence in here: what a run
  // selects never depends on the order the terms were written.
  const liveExcludes: number[] = [];
  for (const i of excludes) {
    if (!live(i)) continue;
    const inBase = new Set([...at(i)].filter((code) => base.has(code)));
    if (inBase.size === 0) {
      noop[i] = "outside the selected findings";
      continue;
    }
    const others = new Set(excludes.filter((j) => j !== i && live(j)).flatMap((j) => [...at(j)]));
    if (isSubsetOf(inBase, others)) {
      noop[i] = "already excluded by another term";
      continue;
    }
    liveExcludes.push(i);
  }

  const classes = new Set<CheckClass>(
    CHECK_CLASSES.filter((cls) => CODES_BY_CLASS[cls].some((code) => base.has(code))),
  );

  // The compile prepass, and with it every `malformed` finding, is
  // reached only by a selection that asked for a code the compiler owns.
  // `format-not-validated` is a schema code and is not one of them.
  const compilerOwned = CODES_BY_CLASS.schema.filter(
    (code) => !(MALFORMED_CODES as readonly string[]).includes(code) && code !== FORMAT_WALK_CODE,
  );

  return {
    base,
    classes,
    compileSchemas: compilerOwned.some((code) => base.has(code)),
    excludeKeys: liveExcludes.map((i) => terms[i]?.key).filter((k) => k !== undefined),
    terms: terms.map((term, i) => {
      const why = noop[i];
      return why === undefined ? { term: term.text } : { term: term.text, noop: why };
    }),
  };
}

/** The selection a run with no `--findings` gets: everything. */
export const FULL_SELECTION: FindingSelection = resolveFindingSelection([]);

/**
 * The selection a list of classes names, for {@link CheckOptions.only}.
 *
 * `only` asks the same question one step coarser, so it resolves into
 * the same object rather than being carried beside it. That is what
 * keeps `checkSpec` from holding two notions of selection that can
 * disagree, which is the hazard #661 names.
 *
 * @public
 */
export function selectionForClasses(classes: readonly CheckClass[]): FindingSelection {
  return resolveFindingSelection(
    classes.map((value) => ({ text: value, exclude: false, key: { kind: "class", value } })),
  );
}
