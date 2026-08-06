/**
 * Comparing a run against a committed baseline when the corpus has moved.
 *
 * The pinned case is easy: same cases, same code, so any drop is a
 * regression. Against upstream HEAD it is not, because two very different
 * things both show up as "more failures than the baseline records":
 *
 *   1. we broke something, or
 *   2. upstream added cases we do not pass yet.
 *
 * A nightly that cannot tell those apart is noise, and noise gets muted.
 * The discriminator here is the per-unit case count, which every baseline
 * already stores: a unit whose case count is unchanged cannot have gained
 * coverage, so extra failures there are ours. A unit whose case count grew
 * may have gained failures for either reason, and gets reported rather
 * than failed.
 *
 * That is a heuristic and it is worth being precise about how it is wrong.
 * If upstream adds two cases we fail *and* breaks one we passed, in the
 * same file, on the same night, this reports three new failures and does
 * not fail the run. Catching that needs the baseline to record every case
 * identity rather than just the mismatches, which is a much larger file
 * for a case that has not come up. The pinned run in the same nightly is
 * the backstop: it uses the exact corpus the baseline was measured on, so
 * a real regression fails there whatever upstream did.
 */

/** One comparable unit of a baseline: a format, a suite file, a fixture group. */
export interface FloatingUnit {
  name: string;
  /** Total cases the unit ran. The discriminator. */
  cases: number;
  /** Cases that did not match their expectation, however the runner counts them. */
  failures: number;
}

export interface FloatingVerdict {
  /** Units whose case count held and whose failures grew. Ours. */
  regressions: string[];
  /** Units that gained cases and gained failures. Upstream's, probably. */
  newCoverage: string[];
  /** Units that gained cases with no new failures. Free coverage. */
  absorbed: string[];
  /** Units whose failures dropped. Good news; never fails a floating run. */
  improvements: string[];
  /** Units absent from the baseline entirely. */
  added: string[];
}

/**
 * Classify each unit of a floating run against the baseline.
 *
 * Only `regressions` should fail the run. Everything else is reportable
 * and expected on a corpus that moves.
 */
export function classifyFloating(
  current: readonly FloatingUnit[],
  baseline: readonly FloatingUnit[],
): FloatingVerdict {
  const was = new Map(baseline.map((u) => [u.name, u]));
  const verdict: FloatingVerdict = {
    regressions: [],
    newCoverage: [],
    absorbed: [],
    improvements: [],
    added: [],
  };

  for (const unit of current) {
    const before = was.get(unit.name);
    if (before === undefined) {
      verdict.added.push(
        `${unit.name}: new upstream unit, ${unit.cases} cases, ${unit.failures} failing`,
      );
      continue;
    }
    const casesGrew = unit.cases > before.cases;
    const failuresGrew = unit.failures > before.failures;

    if (failuresGrew && !casesGrew) {
      verdict.regressions.push(
        `${unit.name}: ${before.failures} -> ${unit.failures} failing with the case count unchanged at ${unit.cases}`,
      );
    } else if (failuresGrew) {
      verdict.newCoverage.push(
        `${unit.name}: +${unit.cases - before.cases} cases, ${before.failures} -> ${unit.failures} failing`,
      );
    } else if (casesGrew) {
      verdict.absorbed.push(`${unit.name}: +${unit.cases - before.cases} cases, all passing`);
    } else if (unit.failures < before.failures) {
      verdict.improvements.push(`${unit.name}: ${before.failures} -> ${unit.failures} failing`);
    }
  }
  return verdict;
}

/** Print the verdict and return the exit code a floating run should use. */
export function reportFloating(label: string, verdict: FloatingVerdict, rev: string): number {
  const section = (title: string, lines: readonly string[]) => {
    if (lines.length === 0) return;
    console.log(`\n${title}`);
    for (const line of lines) console.log(`  ${line}`);
  };

  console.log(`\n=== ${label} against upstream ${rev.slice(0, 10)} ===`);
  section("REGRESSED (case count unchanged, so this is ours):", verdict.regressions);
  section("new upstream cases we do not pass:", verdict.newCoverage);
  section("new upstream cases we pass:", verdict.absorbed);
  section("now passing that the baseline records as failing:", verdict.improvements);
  section("units absent from the baseline:", verdict.added);

  if (verdict.regressions.length > 0) {
    console.error(
      `\nFAIL: ${verdict.regressions.length} unit(s) regressed against a corpus that did not grow.`,
    );
    return 1;
  }
  const news = verdict.newCoverage.length;
  console.log(
    news > 0
      ? `\nOK: no regression. ${news} unit(s) gained cases we do not pass; see above.`
      : "\nOK: no regression against upstream HEAD.",
  );
  return 0;
}
