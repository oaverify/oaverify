/**
 * Runner for the JSON Schema Test Suite's `optional/format` subtree.
 *
 * Separate from `run-json-schema-suite.ts` for one reason: `format` is
 * annotation-only under the default dialect, so that runner's
 * `--optional` pass reports every `"valid": false` format case as a
 * pass without asserting anything. 363 of these cases expect a
 * rejection, which is why a run under `jsonSchemaDialect` is not a
 * measurement. This one compiles with `openapi31Dialect`, where
 * `format` is an assertion, and reports the two directions separately:
 *
 *   - **false accept**: we allowed a value the format forbids. A
 *     missed catch.
 *   - **false reject**: we refused a value the format allows. Under
 *     the OpenAPI dialects this refuses live request and response
 *     traffic, so it is the more serious of the two.
 *
 * That split is the whole reason the report is worth having. A single
 * pass count hides which direction moved, and the two directions carry
 * different consequences.
 *
 * Also note this subtree does not recurse into the parent runner:
 * `optional/format/` is a directory, and `listJsonFiles` there is
 * non-recursive.
 *
 * Usage:
 *   pnpm format-suite                  # print the table, write the baseline
 *   pnpm format-suite --check-baseline # CI: fail if any format regressed
 *   pnpm format-suite --filter=uri     # only files matching "uri"
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compileSchema, openapi31Dialect } from "../packages/schema/src/index.ts";
import { builtInFormats } from "../packages/formats/src/index.ts";
import { assertPinned, corpusPath } from "./corpora.ts";
import { classifyFloating, reportFloating } from "./floating.ts";

const SUITE = "JSON-Schema-Test-Suite";
const FORMAT_DIR = join(corpusPath(SUITE), "tests", "draft2020-12", "optional", "format");

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
interface Mismatch {
  group: string;
  test: string;
  data: unknown;
  /** `"false-accept"` we allowed the forbidden; `"false-reject"` we refused the allowed. */
  direction: "false-accept" | "false-reject";
  reason?: string;
}
interface FormatResult {
  /** The format name, which is also the file's basename. */
  format: string;
  cases: number;
  pass: number;
  falseAccept: number;
  falseReject: number;
  error: number;
  mismatches: Mismatch[];
}

const argv = process.argv.slice(2);
const checkBaseline = argv.includes("--check-baseline");
// `--floating` is for the nightly, which fetches upstream HEAD rather than
// the pin. It skips the pin assertion and swaps the strict ratchet for the
// grew-vs-broke classification in floating.ts, because against a moving
// corpus "more failures than the baseline" has two very different causes.
const floating = argv.includes("--floating");
const filterPattern = argv.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);

function runFile(path: string): FormatResult {
  const groups = JSON.parse(readFileSync(path, "utf8")) as Group[];
  const result: FormatResult = {
    format: basename(path, ".json"),
    cases: 0,
    pass: 0,
    falseAccept: 0,
    falseReject: 0,
    error: 0,
    mismatches: [],
  };
  for (const group of groups) {
    let validate: ((data: unknown) => boolean) | undefined;
    let compileError: string | undefined;
    try {
      validate = compileSchema(group.schema as never, {
        dialect: openapi31Dialect,
        formats: builtInFormats,
        output: "predicate",
      }).validate;
    } catch (err) {
      compileError = `compile: ${(err as Error).message}`;
    }
    for (const t of group.tests) {
      result.cases += 1;
      if (validate === undefined) {
        result.error += 1;
        result.mismatches.push({
          group: group.description,
          test: t.description,
          data: t.data,
          direction: t.valid ? "false-reject" : "false-accept",
          reason: compileError,
        });
        continue;
      }
      let actual: boolean;
      try {
        actual = validate(t.data);
      } catch (err) {
        result.error += 1;
        result.mismatches.push({
          group: group.description,
          test: t.description,
          data: t.data,
          direction: t.valid ? "false-reject" : "false-accept",
          reason: `runtime: ${(err as Error).message}`,
        });
        continue;
      }
      if (actual === t.valid) {
        result.pass += 1;
        continue;
      }
      if (actual) result.falseAccept += 1;
      else result.falseReject += 1;
      result.mismatches.push({
        group: group.description,
        test: t.description,
        data: t.data,
        direction: actual ? "false-accept" : "false-reject",
      });
    }
  }
  return result;
}

