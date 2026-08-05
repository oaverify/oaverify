/**
 * Byte-for-byte pins on what `check` prints, across every output format
 * and every flag that changes the report.
 *
 * The rest of the suite asserts that a finding is present, or that one
 * field holds one value, which is what a test should normally do. None
 * of that catches a reordering, a dropped blank line, a `source` that
 * stopped being attached, or a SARIF property that silently changed
 * shape. The JSON and SARIF formats are machine-consumed contracts: a
 * script parsing `--format json` or an upload to code scanning breaks
 * on exactly the changes field assertions let through. These files make
 * that churn visible in review, so it happens on purpose or not at all.
 *
 * Captured at `e251b65` for the move of the check logic into
 * `@oaverify/check` (#572), where the correct number of golden changes
 * was zero. The suite outlives the move because the output contract
 * does. Regenerate with `UPDATE_GOLDEN=1 pnpm vitest run
 * packages/cli/test/check-golden.test.ts`, and treat a diff as a
 * question to answer rather than a file to refresh: a text wording
 * change is fine once it is intended, and a JSON or SARIF shape change
 * is a compatibility decision.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CheckClass, CheckSeverity } from "@oaverify/check";
import { checkCommand } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";
// Shared with packages/check/test/check.test.ts, which grades the same
// documents through checkSpec directly, so the two sides of the seam
// are exercised on the same input.
import { kitchenSink, malformedSpec } from "../../check/test/fixtures.js";

const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));
const updating = process.env["UPDATE_GOLDEN"] === "1";

/**
 * Compare against the committed golden, or rewrite it when explicitly
 * asked. Failure prints the diff vitest already renders for two strings,
 * which is what makes a wording change readable in the report.
 */
function expectGolden(name: string, actual: string): void {
  const path = `${goldenDir}${name}`;
  if (updating) {
    writeFileSync(path, actual);
    return;
  }
  let expected: string;
  try {
    expected = readFileSync(path, "utf8");
  } catch {
    throw new Error(`missing golden ${name}; run with UPDATE_GOLDEN=1 to create it`);
  }
  expect(actual).toBe(expected);
}

const textOpts = { out: undefined } as unknown as Parameters<typeof checkCommand>[0]["options"];

