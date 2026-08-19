/**
 * The AOT parity grid: generated documents driven through both
 * `oaverify compile-spec`'s emitted module and
 * `createValidator(document)`, compared on verdict, error leaves,
 * delivered values and `getOperation`.
 *
 * **What a green run does not certify.** `createValidator` is not an
 * independent authority. `emit-spec.ts` was written by copying
 * `validate-step.ts` and says so in its own comments throughout, so the
 * two implementations are correlated by authorship and a defect present
 * in both is invisible here by construction. That is the blindness
 * `scripts/grid/README.md` documents for metamorphic relations, and the
 * one that let #753 pass 21,420 cases on a commit carrying a
 * request-breaking regression. A green run means the two
 * implementations agree. It does not mean either is right, and it is
 * not a conformance result.
 *
 * The generator, the runner, the gate and the divergence registry live
 * in `test/aot-grid/`, whose README carries the coverage gaps and the
 * run that produced the registry.
 */

import { describe, expect, it } from "vitest";
import { declarations } from "./aot-grid/cases.js";
import { runDeclaration, type CaseResult } from "./aot-grid/run.js";
import { DIVERGENCES } from "./aot-grid/divergences.js";
import { evaluate, render } from "./aot-grid/gate.js";

describe("compile-spec: generated parity grid vs createValidator", () => {
  it("agrees with createValidator everywhere an entry does not say how it differs", async () => {
    const started = performance.now();
    const decls = declarations();
    const cases: CaseResult[] = [];
    for (const decl of decls) cases.push(...(await runDeclaration(decl)));

    const result = evaluate(cases, DIVERGENCES);
    const report = render(result, DIVERGENCES, decls.length, performance.now() - started);
    if (process.env.AOT_GRID_REPORT !== undefined) process.stderr.write(`\n${report}\n`);

    // Both halves in one assertion, so the report is attached to
    // whichever fails. `stale` is the half that keeps a fixed defect
    // from leaving its exemption behind.
    expect({ unexplained: result.unexplained.length, stale: result.stale }, report).toEqual({
      unexplained: 0,
      stale: [],
    });
  }, 120_000);

  it("generates a grid, rather than reporting an empty one", () => {
    // A generator that produced nothing would pass every assertion
    // above. The numbers are a floor, not a snapshot: they are here to
    // catch a grid that collapsed, and widening the generator raises
    // them rather than breaking them.
    const decls = declarations();
    expect(decls.length).toBeGreaterThan(1000);
    expect(decls.reduce((n, d) => n + d.requests.length, 0)).toBeGreaterThan(15_000);
  });
});
