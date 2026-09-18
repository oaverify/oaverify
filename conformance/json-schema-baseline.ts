/** A case's identity within one file at the pinned corpus revision. */
export interface SuiteCase {
  group: string;
  test: string;
  data: unknown;
  expected: boolean;
}

export interface SuiteMismatch extends SuiteCase {
  actual: boolean | "error";
  reason?: string;
}

export interface FileResult {
  file: string;
  groups: number;
  cases: number;
  pass: number;
  fail: number;
  error: number;
  mismatches: SuiteMismatch[];
}

/** Data is read from the same pinned JSON in both measurements. */
export function suiteCaseId(value: SuiteCase): string {
  return JSON.stringify([value.group, value.test, value.data, value.expected]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outcome(mismatch: SuiteMismatch): "verdict" | "compile" | "runtime" {
  if (mismatch.actual !== "error") return "verdict";
  return mismatch.reason?.startsWith("compile: ") ? "compile" : "runtime";
}

function indexResults(
  value: unknown,
  label: string,
  caseIds: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, FileResult> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected a nonempty results array`);
  }
  const files = new Map<string, FileResult>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.file !== "string" || files.has(entry.file)) {
      throw new Error(`${label}: invalid or duplicate file entry`);
    }
    const file = entry.file;
    const ids = caseIds.get(file);
    if (ids === undefined) throw new Error(`${label}: ${file} is absent from this run`);
    for (const field of ["groups", "cases", "pass", "fail", "error"]) {
      const count = entry[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label}: ${file} has an invalid ${field} count`);
      }
    }
    if (!Array.isArray(entry.mismatches)) {
      throw new Error(`${label}: ${file} has no mismatch array`);
    }
    const result = entry as unknown as FileResult;
    if (
      result.cases !== ids.size ||
      result.pass + result.fail + result.error !== result.cases ||
      result.fail + result.error !== result.mismatches.length
    ) {
      throw new Error(`${label}: ${file} has inconsistent case or mismatch counts`);
    }
    const seen = new Set<string>();
    let errors = 0;
    for (const mismatch of entry.mismatches) {
      if (
        !isRecord(mismatch) ||
        typeof mismatch.group !== "string" ||
        typeof mismatch.test !== "string" ||
        !Object.hasOwn(mismatch, "data") ||
        typeof mismatch.expected !== "boolean" ||
        (typeof mismatch.actual !== "boolean" && mismatch.actual !== "error") ||
        mismatch.actual === mismatch.expected ||
        (mismatch.reason !== undefined && typeof mismatch.reason !== "string")
      ) {
        throw new Error(`${label}: ${file} has an invalid mismatch`);
      }
      if (mismatch.actual === "error") {
        if (typeof mismatch.reason !== "string" || !/^(compile|runtime): /.test(mismatch.reason)) {
          throw new Error(`${label}: ${file} has an error without a compile/runtime reason`);
        }
        errors += 1;
      }
      const id = suiteCaseId(mismatch as unknown as SuiteMismatch);
      if (!ids.has(id) || seen.has(id)) {
        throw new Error(`${label}: ${file} has an unknown or duplicate mismatch case`);
      }
      seen.add(id);
    }
    if (errors !== result.error) {
      throw new Error(`${label}: ${file} has inconsistent error counts`);
    }
    files.set(file, result);
  }
  if (files.size !== caseIds.size) {
    throw new Error(`${label}: file set differs from this run`);
  }
  return files;
}

export interface SuiteComparison {
  baselinePass: number;
  baselineCases: number;
  regressions: string[];
  improvements: string[];
}

/**
 * Compare failures by case identity at a fixed corpus pin. The inventory comes
 * from the cases actually attempted, so stale mismatch identities and partial
 * comparisons fail as measurement errors. The committed baseline stays small:
 * it needs only its existing counts and mismatch records.
 *
 * A known wrong verdict becoming a crash is a regression. A crash producing a
 * verdict is an improvement even if that verdict is still wrong. A change of
 * crash phase requires review and fails the gate; error message text is ignored.
 * Throws on invalid or incompatible measurements. Floating runs use their
 * separate per-file classifier.
 */
export function compareSuiteBaseline(
  current: readonly FileResult[],
  baseline: unknown,
  caseIds: ReadonlyMap<string, ReadonlySet<string>>,
): SuiteComparison {
  const before = indexResults(baseline, "baseline", caseIds);
  const after = indexResults(current, "current", caseIds);
  const comparison: SuiteComparison = {
    baselinePass: 0,
    baselineCases: 0,
    regressions: [],
    improvements: [],
  };
  for (const [file, previous] of before) {
    const next = after.get(file)!;
    if (next.groups !== previous.groups) {
      throw new Error(`baseline: ${file} group count differs from this run`);
    }
    comparison.baselinePass += previous.pass;
    comparison.baselineCases += previous.cases;
    const known = new Map(previous.mismatches.map((m) => [suiteCaseId(m), m]));
    for (const mismatch of next.mismatches) {
      const id = suiteCaseId(mismatch);
      const was = known.get(id);
      const label = `${file}: ${mismatch.group} / ${mismatch.test}`;
      if (was === undefined) {
        comparison.regressions.push(`${label}: new ${outcome(mismatch)} failure`);
      } else if (outcome(was) !== outcome(mismatch)) {
        const change = `${label}: ${outcome(was)} -> ${outcome(mismatch)} failure`;
        if (mismatch.actual === "error") comparison.regressions.push(change);
        else comparison.improvements.push(change);
      }
      known.delete(id);
    }
    for (const mismatch of known.values()) {
      comparison.improvements.push(`${file}: ${mismatch.group} / ${mismatch.test}: now passing`);
    }
  }
  return comparison;
}