/** Run `check` and hand back everything a caller could observe. */
async function run(
  entries: Array<[string, unknown]>,
  args: {
    only?: CheckClass[];
    failOn?: CheckSeverity;
    severity?: readonly string[];
    skip?: readonly string[];
    findings?: string;
    format?: "text" | "json" | "sarif";
    spec?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = memoryIo(entries);
  const result = await checkCommand(
    {
      spec: args.spec ?? "entry.json",
      overlays: [],
      ...(args.only !== undefined && { only: args.only }),
      ...(args.failOn !== undefined && { failOn: args.failOn }),
      ...(args.severity !== undefined && { severity: args.severity }),
      ...(args.skip !== undefined && { skip: args.skip }),
      ...(args.findings !== undefined && { findings: args.findings }),
      ...(args.format !== undefined && { format: args.format }),
      // Pinned so SARIF paths do not depend on where the suite ran, and
      // so the tool version in the log is stable across releases.
      version: "0.0.0-golden",
      cwd: "/repo",
      options: textOpts,
    },
    io,
  );
  return { exitCode: result.exitCode, stdout: stdout.value, stderr: stderr.value };
}

describe("check output is byte-identical (#572)", () => {
  it("all classes, default grading, text", async () => {
    const { exitCode, stdout, stderr } = await run(kitchenSink());
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expectGolden("all-classes.text", stdout);
  });

  it("all classes, default grading, json", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { format: "json" });
    expect(exitCode).toBe(0);
    expectGolden("all-classes.json", stdout);
  });

  it("all classes, default grading, sarif", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { format: "sarif" });
    expect(exitCode).toBe(0);
    expectGolden("all-classes.sarif", stdout);
  });

  it("a class subset", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { findings: "hygiene,redos" });
    expect(exitCode).toBe(0);
    expectGolden("findings-hygiene-redos.text", stdout);
  });

  it("a class subset is named in the sarif run properties", async () => {
    const { stdout } = await run(kitchenSink(), { findings: "hygiene", format: "sarif" });
    expectGolden("findings-hygiene.sarif", stdout);
  });

  it("--severity remaps across all three key spaces", async () => {
    // A class key, a family key, and an exact code key in one run, so
    // the precedence order is pinned and not just the lookup.
    const { exitCode, stdout } = await run(kitchenSink(), {
      severity: ["redos=error,unsatisfiable/*=fatal,unused-component=error"],
      format: "json",
    });
    expect(exitCode).toBe(0);
    expectGolden("severity-three-spaces.json", stdout);
  });

  it("--severity rejects an unknown key before reading the document", async () => {
    const { exitCode, stdout, stderr } = await run(kitchenSink(), { severity: ["nonsense=error"] });
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    expectGolden("severity-bad-key.stderr", stderr);
  });

  it("--fail-on warning fires on any finding", async () => {
    const { exitCode } = await run(kitchenSink(), { failOn: "warning" });
    expect(exitCode).toBe(1);
  });

  it("--fail-on error ignores warnings and fires on the spec violations", async () => {
    const { exitCode } = await run(kitchenSink(), { failOn: "error" });
    expect(exitCode).toBe(1);
  });

  it("--fail-on fatal does not fire when nothing is fatal", async () => {
    const { exitCode } = await run(kitchenSink(), { failOn: "fatal" });
    expect(exitCode).toBe(0);
  });

  it("a malformed schema is graded, printed, and exits 4", async () => {
    const { exitCode, stdout } = await run(malformedSpec(), { spec: "spec.json" });
    expect(exitCode).toBe(4);
    expectGolden("malformed.text", stdout);
  });

  it("a malformed schema outranks --fail-on", async () => {
    const { exitCode } = await run(malformedSpec(), { spec: "spec.json", failOn: "fatal" });
    expect(exitCode).toBe(4);
  });

  it("an unreadable document exits 2 with nothing on stdout", async () => {
    const { exitCode, stdout, stderr } = await run(kitchenSink(), { spec: "missing.json" });
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expectGolden("unreadable.stderr", stderr);
  });

  it("an exclusion drops a code and says what it dropped, text", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { findings: "-unused-component" });
    expect(exitCode).toBe(0);
    expectGolden("findings-exclude-code.text", stdout);
  });

  it("reports an exclusion that matched nothing", async () => {
    // A stale CI flag suppressing a code that no longer fires is the
    // case the report exists for.
    const { stdout } = await run(kitchenSink(), { findings: "-ambiguous-pattern,-unused-tag" });
    expectGolden("findings-zero-count.text", stdout);
  });

  it("puts a skipped block in the json report", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "-unsatisfiable/*,-unused-component",
      format: "json",
    });
    expect(exitCode).toBe(0);
    expectGolden("findings-two-exclusions.json", stdout);
  });

  it("records a run notification in sarif, and no suppressed results", async () => {
    const { stdout } = await run(kitchenSink(), { findings: "-unused-component", format: "sarif" });
    expectGolden("findings-exclude-code.sarif", stdout);
  });

  it("include and exclude compose with --severity", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "hygiene,redos,-unused-component",
      severity: ["redos=error"],
      format: "json",
    });
    expect(exitCode).toBe(0);
    expectGolden("findings-with-severity.json", stdout);
  });

  it("an excluded finding gates on nothing", async () => {
    // Not produced, so --fail-on cannot see it. Skipping every finding
    // a gate would have fired on turns a red run green, which is why
    // the report above is not optional.
    const before = await run(kitchenSink(), { failOn: "error" });
    expect(before.exitCode).toBe(1);
    const after = await run(kitchenSink(), {
      failOn: "error",
      findings: "-hygiene,-conformance,-examples",
    });
    expect(after.exitCode).toBe(0);
  });

  it("rejects an unknown key before reading the document", async () => {
    const { exitCode, stdout, stderr } = await run(kitchenSink(), { findings: "-nonsense" });
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    expectGolden("findings-bad-key.stderr", stderr);
  });

  it("a clean document says so", async () => {
    const clean: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "Clean", version: "1.0.0" },
          paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
        },
      ],
    ];
    const { exitCode, stdout } = await run(clean);
    expect(exitCode).toBe(0);
    expectGolden("clean.text", stdout);
  });
});

