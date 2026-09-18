import { describe, expect, it } from "vitest";
import {
  compareSuiteBaseline,
  suiteCaseId,
  type FileResult,
  type SuiteMismatch,
} from "../conformance/json-schema-baseline.ts";

const mismatch = (test: string, data: unknown = null): SuiteMismatch => ({
  group: "group",
  test,
  data,
  expected: true,
  actual: false,
});
const oldFailure = mismatch("known failure");
const newFailure = mismatch("new failure");
const inventory = new Map([
  ["same.json", new Set([suiteCaseId(oldFailure), suiteCaseId(newFailure)])],
]);

function result(mismatches: SuiteMismatch[], file = "same.json"): FileResult {
  const error = mismatches.filter((m) => m.actual === "error").length;
  return {
    file,
    groups: 1,
    cases: 2,
    pass: 2 - mismatches.length,
    fail: mismatches.length - error,
    error,
    mismatches,
  };
}

describe("pinned JSON Schema baseline", () => {
  it("rejects cancellation within one file and reports the improvement", () => {
    const verdict = compareSuiteBaseline([result([newFailure])], [result([oldFailure])], inventory);
    expect(verdict.regressions).toEqual(["same.json: group / new failure: new verdict failure"]);
    expect(verdict.improvements).toEqual(["same.json: group / known failure: now passing"]);
    expect(verdict.baselinePass).toBe(1);
  });

  it("rejects cancellation across files", () => {
    const ids = new Map([...inventory, ["other.json", inventory.get("same.json")!]]);
    const verdict = compareSuiteBaseline(
      [result([]), result([newFailure], "other.json")],
      [result([oldFailure]), result([], "other.json")],
      ids,
    );
    expect(verdict.regressions).toHaveLength(1);
    expect(verdict.regressions[0]).toContain("other.json");
    expect(verdict.improvements).toHaveLength(1);
  });

  it("allows known failures and a fully passing baseline", () => {
    for (const failures of [[oldFailure], []]) {
      const verdict = compareSuiteBaseline([result(failures)], [result(failures)], inventory);
      expect(verdict.regressions).toEqual([]);
      expect(verdict.improvements).toEqual([]);
    }
  });

  it("reports improvements without rejecting them", () => {
    const verdict = compareSuiteBaseline([result([])], [result([oldFailure])], inventory);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.improvements).toEqual(["same.json: group / known failure: now passing"]);
  });

  it.each(["compile", "runtime"])("rejects a verdict mismatch becoming a %s error", (phase) => {
    const crash = { ...oldFailure, actual: "error" as const, reason: `${phase}: failed` };
    const verdict = compareSuiteBaseline([result([crash])], [result([oldFailure])], inventory);
    expect(verdict.regressions).toEqual([
      `same.json: group / known failure: verdict -> ${phase} failure`,
    ]);
    const recovered = compareSuiteBaseline([result([oldFailure])], [result([crash])], inventory);
    expect(recovered.regressions).toEqual([]);
    expect(recovered.improvements).toHaveLength(1);
  });

  it("ignores error-message changes but rejects a changed crash phase", () => {
    const crash = { ...oldFailure, actual: "error" as const, reason: "compile: before" };
    const baseline = [result([crash])];
    expect(
      compareSuiteBaseline([result([{ ...crash, reason: "compile: after" }])], baseline, inventory)
        .regressions,
    ).toEqual([]);
    expect(
      compareSuiteBaseline([result([{ ...crash, reason: "runtime: after" }])], baseline, inventory)
        .regressions,
    ).toEqual(["same.json: group / known failure: compile -> runtime failure"]);
  });

  it("distinguishes cases with repeated descriptions by data and expectation", () => {
    const a = mismatch("repeated", { a: [1, null] });
    const b = { ...a, data: { a: [2, null] } };
    const ids = new Map([["same.json", new Set([suiteCaseId(a), suiteCaseId(b)])]]);
    expect(compareSuiteBaseline([result([b])], [result([a])], ids).regressions).toHaveLength(1);
    expect(suiteCaseId(a)).not.toBe(suiteCaseId({ ...a, expected: false }));
  });

  it.each([
    ["non-array", null],
    ["empty", []],
    ["duplicate files", [result([]), result([])]],
    ["missing file", [result([], "other.json")]],
    ["fractional counter", [{ ...result([]), pass: 1.5 }]],
    ["negative counter", [{ ...result([]), fail: -1 }]],
    ["missing mismatches", [{ ...result([]), mismatches: undefined }]],
    ["wrong counts", [{ ...result([]), pass: 1 }]],
    ["changed case count", [{ ...result([]), cases: 3, pass: 3 }]],
    ["changed group count", [{ ...result([]), groups: 2 }]],
    ["duplicate mismatch", [result([oldFailure, oldFailure])]],
    ["unknown mismatch", [result([mismatch("absent")])]],
    ["wrong error count", [{ ...result([oldFailure]), fail: 0, error: 1 }]],
    ["matching verdict", [result([{ ...oldFailure, actual: true }])]],
    ["unknown error phase", [result([{ ...oldFailure, actual: "error", reason: "failed" }])]],
  ])("rejects an invalid or incompatible baseline: %s", (_label, baseline) => {
    expect(() => compareSuiteBaseline([result([])], baseline, inventory)).toThrow();
  });

  it("rejects a partial baseline and invalid current results", () => {
    const ids = new Map([...inventory, ["other.json", inventory.get("same.json")!]]);
    expect(() =>
      compareSuiteBaseline([result([]), result([], "other.json")], [result([])], ids),
    ).toThrow("file set differs");
    expect(() =>
      compareSuiteBaseline([{ ...result([]), pass: 1 }], [result([])], inventory),
    ).toThrow("current:");
  });
});
