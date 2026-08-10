/**
 * Writing a committed baseline, with the one guard every runner needs.
 *
 * @packageDocumentation
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Write a baseline file, unless the run that produced it was filtered.
 *
 * A `--filter=` run measures a subset of the corpus. Writing its results
 * replaces the committed baseline with a partial one, silently dropping every
 * unit the filter excluded, and the damage is invisible in the file afterwards:
 * a partial baseline looks exactly like a complete baseline that happens to
 * record fewer units. The next `--check-baseline` then passes against the
 * smaller set and reports OK.
 *
 * This is not hypothetical. `pnpm format-suite --filter=uri-template` cut
 * `format-results.json` from 21 formats to 1, and it was caught by reading
 * `git status` rather than by anything in the run's own output.
 *
 * Refusing is deliberate rather than merging the subset back in: a merged file
 * would mix units measured at different times, and after a corpus bump, at
 * different corpus revisions. A baseline is only meaningful as one measurement
 * of one corpus.
 *
 * @param summaryPath - Absolute path to the baseline file.
 * @param results - The full result set to serialize.
 * @param filterPattern - The `--filter=` value, or `undefined` for a full run.
 * @param label - What the file holds, for the confirmation line.
 */
export function writeBaseline(
  summaryPath: string,
  results: unknown,
  filterPattern: string | undefined,
  label: string,
): void {
  if (filterPattern !== undefined) {
    console.log(
      `\nNot writing ${basename(summaryPath)}: this run was filtered by ` +
        `"${filterPattern}", so it covers only part of the corpus and would ` +
        `replace the baseline with a partial one.\n` +
        `Re-run without --filter to refresh it.`,
    );
    return;
  }
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${label} written to ${summaryPath}`);
}
