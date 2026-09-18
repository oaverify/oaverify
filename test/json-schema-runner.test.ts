import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceAliases } from "../workspace-aliases.ts";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "oaverify-schema-gate-"));
const suite = join(scratch, "JSON-Schema-Test-Suite");
const tests = join(suite, "tests/draft2020-12");
const baselinePath = join(scratch, "json-schema-results.json");
const runner = join(scratch, "runner.mjs");
const fixture = [
  {
    description: "same group",
    schema: { type: "number" },
    tests: [
      { description: "fixed", data: 1, valid: true },
      { description: "new failure", data: "wrong", valid: true },
    ],
  },
];
const baseline = [
  {
    file: "same.json",
    groups: 1,
    cases: 2,
    pass: 1,
    fail: 1,
    error: 0,
    mismatches: [{ group: "same group", test: "fixed", data: 1, expected: true, actual: false }],
  },
];

function run(...args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], { encoding: "utf8" });
}

beforeAll(() => {
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "same.json"), JSON.stringify(fixture));
  mkdirSync(join(tests, "optional"));
  writeFileSync(join(tests, "optional/same.json"), JSON.stringify(fixture));
  execFileSync("git", ["init", "--quiet", suite]);
  execFileSync("git", ["-C", suite, "add", "."]);
  execFileSync("git", [
    "-C",
    suite,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ]);
  const rev = execFileSync("git", ["-C", suite, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(scratch, "corpora.json"),
    JSON.stringify({ corpora: { "JSON-Schema-Test-Suite": { rev } } }),
  );
  buildSync({
    entryPoints: [join(root, "conformance/run-json-schema-suite.ts")],
    outfile: runner,
    bundle: true,
    platform: "node",
    format: "esm",
    alias: workspaceAliases(root),
    logLevel: "silent",
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("JSON Schema runner baseline gate", () => {
  it("fails an unchanged pass total with a new failure in the same file, without rewriting", () => {
    const contents = JSON.stringify(baseline);
    writeFileSync(baselinePath, contents);
    const measured = run("--check-baseline");
    expect(measured.status, measured.stderr).toBe(1);
    expect(measured.stdout).toContain("IMPROVED: same.json: same group / fixed: now passing");
    expect(measured.stderr).toContain("REGRESSED: same.json: same group / new failure");
    expect(readFileSync(baselinePath, "utf8")).toBe(contents);
  });

  it("keeps floating classification separate", () => {
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const measured = run("--check-baseline", "--floating");
    expect(measured.status, measured.stderr).toBe(0);
    expect(measured.stdout).toContain("OK: no regression against upstream HEAD.");
  });

  it("uses exit 2 for malformed and incompatible comparisons", () => {
    for (const contents of [
      "{",
      "null",
      "[]",
      JSON.stringify([{ ...baseline[0], cases: 3, pass: 2 }]),
    ]) {
      writeFileSync(baselinePath, contents);
      const measured = run("--check-baseline");
      expect(measured.status, measured.stderr).toBe(2);
      expect(readFileSync(baselinePath, "utf8")).toBe(contents);
    }
  });

  it("keeps filtered runs read-only and refuses partial baseline comparisons", () => {
    const contents = JSON.stringify(baseline);
    writeFileSync(baselinePath, contents);
    expect(run("--filter=same").status).toBe(0);
    expect(readFileSync(baselinePath, "utf8")).toBe(contents);
    expect(run("--check-baseline", "--filter=absent").status).toBe(2);
    expect(readFileSync(baselinePath, "utf8")).toBe(contents);
  });

  it("still writes a full measurement explicitly and accepts its known failures", () => {
    expect(run().status).toBe(0);
    const contents = readFileSync(baselinePath, "utf8");
    expect(JSON.parse(contents)[0].mismatches[0].test).toBe("new failure");
    const measured = run("--check-baseline");
    expect(measured.status, measured.stderr).toBe(0);
    expect(measured.stdout).toContain("OK: no new failing cases or error regressions.");
    expect(readFileSync(baselinePath, "utf8")).toBe(contents);
  });

  it("keeps required and optional files with the same basename distinct", () => {
    expect(run("--optional").status).toBe(0);
    const optionalPath = join(scratch, "json-schema-results-with-optional.json");
    const contents = readFileSync(optionalPath, "utf8");
    expect(JSON.parse(contents).map((r: { file: string }) => r.file)).toEqual([
      "optional/same.json",
      "same.json",
    ]);
    expect(run("--optional", "--check-baseline").status).toBe(0);
    expect(readFileSync(optionalPath, "utf8")).toBe(contents);
  });

  it("retains pin and floating-flag checks", () => {
    expect(run("--floating").status).toBe(2);
    expect(run("--floating", "--check-baseline", "--filter=same").status).toBe(2);
    const registry = join(scratch, "corpora.json");
    const contents = readFileSync(registry, "utf8");
    try {
      writeFileSync(
        registry,
        JSON.stringify({ corpora: { "JSON-Schema-Test-Suite": { rev: "wrong" } } }),
      );
      const measured = run("--check-baseline");
      expect(measured.status).toBe(2);
      expect(measured.stderr).toContain("checkout drifted from the pin");
    } finally {
      writeFileSync(registry, contents);
    }
  });
});
