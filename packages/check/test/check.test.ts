import { createMemoryReader, loadSpec, type ResolvedSpec } from "@oaverify/internal-spec";
import { describe, expect, it } from "vitest";
import { CheckAbortedError, checkSpec } from "../src/check.js";
import { parseSeverityMap } from "../src/severity.js";
import type { CheckFinding } from "../src/finding.js";
// Shared with packages/cli/test/check-golden.test.ts, which grades the
// same documents through the CLI, so the two sides of the seam are
// exercised on the same input.
import { kitchenSink, malformedSpec } from "./fixtures.js";

async function resolve(
  entries: Array<[string, unknown]>,
  options: { provenance?: boolean; entry?: string } = {},
): Promise<ResolvedSpec> {
  return loadSpec({
    reader: createMemoryReader(new Map(entries)),
    entry: options.entry ?? "entry.json",
    ...(options.provenance !== false && { provenance: true }),
  });
}

const codesOf = (findings: readonly CheckFinding[]): string[] => findings.map((f) => f.code).sort();

describe("checkSpec", () => {
  it("runs every class by default", async () => {
    const findings = checkSpec(await resolve(kitchenSink()));
    expect([...new Set(findings.map((f) => f.class))].sort()).toEqual([
      "conformance",
      "examples",
      "hygiene",
      "redos",
      "schema",
    ]);
  });

  it("runs only the classes asked for", async () => {
    const findings = checkSpec(await resolve(kitchenSink()), { only: ["hygiene", "redos"] });
    expect([...new Set(findings.map((f) => f.class))].sort()).toEqual(["hygiene", "redos"]);
  });

  // The hygiene class is recomputed rather than read off
  // `ResolvedSpec.specHygieneIssues`, so that `only` is the single
  // switch that decides whether it runs. Were it read, a spec loaded
  // without `lint: true` would answer this with an empty array and no
  // error, which is the silent-wrong-answer this arrangement avoids.
  it("reports hygiene from a spec loaded without lint", async () => {
    const resolved = await resolve(kitchenSink());
    expect(resolved.specHygieneIssues).toEqual([]);
    const findings = checkSpec(resolved, { only: ["hygiene"] });
    expect(codesOf(findings)).toEqual(["path-param-undeclared", "unused-component"]);
  });

  it("applies a severity map across all three key spaces", async () => {
    const severity = parseSeverityMap(["redos=error,unsatisfiable/*=fatal,unused-component=error"]);
    const findings = checkSpec(await resolve(kitchenSink()), { severity });
    const at = (code: string): string | undefined =>
      findings.find((f) => f.code === code)?.severity;
    expect(at("unused-component")).toBe("error");
    expect(at("ambiguous-pattern")).toBe("error");
    expect(at("unsatisfiable/pattern-length")).toBe("fatal");
    // Untouched by any of the three keys.
    expect(at("example-invalid")).toBe("warning");
  });

  describe("provenance", () => {
    it("attributes each finding to the file it came from", async () => {
      const findings = checkSpec(await resolve(kitchenSink()));
      const byCode = new Map(findings.map((f) => [f.code, f]));
      // A defect written in the referenced file is attributed there, not
      // to the entry that reached it.
      expect(byCode.get("ambiguous-pattern")?.target?.source?.uri).toBe("shared.json");
      expect(byCode.get("unused-component")?.target?.source?.uri).toBe("entry.json");
    });

    // Documented rather than refused: `ResolvedSpec.regions` is optional
    // and `sourceOf` already says a caller tells "no source node" from
    // "no regions recorded" by whether regions were handed over. This
    // pins the consequence so it is a known shape rather than a surprise.
    it("leaves source absent when the spec was resolved without it", async () => {
      const resolved = await resolve(kitchenSink(), { provenance: false });
      expect(resolved.regions).toBeUndefined();
      const findings = checkSpec(resolved);
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) expect(finding.target?.source).toBeUndefined();
    });

    it("finds the same defects either way", async () => {
      const withIt = checkSpec(await resolve(kitchenSink()));
      const without = checkSpec(await resolve(kitchenSink(), { provenance: false }));
      expect(codesOf(without)).toEqual(codesOf(withIt));
    });
  });

  describe("a schema that will not compile", () => {
    // The document is still graded and the report is still complete, so
    // this is a finding rather than a throw. The CLI reads exit 4 back
    // off the array rather than being told separately.
    it("reports it as a fatal finding rather than throwing", async () => {
      const findings = checkSpec(await resolve(malformedSpec(), { entry: "spec.json" }));
      const fatal = findings.filter((f) => f.class === "malformed");
      expect(fatal).toHaveLength(1);
      expect(fatal[0]?.severity).toBe("fatal");
      expect(fatal[0]?.code).toBe("malformed-schema");
    });

    // The one thing a severity map may not touch, because the exit code
    // tracks the class and a half-applied remap would look like it worked.
    it("stays fatal under a severity map", async () => {
      const severity = parseSeverityMap(["schema=warning"]);
      const findings = checkSpec(await resolve(malformedSpec(), { entry: "spec.json" }), {
        severity,
      });
      expect(findings.find((f) => f.class === "malformed")?.severity).toBe("fatal");
    });
  });

  // Distinct from a malformed schema: nothing survives building the
  // validator, so there is no partial report to hand back. A document
  // that resolves as JSON but is not an OpenAPI document at all is the
  // reachable case; the CLI turns this into exit 2, alongside a
  // document it could not read.
  describe("a document that cannot be graded at all", () => {
    const notOpenApi: Array<[string, unknown]> = [
      ["entry.json", { info: { title: "Not a spec", version: "1.0.0" }, paths: {} }],
    ];

    it("throws CheckAbortedError rather than returning a partial report", async () => {
      const resolved = await resolve(notOpenApi);
      expect(() => checkSpec(resolved)).toThrow(CheckAbortedError);
    });

    it("keeps the underlying message and cause", async () => {
      const resolved = await resolve(notOpenApi);
      try {
        checkSpec(resolved);
        expect.unreachable("checkSpec should have aborted");
      } catch (err) {
        expect(err).toBeInstanceOf(CheckAbortedError);
        expect((err as Error).message).toMatch(/expected an OpenAPI 3\.x document/);
        expect((err as Error).cause).toBeInstanceOf(Error);
      }
    });

    // Only the schema class builds a validator, so a run that does not
    // select it still reports what it can.
    it("does not abort when the schema class was not selected", async () => {
      const resolved = await resolve(notOpenApi);
      expect(() => checkSpec(resolved, { only: ["hygiene"] })).not.toThrow();
    });
  });
});
