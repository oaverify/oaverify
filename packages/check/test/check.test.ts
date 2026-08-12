import { createMemoryReader, loadSpec, type ResolvedSpec } from "@oaverify/internal-spec";
import { describe, expect, it } from "vitest";
import { CheckAbortedError, checkSpec } from "../src/check.js";
import { parseSeverityMap } from "../src/severity.js";
import type { CheckFinding } from "../src/finding.js";
// Shared with packages/cli/test/check-golden.test.ts, which grades the
// same documents through the CLI, so the two sides of the seam are
// exercised on the same input.
import { kitchenSink, malformedSpec } from "./fixtures.js";
import {
  parseFindingTerms,
  resolveFindingSelection,
  selectionForClasses,
} from "../src/selection.js";

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

  it("reports a malformed path template as a located hygiene error, not a throw", async () => {
    // #708: the router used to throw a raw URIError out of the validator
    // build, which surfaced as exit 2 with "check: URI malformed" and no
    // location. It is a graded finding now.
    const spec: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          paths: { "/bad%zz": { get: { responses: { "200": { description: "ok" } } } } },
        },
      ],
    ];
    const findings = checkSpec(await resolve(spec));
    const f = findings.find((x) => x.code === "path-template-malformed");
    expect(f).toBeDefined();
    expect(f?.class).toBe("hygiene");
    // A spec violation, so it grades as an error rather than a warning.
    expect(f?.severity).toBe("error");
    expect(f?.target?.pointer).toBe("/paths/~1bad%zz");
  });

  it("carries findings produced before an abort on the error", async () => {
    // #716. These two templates collide once the malformed escape is
    // taken literally, so createRouter throws and the check aborts. The
    // hygiene finding naming the bad escape is what explains why, and
    // used to be discarded with it.
    const spec: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          paths: {
            "/bad%zz": { get: { responses: { "200": { description: "ok" } } } },
            "/bad%25zz": { get: { responses: { "200": { description: "ok" } } } },
          },
        },
      ],
    ];
    const resolved = await resolve(spec);
    try {
      checkSpec(resolved);
      expect.unreachable("expected CheckAbortedError");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckAbortedError);
      const findings = (err as CheckAbortedError).findings;
      expect(findings.map((f) => f.code)).toContain("path-template-malformed");
      // Graded like a returned finding: provenance attached, not just
      // the raw hygiene issue.
      expect(findings[0]?.target?.source).toBeDefined();
    }
  });

  it("narrows and remaps findings carried on an abort, like a returned one", async () => {
    // Without this the abort path reports codes the selection excluded,
    // so running fewer checks would report more.
    const spec: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          paths: {
            "/bad%zz": { get: { responses: { "200": { description: "ok" } } } },
            "/bad%25zz": { get: { responses: { "200": { description: "ok" } } } },
          },
        },
      ],
    ];
    const resolved = await resolve(spec);

    // A selection naming a different hygiene code drops this one.
    try {
      checkSpec(resolved, {
        findings: resolveFindingSelection(parseFindingTerms("unused-tag")),
      });
      expect.unreachable("expected CheckAbortedError");
    } catch (err) {
      expect((err as CheckAbortedError).findings.map((f) => f.code)).not.toContain(
        "path-template-malformed",
      );
    }

    // And the caller's severity map applies.
    try {
      checkSpec(resolved, { severity: parseSeverityMap(["path-template-malformed=warning"]) });
      expect.unreachable("expected CheckAbortedError");
    } catch (err) {
      const f = (err as CheckAbortedError).findings.find(
        (x) => x.code === "path-template-malformed",
      );
      expect(f?.severity).toBe("warning");
    }
  });

  it("rethrows a hygiene lint failure when the document is otherwise gradeable", async () => {
    // The lint runs ahead of the gate, so its failure is held rather
    // than thrown. Holding it must not swallow it: a gradeable document
    // whose lint threw is a defect, not a clean report with an empty
    // hygiene section.
    const spec: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          // `parameters` must be an array; the lint iterates it. The
          // validator builds fine, so the document is gradeable.
          paths: {
            "/p": { get: { parameters: {}, responses: { "200": { description: "ok" } } } },
          },
        },
      ],
    ];
    const resolved = await resolve(spec);
    expect(() => checkSpec(resolved)).toThrow();
    expect(() => checkSpec(resolved)).not.toThrow(CheckAbortedError);
  });

  it("reports no findings on an abort when nothing had run", async () => {
    // The common case: a document that is not OpenAPI at all aborts with
    // nothing to say beyond the abort itself.
    const resolved = await resolve([["entry.json", { not: "openapi" }]]);
    try {
      checkSpec(resolved);
      expect.unreachable("expected CheckAbortedError");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckAbortedError);
      expect((err as CheckAbortedError).findings).toEqual([]);
    }
  });

  it("runs only the classes asked for", async () => {
    const findings = checkSpec(await resolve(kitchenSink()), {
      findings: selectionForClasses(["hygiene", "redos"]),
    });
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
    const findings = checkSpec(resolved, { findings: selectionForClasses(["hygiene"]) });
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

    // The gradeability gate is unconditional on the selection: before
    // #674 a hygiene-only run returned an empty report with exit 0 on a
    // document nothing could grade, which read as a clean bill.
    it("aborts even when the selection reaches no schema code", async () => {
      const resolved = await resolve(notOpenApi);
      expect(() => checkSpec(resolved, { findings: selectionForClasses(["hygiene"]) })).toThrow(
        CheckAbortedError,
      );
    });
  });
});