describe("--findings (#661)", () => {
  it("an inclusion selects, and reports a term that selected nothing new", async () => {
    // Case 1 of the acceptance table: the code is already inside the
    // class, so deleting it would change nothing.
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "schema,redos,unsatisfiable/pattern-length",
    });
    expect(exitCode).toBe(0);
    expectGolden("findings-include-redundant.text", stdout);
  });

  it("an exclusion outside the selected base is a no-op, not a zero count", async () => {
    // Case 2. `-redos` cannot drop anything from a schema base, and
    // saying so is different from saying it dropped zero: the second is
    // how a suppression that has gone stale announces itself.
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "schema,-redos,unsatisfiable/pattern-length",
    });
    expect(exitCode).toBe(0);
    expectGolden("findings-exclusion-outside-base.text", stdout);
  });

  it("reads the same whichever order the terms are written in", async () => {
    // Case 5, the one the acceptance table calls the trap. A left-to-
    // right reading would make these differ by every non-schema finding.
    const forward = await run(kitchenSink(), {
      findings: "schema,-unsatisfiable/pattern-length",
    });
    const reversed = await run(kitchenSink(), {
      findings: "-unsatisfiable/pattern-length,schema",
    });
    expect(reversed.stdout).toBe(forward.stdout);
    expectGolden("findings-order-independent.text", forward.stdout);
  });

  it("narrows below a class", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { findings: "unused-component" });
    expect(exitCode).toBe(0);
    expectGolden("findings-one-code.text", stdout);
  });

  it("carries the terms into the json report", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "-format-not-validated,-schema",
      format: "json",
    });
    expect(exitCode).toBe(0);
    expectGolden("findings-json.json", stdout);
  });

  it("excludes a class and still exits 4 on a malformed schema", async () => {
    // The guarantee that decides the whole design: an exclusion is
    // post-run suppression, so the compile still happens and the fatal
    // finding still lands. Only declining to select the pass loses it.
    const { exitCode, stdout } = await run(malformedSpec(), {
      spec: "spec.json",
      findings: "-schema",
    });
    expect(exitCode).toBe(4);
    expectGolden("findings-exclude-schema-malformed.text", stdout);
  });

  it("does not find a malformed schema when nothing selected a compiled code", async () => {
    // The one place the guarantee is conditional: `malformed` is lost by
    // not asking for the pass that finds it, never by excluding it.
    const { exitCode, stdout } = await run(malformedSpec(), {
      spec: "spec.json",
      findings: "hygiene",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("no findings");
  });

  it("refuses malformed as a term, in either polarity", async () => {
    for (const findings of ["malformed", "-malformed", "malformed-schema", "-malformed-schema"]) {
      const { exitCode, stderr } = await run(malformedSpec(), { spec: "spec.json", findings });
      expect(exitCode).toBe(3);
      expect(stderr).toContain("cannot be selected or excluded");
    }
  });

  it("refuses an empty value rather than reading it as everything", async () => {
    const { exitCode, stdout, stderr } = await run(kitchenSink(), { findings: "  " });
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    expectGolden("findings-empty.stderr", stderr);
  });

  it("names --findings in sarif, and carries the no-op terms", async () => {
    // The report echoes the term as written, sign included, so a reader
    // fixing a CI configuration can match a line back to what they typed.
    // `-hygiene` is live and `-unused-tag` is already covered by it, so
    // one notification of each kind appears. (`-redos,-ambiguous-pattern`
    // would cover each other, and which of a mutual pair is called
    // redundant depends on the order written.)
    const { exitCode, stdout } = await run(kitchenSink(), {
      findings: "-hygiene,-unused-tag",
      format: "sarif",
    });
    expect(exitCode).toBe(0);
    const log = JSON.parse(stdout) as {
      runs: { invocations?: { toolExecutionNotifications: { message: { text: string } }[] }[] }[];
    };
    const notes = (log.runs[0]?.invocations?.[0]?.toolExecutionNotifications ?? []).map(
      (n) => n.message.text,
    );
    expect(notes[0]).toContain("--findings -hygiene suppressed 2 finding(s)");
    expect(notes[1]).toContain("--findings -unused-tag changed nothing");
    expectGolden("findings-sarif.sarif", stdout);
  });
});
