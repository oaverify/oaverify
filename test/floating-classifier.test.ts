/**
 * The floating-corpus classifier in `conformance/floating.ts`.
 *
 * Tested here rather than in `conformance/` because that sub-root has no
 * vitest, and this is the piece of the nightly most able to be quietly
 * wrong: it decides whether a scheduled run wakes somebody up. If it
 * called new upstream coverage a regression the nightly would cry wolf
 * and get muted; if it called a regression new coverage it would stay
 * silent through a real break.
 */

import { describe, expect, it } from "vitest";
import { classifyFloating, type FloatingUnit } from "../conformance/floating.ts";

const unit = (name: string, cases: number, failures: number): FloatingUnit => ({
  name,
  cases,
  failures,
});

describe("classifyFloating", () => {
  it("calls it a regression when failures grow and the case count does not", () => {
    // The discriminator: no new cases means the extra failures are ours.
    const verdict = classifyFloating([unit("duration", 52, 6)], [unit("duration", 52, 0)]);
    expect(verdict.regressions).toHaveLength(1);
    expect(verdict.regressions[0]).toContain("duration");
    expect(verdict.regressions[0]).toContain("0 -> 6");
    expect(verdict.newCoverage).toEqual([]);
  });

  it("calls it new coverage when both the cases and the failures grow", () => {
    // Upstream added 4 cases and we fail 2 of them. Not a regression.
    const verdict = classifyFloating([unit("duration", 56, 2)], [unit("duration", 52, 0)]);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.newCoverage).toHaveLength(1);
    expect(verdict.newCoverage[0]).toContain("+4 cases");
  });

  it("reports new cases we pass separately from new cases we fail", () => {
    const verdict = classifyFloating([unit("uri", 48, 0)], [unit("uri", 44, 0)]);
    expect(verdict.absorbed).toHaveLength(1);
    expect(verdict.absorbed[0]).toContain("+4 cases, all passing");
    expect(verdict.newCoverage).toEqual([]);
    expect(verdict.regressions).toEqual([]);
  });

  it("never fails a floating run for an improvement", () => {
    // The pinned gate deliberately fails on improvement to force the
    // ratchet. Against a moving corpus that would fire constantly.
    const verdict = classifyFloating([unit("email", 27, 0)], [unit("email", 27, 5)]);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.improvements).toHaveLength(1);
    expect(verdict.improvements[0]).toContain("5 -> 0");
  });

  it("reports a unit the baseline has never seen", () => {
    const verdict = classifyFloating([unit("brand-new-format", 12, 3)], []);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.added).toHaveLength(1);
    expect(verdict.added[0]).toContain("new upstream unit");
  });

  it("says nothing about a unit that did not move", () => {
    const verdict = classifyFloating([unit("uuid", 28, 0)], [unit("uuid", 28, 0)]);
    expect(verdict).toEqual({
      regressions: [],
      newCoverage: [],
      churned: [],
      absorbed: [],
      improvements: [],
      added: [],
    });
  });

  it("classifies each unit independently, so one regression is not masked", () => {
    // The case the per-unit split exists for: upstream grows one format
    // while we break another. The growth must not absorb the break.
    const verdict = classifyFloating(
      [unit("duration", 52, 6), unit("uri", 48, 1)],
      [unit("duration", 52, 0), unit("uri", 44, 0)],
    );
    expect(verdict.regressions).toHaveLength(1);
    expect(verdict.regressions[0]).toContain("duration");
    expect(verdict.newCoverage).toHaveLength(1);
    expect(verdict.newCoverage[0]).toContain("uri");
  });

  it("does not fail when a unit shrinks, which only upstream can cause", () => {
    // Upstream deleted cases: fewer cases, and fewer failures with them.
    const verdict = classifyFloating([unit("idn-email", 18, 1)], [unit("idn-email", 19, 2)]);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.improvements).toHaveLength(1);
  });

  it("reports, but does not fail, a shrunken unit whose failures grew", () => {
    // Upstream removed 6 cases and replaced 4; we fail 2 of the
    // replacements. The count moved, so the extra failures cannot be
    // attributed to us, and calling them ours is how a nightly cries
    // wolf. The pinned run is the backstop for a real regression.
    const verdict = classifyFloating([unit("uri", 42, 2)], [unit("uri", 44, 0)]);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.churned).toHaveLength(1);
    expect(verdict.churned[0]).toContain("44 -> 42 cases");
    expect(verdict.churned[0]).toContain("0 -> 2 failing");
  });
});
