/**
 * Runner for the OpenAPI-level conformance cases under ./openapi-cases/.
 *
 * Each directory there contains:
 *   spec.yaml      — the OpenAPI document
 *   cases.json     — an array of {name, kind, method, path, ..., expect, expectCodes}
 *
 * Cases run via the oaverify CLI (invokes the built binary at
 * packages/oav/dist/cli.js) and compare exit code + emitted leaf
 * error codes against expectations.
 *
 * Usage:
 *   pnpm tsx conformance/run-openapi-cases.ts
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeOutcome, stampCli, type Case, type CaseOutcome } from "./openapi-case-outcome.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/oav/dist/cli.js");

/**
 * Identity of the binary as of the probe that opened the run.
 *
 * A concurrent build rewrites `dist/cli.js` in place, so the file
 * changing mid-run is the signal that the cases around it answered
 * against something other than what was proved. Cheaper than probing
 * per case, and it is what catches a wipe repaired before the run ends,
 * which both bookend probes see as healthy.
 */
let cliStamp = "";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "openapi-cases");

if (!existsSync(CLI)) {
  console.error(`CLI binary not found at ${CLI}; run "pnpm build" first.`);
  process.exit(2);
}

function buildHttpFile(c: Case): string {
  const queryStr = c.query
    ? "?" +
      Object.entries(c.query)
        .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))
        .map(([k, v]) => `${encodeURIComponent(k as string)}=${encodeURIComponent(v as string)}`)
        .join("&")
    : "";
  const lines: string[] = [];
  lines.push(`${c.method.toUpperCase()} ${c.path}${queryStr} HTTP/1.1`);
  if (c.contentType) lines.push(`Content-Type: ${c.contentType}`);
  for (const [k, v] of Object.entries(c.headers ?? {})) lines.push(`${k}: ${v}`);
  lines.push("");
  if (c.body !== undefined) {
    lines.push(typeof c.body === "string" ? c.body : JSON.stringify(c.body));
  }
  return lines.join("\n");
}

function run(c: Case, specPath: string): CaseOutcome {
  const tmp = mkdtempSync(join(tmpdir(), "oaverify-case-"));
  try {
    if (c.kind === "request") {
      const httpFile = join(tmp, "req.http");
      writeFileSync(httpFile, buildHttpFile(c));
      const result = spawnSync(
        process.execPath,
        [CLI, "validate", specPath, "--request", httpFile, "--format", "json"],
        { encoding: "utf8" },
      );
      return makeOutcome(c, result);
    } else {
      const bodyFile = join(tmp, "body.json");
      writeFileSync(bodyFile, c.body === undefined ? "" : JSON.stringify(c.body));
      const args = [
        CLI,
        "validate",
        specPath,
        "--path",
        `${c.method} ${c.path}`,
        "--body",
        c.body === undefined ? "/dev/null" : bodyFile,
        "--response",
        "--status",
        String(c.status ?? 0),
        "--format",
        "json",
      ];
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      return makeOutcome(c, result);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Prove the CLI answers at all, which no per-case check can.
 *
 * The exit-1 crash is separable from a verdict because a corpse writes
 * no JSON. Exit 0 is not: the CLI is silent on success, so a real pass
 * and a binary that ran no code are byte-identical (status 0, empty
 * stdout, empty stderr). The dangerous window is narrow and real: a
 * `dist/cli.js` truncated at open, before its first byte is written, is
 * empty, and node runs an empty module and exits 0. (A partly written
 * one usually syntax-errors to exit 1, which the JSON rule already
 * catches.) Left unchecked, every `expect: "valid"` case reports a pass
 * against nothing, which is worse than the misattributed failure #804
 * fixed: this runner gates PRs, so a false pass hides a real regression.
 *
 * Called on both sides of the loop. That proves the ends and not the
 * middle: a wipe that starts and is repaired between the two probes
 * leaves both green while the cases spanning it ran against nothing.
 * `assertCliUnchanged` covers the middle, and deliberately does not live
 * here: this function must not re-stamp, or the comparison at the end of
 * the run would be against a stamp taken moments earlier.
 */
function assertCliAnswers(when: string): void {
  const probe = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  const version = (probe.stdout ?? "").trim();
  if (probe.status === 0 && /^\d+\.\d+\.\d+/.test(version)) return;
  const how = probe.signal === null ? `exit ${probe.status}` : `killed by ${probe.signal}`;
  console.error(
    `CLI did not answer --version ${when} the run (${how}, stdout ${JSON.stringify(version)}), ` +
      `so these results would be meaningless. Run "pnpm build".`,
  );
  const err = (probe.error?.message ?? probe.stderr ?? "").trim();
  if (err) console.error(err);
  process.exit(2);
}

function assertCliUnchanged(where: string): void {
  const now = stampCli(CLI);
  if (now === cliStamp) return;
  console.error(
    `CLI binary changed during the run (${where}), ` +
      `so these results would be meaningless. Re-run without a concurrent build.`,
  );
  process.exit(2);
}

assertCliAnswers("before");
cliStamp = stampCli(CLI);

const dirs = readdirSync(ROOT).filter((d) => !d.startsWith("."));
const outcomes: Array<{ group: string } & CaseOutcome> = [];
for (const dir of dirs) {
  const specPath = join(ROOT, dir, "spec.yaml");
  const casesPath = join(ROOT, dir, "cases.json");
  if (!existsSync(specPath) || !existsSync(casesPath)) continue;
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  for (const c of cases) {
    assertCliUnchanged(`before case "${c.name}"`);
    const outcome = run(c, specPath);
    outcomes.push({ group: dir, ...outcome });
  }
}

assertCliUnchanged("after the last case");
assertCliAnswers("after");

let pass = 0;
let fail = 0;
for (const o of outcomes) {
  if (o.pass) pass += 1;
  else fail += 1;
}

console.log(`\n${pass}/${outcomes.length} OpenAPI cases pass\n`);
console.log("group".padEnd(14) + "case".padEnd(60) + "actual".padEnd(10) + "codes");
console.log("-".repeat(110));
for (const o of outcomes) {
  const codes = o.actualCodes.slice(0, 4).join(",") + (o.actualCodes.length > 4 ? "…" : "");
  const mark = o.pass ? " " : "✗";
  console.log(
    mark + " " + o.group.padEnd(12) + o.name.padEnd(60) + o.actual.padEnd(10) + codes.padEnd(40),
  );
  if (!o.pass) {
    console.log(
      "    expect=" +
        o.expect +
        (o.expectCodes ? " codes=" + o.expectCodes.join(",") : "") +
        "  got " +
        o.actual +
        " codes=" +
        o.actualCodes.join(","),
    );
    if (o.note) console.log("    " + o.note);
  }
}

const summary = resolve(dirname(fileURLToPath(import.meta.url)), "openapi-results.json");
writeFileSync(summary, JSON.stringify(outcomes, null, 2));
console.log(`\nPer-case outcomes written to ${summary}`);
if (fail > 0) process.exit(1);
