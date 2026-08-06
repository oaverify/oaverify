/**
 * Runner for the JSON Schema 2020-12 Test Suite.
 *
 * Clones of that repo live under ./JSON-Schema-Test-Suite (gitignored).
 * This script walks `tests/draft2020-12/*.json` (and optionally
 * `tests/draft2020-12/optional/*.json`), compiles each group's schema
 * with @oaverify/internal-schema, runs each case's data, and reports:
 *
 *   - total cases attempted
 *   - pass (our verdict matches `valid`)
 *   - fail (verdict mismatch)
 *   - error (compile/runtime crash — we couldn't produce a verdict)
 *   - a per-file breakdown with concrete mismatches listed
 *
 * Usage:
 *   pnpm tsx conformance/run-json-schema-suite.ts                 # required suite
 *   pnpm tsx conformance/run-json-schema-suite.ts --optional      # + optional suite
 *   pnpm tsx conformance/run-json-schema-suite.ts --filter=type   # only files matching "type"
 *   pnpm tsx conformance/run-json-schema-suite.ts --check-baseline
 *     # exits non-zero if the current run's pass count drops below
 *     # the one recorded in the committed results file. Used in CI to
 *     # catch regressions without failing on any single mismatch.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { assertPinned, corpusPath } from "./corpora.ts";
import { enterFloating, exitFloating } from "./floating.ts";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import { builtInFormats } from "../packages/formats/src/index.ts";

interface Case {
  description: string;
  data: unknown;
  valid: boolean;
}
interface Group {
  description: string;
  schema: unknown;
  tests: Case[];
}
interface FileResult {
  file: string;
  groups: number;
  cases: number;
  pass: number;
  fail: number;
  error: number;
  mismatches: Array<{
    group: string;
    test: string;
    data: unknown;
    expected: boolean;
    actual: boolean | "error";
    reason?: string;
  }>;
}

const SUITE = "JSON-Schema-Test-Suite";
const SUITE_ROOT = corpusPath(SUITE);
const TESTS_DIR = join(SUITE_ROOT, "tests", "draft2020-12");
const REMOTES_DIR = join(SUITE_ROOT, "remotes");
const REMOTE_BASE = "http://localhost:1234";

const args = new Set(process.argv.slice(2));
const checkBaseline = args.has("--check-baseline");
// See floating.ts: the nightly runs this against upstream HEAD, where the
// strict pass-count ratchet cannot tell a regression from new cases.
const floating = args.has("--floating");
const includeOptional = args.has("--optional");
const filterArg = process.argv.slice(2).find((a) => a.startsWith("--filter="));
const filterPattern = filterArg?.slice("--filter=".length);

// Baselines were measured at the pin in corpora.json; refuse to report
// numbers from a different revision. A floating run accepts any revision
// but validates the flag combination and the checkout instead.
if (floating) enterFloating(SUITE, { checkBaseline, filtered: filterPattern !== undefined });
else assertPinned(SUITE);

function loadRemoteSchemas(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, `${prefix}/${entry}`);
      else if (entry.endsWith(".json")) {
        try {
          map.set(`${prefix}/${entry}`, JSON.parse(readFileSync(abs, "utf8")));
        } catch {
          // skip unparsable fixtures
        }
      }
    }
  };
  walk(REMOTES_DIR, REMOTE_BASE);
  return map;
}

const remoteSchemas = loadRemoteSchemas();

function listJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isFile() && entry.endsWith(".json")) out.push(p);
  }
  return out;
}

function runFile(path: string): FileResult {
  const groups = JSON.parse(readFileSync(path, "utf8")) as Group[];
  const result: FileResult = {
    file: basename(path),
    groups: groups.length,
    cases: 0,
    pass: 0,
    fail: 0,
    error: 0,
    mismatches: [],
  };
  for (const group of groups) {
    let validate: ((data: unknown) => { valid: boolean }) | undefined;
    try {
      const compiled = compileSchema(group.schema as never, {
        dialect: jsonSchemaDialect,
        formats: builtInFormats,
        external: remoteSchemas as Map<string, never>,
      });
      validate = compiled.validate;
    } catch (err) {
      for (const t of group.tests) {
        result.cases += 1;
        result.error += 1;
        result.mismatches.push({
          group: group.description,
          test: t.description,
          data: t.data,
          expected: t.valid,
          actual: "error",
          reason: `compile: ${(err as Error).message}`,
        });
      }
      continue;
    }
    for (const t of group.tests) {
      result.cases += 1;
      let actual: boolean | "error";
      let reason: string | undefined;
      try {
        actual = validate(t.data).valid;
      } catch (err) {
        actual = "error";
        reason = `runtime: ${(err as Error).message}`;
      }
      if (actual === t.valid) {
        result.pass += 1;
      } else {
        if (actual === "error") result.error += 1;
        else result.fail += 1;
        result.mismatches.push({
          group: group.description,
          test: t.description,
          data: t.data,
          expected: t.valid,
          actual,
          reason,
        });
      }
    }
  }
  return result;
}

function matches(filename: string): boolean {
  if (filterPattern === undefined) return true;
  return filename.includes(filterPattern);
}

const files: string[] = [];
for (const f of listJsonFiles(TESTS_DIR)) if (matches(basename(f))) files.push(f);
if (includeOptional) {
  const optDir = join(TESTS_DIR, "optional");
  try {
    for (const f of listJsonFiles(optDir)) if (matches(basename(f))) files.push(f);
  } catch {
    // optional directory is missing — that's fine
  }
}

const results: FileResult[] = [];
for (const f of files) results.push(runFile(f));

let totalCases = 0;
let totalPass = 0;
let totalFail = 0;
let totalError = 0;
for (const r of results) {
  totalCases += r.cases;
  totalPass += r.pass;
  totalFail += r.fail;
  totalError += r.error;
}

// Print terse table, plus the per-file breakdown at the end.
console.log("file".padEnd(40) + "pass  fail  error  total");
console.log("-".repeat(70));
for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
  const line =
    r.file.padEnd(40) +
    String(r.pass).padStart(4) +
    String(r.fail).padStart(6) +
    String(r.error).padStart(7) +
    String(r.cases).padStart(7);
  console.log(line);
}
console.log("-".repeat(70));
console.log(
  "TOTAL".padEnd(40) +
    String(totalPass).padStart(4) +
    String(totalFail).padStart(6) +
    String(totalError).padStart(7) +
    String(totalCases).padStart(7) +
    `    (${((100 * totalPass) / Math.max(totalCases, 1)).toFixed(1)}%)`,
);

// Drop a JSON summary for the "flag inconsistencies" workflow.
const summaryPath = resolve(
  new URL(".", import.meta.url).pathname,
  `json-schema-results${includeOptional ? "-with-optional" : ""}.json`,
);
if (checkBaseline) {
  if (!existsSync(summaryPath)) {
    console.error(`--check-baseline: no committed results at ${summaryPath}`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(summaryPath, "utf8")) as FileResult[];
  if (floating) {
    const unit = (r: FileResult) => ({
      name: r.file,
      cases: r.cases,
      failures: r.fail + r.error,
    });
    exitFloating(
      includeOptional ? "suite + optional" : "required suite",
      SUITE,
      results.map(unit),
      baseline.map(unit),
    );
  }
  const baselinePass = baseline.reduce((n, r) => n + r.pass, 0);
  const baselineCases = baseline.reduce((n, r) => n + r.cases, 0);
  console.log(`\nbaseline: ${baselinePass}/${baselineCases} pass`);
  console.log(`current:  ${totalPass}/${totalCases} pass`);
  if (totalPass < baselinePass) {
    console.error(
      `FAIL: pass count regressed (${totalPass} < baseline ${baselinePass}). Inspect mismatches in ${summaryPath}.`,
    );
    process.exit(1);
  }
  console.log("OK: pass count meets or exceeds baseline.");
} else {
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nPer-file mismatches written to ${summaryPath}`);
}
