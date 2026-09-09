import type { DetectionCase } from "./cases.ts";

/**
 * One normalized finding, whatever tool produced it.
 *
 * `location` matters for fairness: Redocly's struct rule reports
 * "Expected type `array` but got `integer`" and names the offending
 * keyword only in the pointer. Matching on the message alone would
 * score that as a miss when the tool plainly caught the defect.
 */
export interface Finding {
  readonly rule: string;
  readonly message: string;
  readonly location: string;
  readonly severity: string;
}

export interface ToolRun {
  readonly findings: Finding[];
  /** Set when the tool refused to process the document at all. */
  readonly fatal?: string;
}

export interface Row {
  readonly id: string;
  readonly class: string;
  readonly caught: Record<string, boolean>;
  readonly fatal: Record<string, boolean>;
  readonly evidence: Record<string, string>;
  readonly counts: Record<string, number>;
  readonly fatalCounts: Record<string, number>;
}

/**
 * Did this run identify *this* defect? One finding must match one
 * signal. Signals are therefore written to be discriminating -- the
 * misspelled property name, the offending keyword -- so that a generic
 * "schema is invalid" cannot score on every malformed case. Requiring
 * *all* signals instead looks stricter and is worse: it silently
 * scores real catches as misses whenever the tool's wording differs
 * from the guess, which is most of the time.
 */
export function caught(run: ToolRun, testCase: DetectionCase): string | undefined {
  if (testCase.signals.length === 0) return undefined;
  const texts = run.findings.map((f) => `${f.rule}: ${f.message} [${f.location}]`);
  return texts.find((t) => testCase.signals.some((s) => t.toLowerCase().includes(s.toLowerCase())));
}

export function rowForCase(
  testCase: DetectionCase,
  runs: readonly (readonly [string, ToolRun])[],
): Row {
  const caughtBy: Record<string, boolean> = {};
  const fatalBy: Record<string, boolean> = {};
  const evidence: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const fatalCounts: Record<string, number> = {};

  for (const [name, result] of runs) {
    const hit = caught(result, testCase);
    const fatal = result.fatal !== undefined;
    caughtBy[name] = hit !== undefined && !fatal;
    fatalBy[name] = fatal;
    if (hit !== undefined && !fatal) evidence[name] = hit;
    counts[name] = fatal ? 0 : result.findings.length;
    fatalCounts[name] = fatal ? 1 : 0;
  }

  return {
    id: testCase.id,
    class: testCase.class,
    caught: caughtBy,
    fatal: fatalBy,
    evidence,
    counts,
    fatalCounts,
  };
}

export const mark = (hit: boolean, fatal: boolean, cls: string): string => {
  if (fatal) return "ERR";
  // In the control class nothing is wrong, so a "hit" is a false positive.
  if (cls === "control") return hit ? "FP" : "-";
  return hit ? "yes" : "-";
};

export function classSummaryCell(rows: readonly Row[], name: string): string {
  const nonFatal = rows.filter((r) => !r.fatal[name]);
  return `${nonFatal.filter((r) => r.caught[name]).length}/${nonFatal.length}`;
}

export function controlFalsePositiveCount(rows: readonly Row[], name: string): number {
  return rows.filter((r) => !r.fatal[name] && r.caught[name]).length;
}

export function totalFindingsRaised(rows: readonly Row[], name: string): number {
  return rows.reduce((sum, r) => sum + (r.counts[name] ?? 0), 0);
}

export function totalFatalRuns(rows: readonly Row[], name: string): number {
  return rows.reduce((sum, r) => sum + (r.fatalCounts[name] ?? 0), 0);
}

export function auditLine(row: Row, name: string, run: ToolRun | undefined): string {
  const fatal = run?.fatal;
  if (row.fatal[name]) {
    return `- **${name}**: tool failed (${fatal === undefined || fatal === "" ? "no output" : fatal})`;
  }
  if (row.caught[name]) return `- **${name}**: ${row.evidence[name]}`;
  return `- ${name}: no matching finding (${row.counts[name] ?? 0} raised)`;
}