describe("examples pass under a catastrophic pattern (#687)", () => {
  // The beezup shape: an ambiguous pattern beside an example that does
  // not match it. Without the guard this test does not fail, it hangs;
  // completing under vitest's timeout is the load-bearing assertion.
  const AMBIGUOUS = "^(https?:\\/\\/)?([\\da-z\\.-]+)\\.([a-z\\.]{2,6})([\\/\\w \\.-]*)*\\/?$";
  const spec = {
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
    paths: {
      "/things": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "string", pattern: AMBIGUOUS },
                example: "https://www.example.com/avatar/205e460b479e2e5b48aec07710c08d50?d=mm",
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("reports the example uncheckable and the pattern ambiguous, and terminates", async () => {
    const resolved = await resolve([["entry.json", spec]]);
    const findings = checkSpec(resolved);
    const uncheckable = findings.filter((f) => f.code === "example-uncheckable");
    expect(uncheckable).toHaveLength(1);
    expect(uncheckable[0]?.message).toContain("superlinear");
    expect(findings.some((f) => f.code === "ambiguous-pattern")).toBe(true);
  });

  it("stays protected when only the examples class is selected", async () => {
    const resolved = await resolve([["entry.json", spec]]);
    const findings = checkSpec(resolved, { findings: selectionForClasses(["examples"]) });
    expect(findings.some((f) => f.code === "example-uncheckable")).toBe(true);
    expect(findings.some((f) => f.code === "ambiguous-pattern")).toBe(false);
  });
});

describe("null path items and operations", () => {
  // `/b:` with nothing under it is `null` in YAML, and `null` passed the
  // router's `!== undefined` presence check. Building the route table
  // threw a raw TypeError, which `checkSpec` surfaced as CheckAbortedError
  // with a V8 message and no location, so the conformance pass that would
  // have located it never ran (#794).
  it("locates a null path item instead of aborting", async () => {
    const resolved = await resolve([
      [
        "entry.json",
        { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/b": null } },
      ],
    ]);
    const findings = checkSpec(resolved);
    const conformance = findings.filter((f) => f.class === "conformance");
    expect(conformance.map((f) => f.location)).toEqual(["/paths/~1b"]);
    expect(findings.some((f) => f.class === "malformed")).toBe(false);
  });

  // `{get: null}` counted as a declaration, so a null operation reached
  // the compile path and its TypeError became the *message* of a
  // malformed-schema finding, putting raw V8 text on the JSON and SARIF
  // contracts.
  it("does not put a raw TypeError in a finding message", async () => {
    const resolved = await resolve([
      [
        "entry.json",
        { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/b": { get: null } } },
      ],
    ]);
    const findings = checkSpec(resolved);
    expect(findings.some((f) => f.class === "malformed")).toBe(false);
    expect(findings.some((f) => /Cannot read properties of/.test(f.message))).toBe(false);
    expect(findings.filter((f) => f.class === "conformance").map((f) => f.location)).toEqual([
      "/paths/~1b/get",
    ]);
  });
});

describe("null entries inside an operation", () => {
  // Same defect as a null Operation, one level down: a `- ` list entry
  // with nothing under it is `null`, `resolveRef` returns it unchanged,
  // and the `=== undefined` guard let it through to `.in` (#794).
  it("does not put a raw TypeError in a finding for a null parameter", async () => {
    const resolved = await resolve([
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          paths: { "/b": { get: { parameters: [null], responses: {} } } },
        },
      ],
    ]);
    const findings = checkSpec(resolved);
    expect(findings.some((f) => /Cannot read properties of/.test(f.message))).toBe(false);
    expect(findings.some((f) => f.class === "malformed")).toBe(false);
  });

  // `'200':` with nothing under it, reaching `.content`.
  it("does not put a raw TypeError in a finding for a null response", async () => {
    const resolved = await resolve([
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "t", version: "1" },
          paths: { "/b": { get: { responses: { "200": null } } } },
        },
      ],
    ]);
    const findings = checkSpec(resolved);
    expect(findings.some((f) => /Cannot read properties of/.test(f.message))).toBe(false);
    expect(findings.some((f) => f.class === "malformed")).toBe(false);
  });
});