if (!floating) assertPinned(SUITE);

const files = readdirSync(FORMAT_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => join(FORMAT_DIR, f))
  .filter((p) => statSync(p).isFile())
  .filter((p) => filterPattern === undefined || basename(p).includes(filterPattern))
  .sort();

const results = files.map(runFile);

const total = results.reduce(
  (acc, r) => ({
    cases: acc.cases + r.cases,
    pass: acc.pass + r.pass,
    falseAccept: acc.falseAccept + r.falseAccept,
    falseReject: acc.falseReject + r.falseReject,
    error: acc.error + r.error,
  }),
  { cases: 0, pass: 0, falseAccept: 0, falseReject: 0, error: 0 },
);

const row = (
  format: string,
  r: { cases: number; pass: number; falseAccept: number; falseReject: number },
) =>
  format.padEnd(24) +
  String(r.cases).padStart(6) +
  String(r.pass).padStart(6) +
  String(r.falseAccept).padStart(14) +
  String(r.falseReject).padStart(14);

console.log(
  "format".padEnd(24) +
    "cases".padStart(6) +
    "pass".padStart(6) +
    "false-accept".padStart(14) +
    "false-reject".padStart(14),
);
console.log("-".repeat(64));
for (const r of results) console.log(row(r.format, r));
console.log("-".repeat(64));
console.log(
  row("TOTAL", total) + `    (${((100 * total.pass) / Math.max(total.cases, 1)).toFixed(1)}%)`,
);

const summaryPath = resolve(new URL(".", import.meta.url).pathname, "format-results.json");

if (!checkBaseline) {
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nPer-format mismatches written to ${summaryPath}`);
  process.exit(0);
}

if (!existsSync(summaryPath)) {
  console.error(`--check-baseline: no committed results at ${summaryPath}`);
  process.exit(2);
}

// Per-format, not just on the total: a fix in one format must not pay
// for a regression in another. A format the baseline does not mention
// is new upstream coverage and is held to zero.
const baseline = JSON.parse(readFileSync(summaryPath, "utf8")) as FormatResult[];

if (floating) {
  const unit = (r: FormatResult) => ({
    name: r.format,
    cases: r.cases,
    failures: r.falseAccept + r.falseReject + r.error,
  });
  const rev = execFileSync("git", ["-C", corpusPath(SUITE), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  process.exit(
    reportFloating("optional/format", classifyFloating(results.map(unit), baseline.map(unit)), rev),
  );
}
const byFormat = new Map(baseline.map((r) => [r.format, r]));
const regressions: string[] = [];
for (const r of results) {
  const was = byFormat.get(r.format) ?? {
    format: r.format,
    cases: 0,
    pass: 0,
    falseAccept: 0,
    falseReject: 0,
    error: 0,
    mismatches: [],
  };
  if (r.falseAccept > was.falseAccept)
    regressions.push(`  ${r.format}: false accepts ${was.falseAccept} -> ${r.falseAccept}`);
  if (r.falseReject > was.falseReject)
    regressions.push(`  ${r.format}: false rejects ${was.falseReject} -> ${r.falseReject}`);
  if (r.error > was.error) regressions.push(`  ${r.format}: errors ${was.error} -> ${r.error}`);
}

const baseTotal = baseline.reduce((n, r) => n + r.pass, 0);
console.log(`\nbaseline: ${baseTotal} pass`);
console.log(`current:  ${total.pass} pass`);

if (regressions.length > 0) {
  console.error(`FAIL: format conformance regressed.\n${regressions.join("\n")}`);
  console.error(`Re-run without --check-baseline to refresh ${summaryPath}.`);
  process.exit(1);
}
if (total.pass > baseTotal) {
  console.error(
    `FAIL: ${total.pass - baseTotal} case(s) now pass that the baseline records as failing.\n` +
      `This is good news the baseline has not been told about. Re-run without --check-baseline to ratchet it.`,
  );
  process.exit(1);
}
console.log("OK: no format regressed.");
