/**
 * Dropping findings by key, and saying what was dropped.
 *
 * Every comparable tool grows per-rule suppression, because every
 * consumer eventually disagrees with one rule rather than a whole
 * class. Selecting passes is the wrong lever for that (it decides
 * which checks run, and the `schema` class carries the malformed
 * gate); `--severity` is the wrong axis entirely, because "how bad is
 * this" and "does this exist" are different questions, and conflating
 * them is what made `--fail-on` useless once already.
 *
 * On the CLI both halves are spelled through one `--findings` flag: a
 * bare term selects and may skip work, a `-` prefixed term excludes
 * and cannot. That is the stage-not-polarity distinction #673 settled;
 * this module is the exclusion half.
 *
 * A skipped finding is **not produced**: it is absent from the findings
 * array, so it gates on nothing and counts toward nothing. The report
 * below is what keeps that from being silent, which is the property a
 * severity level could not have provided.
 *
 * @packageDocumentation
 */

import { parseFindingKey, type FindingKey } from "./finding-key.js";
import type { CheckFinding } from "./finding.js";

/**
 * What one `--skip` key suppressed.
 *
 * Reported for **every** key given, including ones that matched
 * nothing. A skip entry with a count of zero is the interesting case: a
 * CI configuration suppressing a code that no longer fires, which is
 * how a real defect eventually arrives suppressed and unnoticed.
 *
 * @public
 */
export interface SkipReportEntry {
  /** The key as written, e.g. `unsatisfiable/*`. */
  readonly key: string;
  /** How many findings it dropped. */
  readonly count: number;
}

/** Thrown by {@link parseSkipKeys} for input it will not accept. */
export class SkipKeyError extends Error {}

/**
 * Parse the `--skip` grammar into keys.
 *
 * One comma-separated list of keys, and a key is an exact code
 * (`unsatisfiable/pattern-length`), a family (`unsatisfiable/*`), or a
 * class (`redos`). The same key space `--severity` grades over, checked
 * the same way by {@link parseFindingKey}, so a typo is refused with
 * the family's real members rather than silently suppressing nothing.
 *
 * **`malformed` cannot be skipped.** Its exit code is 4 and it means
 * the document cannot be compiled, which is not a gate result and not
 * a matter of taste. Suppressing it would turn "this document does not
 * compile" into a clean report, which is the failure suppression is
 * most dangerous for. `malformed` and `malformed-schema` are refused
 * rather than half-applied, on the same reasoning `parseSeverityMap`
 * refuses to remap them.
 *
 * @throws SkipKeyError with the offending text.
 *
 * @public
 */
export function parseSkipKeys(entries: readonly string[]): FindingKey[] {
  const keys: FindingKey[] = [];

  for (const entry of entries.flatMap((e) => e.split(","))) {
    const text = entry.trim();
    if (text === "") continue;

    if (text === "malformed" || text === "malformed-schema") {
      throw new SkipKeyError(
        `"${text}": a malformed schema means the document cannot be compiled, so it cannot be skipped`,
      );
    }

    const parsed = parseFindingKey(text);
    if (!parsed.ok) throw new SkipKeyError(`"${text}": ${parsed.reason}`);
    keys.push(parsed.key);
  }

  return keys;
}

/** Whether one key selects one finding. */
function matches(key: FindingKey, finding: CheckFinding): boolean {
  switch (key.kind) {
    case "code":
      return finding.code === key.value;
    case "family": {
      const slash = finding.code.indexOf("/");
      return slash !== -1 && finding.code.slice(0, slash) === key.value;
    }
    case "class":
      return finding.class === key.value;
  }
}

/**
 * Drop every finding a key selects, and count what each key dropped.
 *
 * Separate from `checkSpec` rather than an option on it, because the
 * passes have no part in this: a skipped finding is produced and then
 * withheld, and withholding is the caller's policy. Keeping it out here
 * also leaves `checkSpec`'s return type alone.
 *
 * A finding matched by several keys counts once against each, so the
 * counts say what each key is doing rather than summing to the number
 * of findings dropped. `dropped` is the count that sums.
 *
 * @param findings - Everything the passes produced.
 * @param keys - Parsed keys, from {@link parseSkipKeys}.
 * @returns The surviving findings, one report entry per key given (in
 *   the order given), and how many findings were dropped in total.
 *
 * @public
 */
export function applySkip(
  findings: readonly CheckFinding[],
  keys: readonly FindingKey[],
): { findings: CheckFinding[]; skipped: SkipReportEntry[]; dropped: number } {
  if (keys.length === 0) {
    return { findings: [...findings], skipped: [], dropped: 0 };
  }

  const counts = keys.map(() => 0);
  const kept: CheckFinding[] = [];
  let dropped = 0;

  for (const finding of findings) {
    let drop = false;
    for (const [i, key] of keys.entries()) {
      if (!matches(key, finding)) continue;
      counts[i] = (counts[i] ?? 0) + 1;
      drop = true;
    }
    if (drop) dropped += 1;
    else kept.push(finding);
  }

  const skipped = keys.map((key, i) => ({
    key: key.kind === "family" ? `${key.value}/*` : key.value,
    count: counts[i] ?? 0,
  }));

  return { findings: kept, skipped, dropped };
}
