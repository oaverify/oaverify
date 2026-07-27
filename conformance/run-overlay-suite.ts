/**
 * Runner for the OpenAPI Overlay 1.0 Test Suite.
 *
 * Clones of the upstream repo live under ./Overlay-Specification
 * (gitignored). This script:
 *
 *   1. Loads the canonical overlay JSON Schema from
 *      `Overlay-Specification/schemas/v1.0/schema.yaml`, compiles it
 *      through `@oaverify/internal-schema`, and uses the compiled validator as our
 *      envelope check.
 *   2. Walks `tests/v1.0/pass/*.yaml` and `tests/v1.0/fail/*.yaml`,
 *      asserting that pass fixtures validate and fail fixtures do not.
 *      This is the parity surface we share with the upstream
 *      `matchJsonSchema`-driven Vitest runner.
 *   3. As an informational layer, every pass fixture is also fed
 *      through `translateOverlay()` from `@oaverify/internal-overlay-spec` and
 *      classified as `ok` / `unrecognised-target` / `translator-error`.
 *      This is not a conformance metric (the upstream suite does not
 *      assert semantic translation); it surfaces translator coverage
 *      next to the envelope numbers.
 *
 * Usage:
 *   pnpm tsx conformance/run-overlay-suite.ts
 *   pnpm tsx conformance/run-overlay-suite.ts --filter=actions
 *   pnpm tsx conformance/run-overlay-suite.ts --check-baseline
 *     # exits non-zero if pass count drops below the committed baseline
 *     # in overlay-results.json.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import { builtInFormats } from "../packages/formats/src/index.ts";
import { translateOverlay, UnrecognisedTargetError } from "../packages/overlay-spec/src/index.ts";

const SUITE_ROOT = resolve(new URL(".", import.meta.url).pathname, "Overlay-Specification");
const SCHEMA_PATH = join(SUITE_ROOT, "schemas", "v1.0", "schema.yaml");
const PASS_DIR = join(SUITE_ROOT, "tests", "v1.0", "pass");
const FAIL_DIR = join(SUITE_ROOT, "tests", "v1.0", "fail");

interface CaseResult {
  file: string;
  expected: "pass" | "fail";
  envelopeValid: boolean;
  envelopeOk: boolean;
  translation: "ok" | "unrecognised-target" | "translator-error" | "n/a";
  reason?: string;
}

interface Summary {
  cases: number;
  envelopePass: number;
  envelopeFail: number;
  translatorOk: number;
  translatorUnrecognised: number;
  translatorError: number;
  results: CaseResult[];
}

const args = new Set(process.argv.slice(2));
const checkBaseline = args.has("--check-baseline");
const filterArg = process.argv.slice(2).find((a) => a.startsWith("--filter="));
const filterPattern = filterArg?.slice("--filter=".length);

function loadOverlaySchema(): unknown {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(
      `Overlay schema not found at ${SCHEMA_PATH}. Run \`pnpm setup:overlay\` from conformance/ first.`,
    );
    process.exit(2);
  }
  return parseYaml(readFileSync(SCHEMA_PATH, "utf8"));
}

function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
    .map((n) => join(dir, n))
    .sort();
}

function matches(filename: string): boolean {
  if (filterPattern === undefined) return true;
  return filename.includes(filterPattern);
}

const overlaySchema = loadOverlaySchema();
const { validate } = compileSchema(overlaySchema as never, {
  dialect: jsonSchemaDialect,
  formats: builtInFormats,
});

function classifyTranslation(doc: unknown): {
  translation: CaseResult["translation"];
  reason?: string;
} {
  try {
    translateOverlay(doc as never);
    return { translation: "ok" };
  } catch (err) {
    if (err instanceof UnrecognisedTargetError) {
      return { translation: "unrecognised-target", reason: err.message };
    }
    return { translation: "translator-error", reason: (err as Error).message };
  }
}

function runCase(path: string, expected: "pass" | "fail"): CaseResult {
  const file = basename(path);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      file,
      expected,
      envelopeValid: false,
      envelopeOk: expected === "fail",
      translation: "n/a",
      reason: `yaml: ${(err as Error).message}`,
    };
  }
  const envelopeValid = validate(doc).valid;
  const envelopeOk = expected === "pass" ? envelopeValid : !envelopeValid;

  let translation: CaseResult["translation"] = "n/a";
  let reason: string | undefined;
  if (expected === "pass" && envelopeValid) {
    const c = classifyTranslation(doc);
    translation = c.translation;
    reason = c.reason;
  }
  return { file, expected, envelopeValid, envelopeOk, translation, reason };
}

const results: CaseResult[] = [];
for (const f of listYamlFiles(PASS_DIR)) {
  if (matches(basename(f))) results.push(runCase(f, "pass"));
}
for (const f of listYamlFiles(FAIL_DIR)) {
  if (matches(basename(f))) results.push(runCase(f, "fail"));
}

const summary: Summary = {
  cases: results.length,
  envelopePass: results.filter((r) => r.envelopeOk).length,
  envelopeFail: results.filter((r) => !r.envelopeOk).length,
  translatorOk: results.filter((r) => r.translation === "ok").length,
  translatorUnrecognised: results.filter((r) => r.translation === "unrecognised-target").length,
  translatorError: results.filter((r) => r.translation === "translator-error").length,
  results,
};

console.log("file".padEnd(50) + "expect  envelope  translator");
console.log("-".repeat(82));
for (const r of results) {
  const env = r.envelopeOk ? "OK" : "MISMATCH";
  const trans = r.translation;
  console.log(r.file.padEnd(50) + r.expected.padEnd(8) + env.padEnd(10) + trans);
}
console.log("-".repeat(82));
console.log(
  `cases: ${summary.cases}  envelope ok: ${summary.envelopePass}/${summary.cases}  ` +
    `translator ok/unrecognised/error: ${summary.translatorOk}/${summary.translatorUnrecognised}/${summary.translatorError}`,
);

const summaryPath = resolve(new URL(".", import.meta.url).pathname, "overlay-results.json");
if (checkBaseline) {
  if (!existsSync(summaryPath)) {
    console.error(`--check-baseline: no committed results at ${summaryPath}`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(summaryPath, "utf8")) as Summary;
  console.log(`\nbaseline: envelope ${baseline.envelopePass}/${baseline.cases} pass`);
  console.log(`current:  envelope ${summary.envelopePass}/${summary.cases} pass`);
  if (summary.envelopePass < baseline.envelopePass) {
    console.error(
      `FAIL: envelope pass count regressed (${summary.envelopePass} < baseline ${baseline.envelopePass}).`,
    );
    process.exit(1);
  }
  if (summary.translatorOk < baseline.translatorOk) {
    console.error(
      `FAIL: translator ok count regressed (${summary.translatorOk} < baseline ${baseline.translatorOk}).`,
    );
    process.exit(1);
  }
  console.log("OK: counts meet or exceed baseline.");
} else {
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nPer-case results written to ${summaryPath}`);
}
