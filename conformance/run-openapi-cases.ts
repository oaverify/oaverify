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

interface Case {
  name: string;
  kind: "request" | "response";
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  contentType?: string;
  status?: number;
  body?: unknown;
  expect: "valid" | "invalid";
  expectCodes?: string[];
}

interface CaseOutcome {
  name: string;
  expect: string;
  expectCodes?: string[];
  actual: "valid" | "invalid" | "error";
  actualCodes: string[];
  pass: boolean;
  note?: string;
}

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/oav/dist/cli.js");
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
      return makeOutcome(c, result.status, result.stdout);
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
      return makeOutcome(c, result.status, result.stdout);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeOutcome(c: Case, exitCode: number | null, stdout: string): CaseOutcome {
  const actualCodes: string[] = [];
  let actual: "valid" | "invalid" | "error" = "error";
  if (exitCode === 0) actual = "valid";
  else if (exitCode === 1) actual = "invalid";
  if (stdout.trim().startsWith("{")) {
    try {
      const tree = JSON.parse(stdout);
      collect(tree, actualCodes);
    } catch {
      // leave empty
    }
  }
  const pass =
    actual === c.expect &&
    (c.expectCodes === undefined || c.expectCodes.every((code) => actualCodes.includes(code)));
  return { name: c.name, expect: c.expect, expectCodes: c.expectCodes, actual, actualCodes, pass };
}

function collect(node: unknown, out: string[]): void {
  if (node === null || typeof node !== "object") return;
  const n = node as { code?: string; children?: unknown[] };
  if (typeof n.code === "string") out.push(n.code);
  if (Array.isArray(n.children)) for (const c of n.children) collect(c, out);
}

const dirs = readdirSync(ROOT).filter((d) => !d.startsWith("."));
const outcomes: Array<{ group: string } & CaseOutcome> = [];
for (const dir of dirs) {
  const specPath = join(ROOT, dir, "spec.yaml");
  const casesPath = join(ROOT, dir, "cases.json");
  if (!existsSync(specPath) || !existsSync(casesPath)) continue;
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  for (const c of cases) {
    const outcome = run(c, specPath);
    outcomes.push({ group: dir, ...outcome });
  }
}

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
  }
}

const summary = resolve(dirname(fileURLToPath(import.meta.url)), "openapi-results.json");
writeFileSync(summary, JSON.stringify(outcomes, null, 2));
console.log(`\nPer-case outcomes written to ${summary}`);
if (fail > 0) process.exit(1);
