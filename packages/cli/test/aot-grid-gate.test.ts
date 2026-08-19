/**
 * Tests for the parity grid's own accounting.
 *
 * The registry is the most attractive place in this repository to bury
 * a parity defect: it is the one file that can turn a real difference
 * into a green run. So the rules that decide what it can absorb are
 * tested on synthetic cases rather than trusted because the grid is
 * green.
 */

import { describe, expect, it } from "vitest";
import type { CaseAxes } from "./aot-grid/cases.js";
import type { CaseResult } from "./aot-grid/run.js";
import type { DivergenceEntry } from "./aot-grid/divergences.js";
import { evaluate, render } from "./aot-grid/gate.js";

const axes: CaseAxes = { product: "A", in: "query", runtimeSecurity: "off" };

/** A case where the runtime accepts and the AOT rejects with one leaf. */
function diverging(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: "synthetic",
    axes,
    wireId: "w",
    runtime: { verdict: "valid", leaves: [], value: { query: { p: 1 } }, operation: "/t" },
    aot: {
      verdict: "invalid",
      leaves: [{ code: "type", path: ["query", "p"] }],
      value: { query: {} },
      operation: "/t",
    },
    ...overrides,
  };
}

function agreeing(): CaseResult {
  const both = { verdict: "valid" as const, leaves: [], value: { query: {} }, operation: "/t" };
  return { id: "synthetic", axes, wireId: "w", runtime: both, aot: { ...both } };
}

const SIGNATURE =
  'verdict:valid->invalid | leaves:[]->[{"code":"type","path":["query","p"]}] | ' +
  'value:{"query":{"p":1}}->{"query":{}}';

const entry = (overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
  name: "e",
  kind: "open-defect",
  issue: "#1",
  match: () => true,
  signatures: [SIGNATURE],
  ...overrides,
});

describe("parity grid: what the registry can and cannot absorb", () => {
  it("reports a difference no entry claims", () => {
    const r = evaluate([diverging()], []);
    expect(r.unexplained).toHaveLength(1);
    expect(r.perChannel.verdict.unexplained).toBe(1);
    expect(r.perChannel.value.unexplained).toBe(1);
    // `operation` agrees here, so it is not counted as differing at all.
    expect(r.perChannel.operation.differing).toBe(0);
  });

  it("accepts a difference an entry claims with the matching signature", () => {
    const r = evaluate([diverging()], [entry()]);
    expect(r.unexplained).toEqual([]);
    expect(r.perChannel.verdict.signed).toBe(1);
    expect(r.matched.get("e")).toBe(1);
  });

  it("refuses a difference whose signature the entry does not list", () => {
    // Same shape, different delivered value: an entry that claimed the
    // first defect must not silently come to cover a second one.
    const second = diverging({
      aot: {
        verdict: "invalid",
        leaves: [{ code: "type", path: ["query", "p"] }],
        value: { query: { p: "wrong" } },
        operation: "/t",
      },
    });
    const r = evaluate([second], [entry()]);
    expect(r.unexplained).toHaveLength(1);
    expect(r.signatureMismatches).toHaveLength(1);
    expect(r.signatureMismatches[0]?.entry).toBe("e");
  });

  it("refuses an entry that claims nothing", () => {
    const r = evaluate([agreeing()], [entry({ name: "stale-one" })]);
    expect(r.unexplained).toEqual([]);
    expect(r.stale).toEqual(["stale-one"]);
  });

  it("reports a listed signature no case produced, even when the entry still matches", () => {
    // The half entry-level staleness misses. An entry covering four
    // locations whose query half is fixed still matches cases, so
    // `stale` stays empty while a dead signature sits in the registry
    // ready to absorb the next difference shaped like it.
    const twoSignatures = entry({ signatures: [SIGNATURE, "verdict:valid->invalid"] });
    const r = evaluate([diverging()], [twoSignatures]);
    expect(r.stale).toEqual([]);
    expect(r.unexplained).toEqual([]);
    expect(r.staleSignatures).toEqual(["e/verdict:valid->invalid"]);
  });

  it("compares leaf paths as arrays, not as a joined string", () => {
    // `["query", "a.b"]` and `["query", "a", "b"]` join to the same
    // string, and a parameter or property name may contain a dot. A
    // flattened comparison calls this pair identical, which is exactly
    // the attribution mistake leaf tuples exist to catch.
    const dotted: CaseResult = {
      id: "synthetic",
      axes,
      wireId: "w",
      runtime: {
        verdict: "invalid",
        leaves: [{ code: "type", path: ["query", "a.b"] }],
        value: {},
        operation: "/t",
      },
      aot: {
        verdict: "invalid",
        leaves: [{ code: "type", path: ["query", "a", "b"] }],
        value: {},
        operation: "/t",
      },
    };
    const r = evaluate([dotted], []);
    expect(r.perChannel.leaves.differing).toBe(1);
    expect(r.unexplained).toHaveLength(1);
  });

  it("compares the error of a refusal both sides share", () => {
    // Same verdict, different reason. Two implementations refusing one
    // document for unrelated causes is not one event, and the verdict
    // alone cannot say so.
    const refused: CaseResult = {
      id: "synthetic",
      axes,
      wireId: "w",
      runtime: { verdict: "build-error", error: "Error: unserved parameter location" },
      aot: { verdict: "build-error", error: "Error: unknown format" },
    };
    const r = evaluate([refused], []);
    expect(r.perChannel.error.differing).toBe(1);
    expect(r.perChannel.verdict.differing).toBe(0);
  });

  it("matches on axes rather than on the case id", () => {
    // Ids are derived from the axes and change whenever the generator
    // gains one. An entry keyed on an id would rot at exactly the
    // moment someone widens the grid.
    const renamed = diverging({ id: "some-other-id-entirely" });
    const byAxes = entry({ match: (a) => a.in === "query" });
    expect(evaluate([renamed], [byAxes]).unexplained).toEqual([]);
  });

  it("counts each differing channel separately", () => {
    const r = evaluate([diverging()], []);
    expect(r.perChannel.verdict.differing).toBe(1);
    expect(r.perChannel.leaves.differing).toBe(1);
    expect(r.perChannel.value.differing).toBe(1);
  });

  it("says not compared, rather than zero, for a channel it did not read", () => {
    // "0 differences" and "nobody looked" have to be distinguishable in
    // the output, which is the `silent off` versus `silent 0` lesson
    // from the runtime grid.
    const report = render(evaluate([agreeing()], []), [], 1, 0, ["verdict", "leaves"]);
    expect(report).toContain("value     not compared");
    expect(report).toContain("operation not compared");
    expect(report).toContain("verdict       0 differing");
  });

  it("prints an unexplained signature in full, not truncated", () => {
    const report = render(evaluate([diverging()], []), [], 1, 0);
    expect(report).toContain(SIGNATURE);
  });
});
