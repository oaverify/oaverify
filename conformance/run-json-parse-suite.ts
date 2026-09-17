/**
 * Runner for the JSONTestSuite parser-conformance corpus
 * (https://github.com/nst/JSONTestSuite), driving the
 * `@oaverify/internal-stream-validator` SAX tokenizer.
 *
 * A clone of that repo lives under ./JSONTestSuite (gitignored; cloned
 * by `pnpm corpora:json-parse`). This script walks `test_parsing/*.json`,
 * whose filenames are prefixed `y_` (must accept), `n_` (must reject), or
 * `i_` (implementation-defined). Each file is checked in both UTF-8
 * modes against JSON.parse after decoding with the corresponding policy.
 * The filename label is reported as context for the strict default.
 *
 * A file passes when both modes match their oracle's verdict and value,
 * and replaying split input preserves the verdict.
 *
 * Usage:
 *   pnpm tsx run-json-parse-suite.ts                  # run + write results
 *   pnpm tsx run-json-parse-suite.ts --filter=number  # only matching files
 *   pnpm tsx run-json-parse-suite.ts --check-baseline # CI: no regression
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPinned, corpusPath } from "./corpora.ts";
import { writeBaseline } from "./baseline.ts";
import type {
  JsonEventHandler,
  JsonTokenizerOptions,
} from "../packages/stream-validator/src/tokenizer/index.ts";
import { JsonParseError, JsonTokenizer } from "../packages/stream-validator/src/tokenizer/index.ts";

const SUITE = "JSONTestSuite";
const SUITE_ROOT = corpusPath(SUITE);
const PARSING_DIR = join(SUITE_ROOT, "test_parsing");

// Baselines were measured at the pin in corpora.json; refuse to report
// numbers from a different revision.
assertPinned(SUITE);

const args = process.argv.slice(2);
const checkBaseline = args.includes("--check-baseline");
const filterArg = args.find((a) => a.startsWith("--filter="));
const filterPattern = filterArg?.slice("--filter=".length);

type Utf8Policy = NonNullable<JsonTokenizerOptions["utf8"]>;

type Verdict = { accepted: true; value: unknown } | { accepted: false };

/** Reconstructs the JS value from tokenizer events (for value parity). */
class ValueBuilder implements JsonEventHandler {
  private stack: Array<{ container: unknown; key: string | null }> = [];
  private root: unknown = undefined;
  private curString = "";

  get value(): unknown {
    return this.root;
  }
  private add(v: unknown): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.root = v;
      return;
    }
    if (Array.isArray(top.container)) top.container.push(v);
    else (top.container as Record<string, unknown>)[top.key as string] = v;
  }
  onStartObject(): void {
    const c = {};
    this.add(c);
    this.stack.push({ container: c, key: null });
  }
  onEndObject(): void {
    this.stack.pop();
  }
  onStartArray(): void {
    const c: unknown[] = [];
    this.add(c);
    this.stack.push({ container: c, key: null });
  }
  onEndArray(): void {
    this.stack.pop();
  }
  onKey(value: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined) top.key = value;
  }
  onStringStart(): void {
    this.curString = "";
  }
  onStringChunk(chunk: string): void {
    this.curString += chunk;
  }
  onStringEnd(): void {
    this.add(this.curString);
  }
  onNumber(value: number): void {
    this.add(value);
  }
  onBoolean(value: boolean): void {
    this.add(value);
  }
  onNull(): void {
    this.add(null);
  }
}

