/**
 * `checkSpec` under a `--findings` selection: what runs, what survives,
 * and what a selection may never turn off.
 *
 * The cost claims are unit-sized here (does the compile prepass run at
 * all) rather than timed, because a timing assertion in the suite is a
 * flake. The wall-clock numbers behind them are in the commit message
 * and on {@link FindingSelection.compileSchemas}.
 */
import { createMemoryReader, loadSpec, type ResolvedSpec } from "@oaverify/internal-spec";
import { describe, expect, it } from "vitest";
import { checkSpec } from "../src/check.js";
import {
  parseFindingTerms,
  resolveFindingSelection,
  selectionForClasses,
} from "../src/selection.js";
import type { CheckFinding } from "../src/finding.js";
import { applySkip } from "../src/skip.js";
import { kitchenSink, malformedSpec } from "./fixtures.js";

async function resolve(
  entries: Array<[string, unknown]>,
  entry = "entry.json",
): Promise<ResolvedSpec> {
  return loadSpec({ reader: createMemoryReader(new Map(entries)), entry, provenance: true });
}

const select = (value: string) => resolveFindingSelection(parseFindingTerms(value));
const codesOf = (findings: readonly CheckFinding[]): string[] =>
  [...new Set(findings.map((f) => f.code))].sort();

/** Findings a term list produces, exclusions applied the way the CLI does. */
function run(resolved: ResolvedSpec, value: string): CheckFinding[] {
  const selection = select(value);
  const findings = checkSpec(resolved, { findings: selection });
  return applySkip(findings, selection.excludeKeys).findings;
}

describe("a selection decides what runs", () => {
  it("runs one class for one class term, as `only` did", async () => {
    const resolved = await resolve(kitchenSink());
    expect(codesOf(run(resolved, "redos"))).toEqual(["ambiguous-pattern"]);
  });

  it("narrows within a class, which a class-granular selection could not", async () => {
    const resolved = await resolve(kitchenSink());
    const whole = codesOf(checkSpec(resolved, { only: ["hygiene"] }));
    expect(whole).toEqual(["path-param-undeclared", "unused-component"]);
    expect(codesOf(run(resolved, "unused-component"))).toEqual(["unused-component"]);
  });

  it("skips the compile prepass for the format walk alone", async () => {
    // The measured seam. `format-not-validated` is a document walk;
    // every other schema code needs the whole document compiled, which
    // on stripe.json is 13.1s and 2.4GB against 8ms for the build.
    const resolved = await resolve(kitchenSink());
    expect(select("format-not-validated").compileSchemas).toBe(false);
    expect(codesOf(run(resolved, "format-not-validated"))).toEqual(["format-not-validated"]);

    // And the other half of the class still gets it.
    expect(select("unsatisfiable/*").compileSchemas).toBe(true);
    expect(codesOf(run(resolved, "unsatisfiable/*"))).toEqual(["unsatisfiable/pattern-length"]);
  });

  it("runs every pass when the only terms are exclusions", async () => {
    // Exclusions are post-run suppression, so `-redos` costs what
    // `--skip redos` costs today. That is the price of the guarantee in
    // the malformed tests below.
    const resolved = await resolve(kitchenSink());
    const selection = select("-redos");
    expect(selection.classes.has("redos")).toBe(true);
    expect(selection.compileSchemas).toBe(true);
    expect(run(resolved, "-redos").some((f) => f.class === "redos")).toBe(false);
  });
});

describe("what a selection may never turn off", () => {
  it("reports a malformed schema under an exclusion that names its class", async () => {
    // The guarantee: `-schema` is post-run suppression, so the compile
    // still happens and the fatal finding still lands. This is what
    // `--skip schema` does today, and it is why exclusions do not get to
    // avoid work.
    const resolved = await resolve(malformedSpec(), "spec.json");
    const findings = run(resolved, "-schema");
    expect(findings.map((f) => f.class)).toEqual(["malformed"]);
    expect(findings[0]?.severity).toBe("fatal");
  });

  it("reports a malformed schema under an inclusion that asks for schema", async () => {
    const resolved = await resolve(malformedSpec(), "spec.json");
    expect(run(resolved, "schema").map((f) => f.class)).toEqual(["malformed"]);
  });

  it("does not report one when nothing asked for a compiled code", async () => {
    // The one place the guarantee is conditional, and it is conditional
    // on the same thing today: `--only hygiene` has never reported a
    // malformed schema, because compiling is what finds one.
    const resolved = await resolve(malformedSpec(), "spec.json");
    expect(run(resolved, "hygiene")).toEqual([]);
    expect(checkSpec(resolved, { only: ["hygiene"] })).toEqual([]);
  });

  it("cannot be named by any term", () => {
    for (const value of ["malformed", "-malformed", "malformed-schema", "-malformed-schema"]) {
      expect(() => parseFindingTerms(value)).toThrow(/cannot be selected or excluded/);
    }
  });
});

describe("`only` and `findings` are one notion", () => {
  it("resolves `only` through the same selection", async () => {
    const resolved = await resolve(kitchenSink());
    const viaOnly = checkSpec(resolved, { only: ["hygiene", "redos"] });
    const viaSelection = checkSpec(resolved, {
      findings: selectionForClasses(["hygiene", "redos"]),
    });
    expect(codesOf(viaSelection)).toEqual(codesOf(viaOnly));
  });

  it("lets `findings` win when both are given", async () => {
    const resolved = await resolve(kitchenSink());
    const findings = checkSpec(resolved, { only: ["hygiene"], findings: select("redos") });
    expect(codesOf(findings)).toEqual(["ambiguous-pattern"]);
  });
});

describe("the report a selection produces", () => {
  it("counts a live exclusion exactly, because its pass ran", async () => {
    const resolved = await resolve(kitchenSink());
    const selection = select("-redos");
    const { skipped } = applySkip(
      checkSpec(resolved, { findings: selection }),
      selection.excludeKeys,
    );
    expect(skipped).toEqual([{ key: "redos", count: 1 }]);
  });

  it("keeps a live exclusion that dropped nothing distinguishable from a no-op", async () => {
    // Both print zero-ish, and they mean different things: one is a
    // suppression that has gone stale (the signal skip.ts exists for),
    // the other is a term that never applied. The first is a runtime
    // count, the second is decided before anything runs.
    const resolved = await resolve(kitchenSink());
    const stale = select("-unsatisfiable/enum-member-type");
    expect(stale.terms[0]?.noop).toBeUndefined();
    const { skipped } = applySkip(checkSpec(resolved, { findings: stale }), stale.excludeKeys);
    expect(skipped).toEqual([{ key: "unsatisfiable/enum-member-type", count: 0 }]);

    const outside = select("schema,-redos");
    expect(outside.terms[1]?.noop).toBe("outside the selected findings");
    expect(outside.excludeKeys).toEqual([]);
  });
});

describe("cost", () => {
  it("does not compile when no compiler-owned code is selected", async () => {
    // A direct check that the prepass is skipped rather than run and
    // discarded, since the whole cost argument rests on it.
    const resolved = await resolve(kitchenSink());

    for (const [value, expected] of [
      ["hygiene", false],
      ["format-not-validated", false],
      ["redos,examples", false],
      ["schema", true],
      ["unsatisfiable/pattern-length", true],
      ["-hygiene", true],
    ] as const) {
      expect([value, select(value).compileSchemas]).toEqual([value, expected]);
    }
    expect(codesOf(run(resolved, "hygiene,format-not-validated"))).toEqual([
      "format-not-validated",
      "path-param-undeclared",
      "unused-component",
    ]);
  });
});
