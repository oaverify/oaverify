/**
 * Byte-for-byte pins on what `check` prints, across every output format
 * and every flag that changes the report.
 *
 * These exist for the move of the check logic into `@oaverify/check`
 * (#572). The rest of the suite asserts that a finding is present, or
 * that one field holds one value, which is what a test should normally
 * do. None of that catches a reordering, a dropped blank line, a
 * `source` that stopped being attached, or a SARIF property that
 * silently changed shape, and a consumer pinned at 5.3 sees all four.
 *
 * The goldens are captured from the behaviour at `e251b65`, before any
 * code moved. Regenerate with `UPDATE_GOLDEN=1 pnpm vitest run
 * packages/cli/test/check-golden.test.ts`, and treat a diff as a
 * question to answer rather than a file to refresh: during the #572
 * move the correct number of golden changes is zero.
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

  it("--only subset", async () => {
    const { exitCode, stdout } = await run(kitchenSink(), { only: ["hygiene", "redos"] });
    expect(exitCode).toBe(0);
    expectGolden("only-hygiene-redos.text", stdout);
  });

  it("--only subset is named in the sarif run properties", async () => {
    const { stdout } = await run(kitchenSink(), { only: ["hygiene"], format: "sarif" });
    expectGolden("only-hygiene.sarif", stdout);
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