/** Tokenize `bytes` (single shot or split into `chunkSize` pieces). */
function tokenize(bytes: Uint8Array, chunkSize: number, utf8: Utf8Policy): Verdict {
  const builder = new ValueBuilder();
  const tok = new JsonTokenizer(builder, { utf8 });
  if (chunkSize <= 0) {
    tok.write(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      tok.write(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
  }
  tok.end();
  return { accepted: true, value: builder.value };
}

/** Tokenizer verdict, swallowing JsonParseError as a clean reject. */
function tokenizerVerdict(
  bytes: Uint8Array,
  chunkSize: number,
  utf8: Utf8Policy,
): Verdict | { crash: string } {
  try {
    return tokenize(bytes, chunkSize, utf8);
  } catch (err) {
    if (err instanceof JsonParseError) return { accepted: false };
    return { crash: (err as Error).message };
  }
}

function oracleVerdict(bytes: Uint8Array, utf8: Utf8Policy): Verdict {
  try {
    const text =
      utf8 === "reject"
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
        : Buffer.from(bytes).toString("utf8");
    const value: unknown = JSON.parse(text);
    return { accepted: true, value };
  } catch {
    return { accepted: false };
  }
}

interface Mismatch {
  file: string;
  label: string;
  kind: "verdict" | "chunk-variance" | "value" | "crash";
  detail: string;
}

interface Summary {
  total: number;
  pass: number;
  mismatches: Mismatch[];
  // For context only: how often the strict oracle agrees with the
  // suite's y_/n_ label (i_ excluded). Not a pass/fail signal.
  labelAgree: number;
  labelTotal: number;
}

function replayChunkSizes(len: number): number[] {
  if (len <= 2048) return [1];
  // Large inputs (deep-nesting stress files): a few fixed split points
  // exercise resumption without an O(n) per-byte feed.
  return [Math.max(1, Math.floor(len / 3)), Math.max(1, Math.floor(len / 2))];
}

function run(): Summary {
  if (!existsSync(PARSING_DIR)) {
    console.error(`no corpus at ${PARSING_DIR}; run \`pnpm corpora:json-parse\` first.`);
    process.exit(2);
  }
  const files = readdirSync(PARSING_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => filterPattern === undefined || f.includes(filterPattern))
    .sort();

  const summary: Summary = { total: 0, pass: 0, mismatches: [], labelAgree: 0, labelTotal: 0 };

  for (const file of files) {
    const label = file[0] as string; // y / n / i
    const bytes = readFileSync(join(PARSING_DIR, file));
    const strictOracle = oracleVerdict(bytes, "reject");

    if (label === "y" || label === "n") {
      summary.labelTotal += 1;
      if ((label === "y") === strictOracle.accepted) summary.labelAgree += 1;
    }

    summary.total += 1;
    const previousMismatches = summary.mismatches.length;
    for (const utf8 of ["reject", "replace"] as const) {
      const oracle = utf8 === "reject" ? strictOracle : oracleVerdict(bytes, utf8);
      const single = tokenizerVerdict(bytes, 0, utf8);

      if ("crash" in single) {
        summary.mismatches.push({ file, label, kind: "crash", detail: `${utf8}: ${single.crash}` });
        continue;
      }
      if (single.accepted !== oracle.accepted) {
        summary.mismatches.push({
          file,
          label,
          kind: "verdict",
          detail: `${utf8}: tokenizer ${single.accepted ? "accepted" : "rejected"}, oracle ${oracle.accepted ? "accepted" : "rejected"}`,
        });
        continue;
      }
      // Chunk-invariance of the verdict.
      let chunkOk = true;
      for (const size of replayChunkSizes(bytes.length)) {
        const split = tokenizerVerdict(bytes, size, utf8);
        if ("crash" in split || split.accepted !== single.accepted) {
          summary.mismatches.push({
            file,
            label,
            kind: "chunk-variance",
            detail: `${utf8}: chunkSize=${size} diverged from single-shot`,
          });
          chunkOk = false;
          break;
        }
      }
      if (!chunkOk) continue;

      // Value parity for accepted cases.
      if (single.accepted && oracle.accepted) {
        const a = JSON.stringify(single.value);
        const b = JSON.stringify(oracle.value);
        if (a !== b) {
          summary.mismatches.push({
            file,
            label,
            kind: "value",
            detail: `${utf8}: tokenizer ${a} vs JSON.parse ${b}`,
          });
          continue;
        }
      }
    }
    if (summary.mismatches.length === previousMismatches) summary.pass += 1;
  }
  return summary;
}

const summary = run();

console.log(
  `JSONTestSuite/test_parsing: ${summary.pass}/${summary.total} match in both UTF-8 modes`,
);
console.log(
  `(label context: ${summary.labelAgree}/${summary.labelTotal} y_/n_ cases agree with strict UTF-8 + JSON.parse)`,
);
if (summary.mismatches.length > 0) {
  console.log(`\n${summary.mismatches.length} mismatch(es):`);
  for (const m of summary.mismatches) console.log(`  [${m.kind}] ${m.file}: ${m.detail}`);
}

const summaryPath = resolve(new URL(".", import.meta.url).pathname, "json-parse-results.json");
if (checkBaseline) {
  if (!existsSync(summaryPath)) {
    console.error(`--check-baseline: no committed results at ${summaryPath}`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(summaryPath, "utf8")) as Summary;
  console.log(`\nbaseline: ${baseline.pass}/${baseline.total} pass`);
  console.log(`current:  ${summary.pass}/${summary.total} pass`);
  if (summary.pass < baseline.pass || summary.mismatches.length > baseline.mismatches.length) {
    console.error("FAIL: parser-conformance regressed against the committed baseline.");
    process.exit(1);
  }
  console.log("OK: meets or exceeds baseline.");
} else {
  writeBaseline(summaryPath, summary, filterPattern, "Results");
}
