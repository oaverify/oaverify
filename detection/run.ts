/**
 * Runs every case in the corpus through each tool and reports which
 * tools caught which seeded defect.
 *
 * Usage (from this directory):
 *   pnpm install
 *   pnpm --dir .. build      # oaverify runs through its built CLI
 *   pnpm run
 *
 * Raw per-tool output is written to results/raw.json so every cell in
 * the matrix can be checked against what the tool actually said. A
 * detection matrix that cannot be audited is a marketing asset.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.ts";
import { oaverifyCheckRun } from "./oaverify.ts";
import {
  auditLine,
  classSummaryCell,
  controlFalsePositiveCount,
  mark,
  rowForCase,
  totalFatalRuns,
  totalFindingsRaised,
  type Finding,
  type Row,
  type ToolRun,
} from "./reporting.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(HERE, "cases");
const OAV_CLI = join(HERE, "..", "packages", "oav", "dist", "cli.js");

type Runner = (specPath: string) => ToolRun;

/**
 * Run a CLI, keeping stdout and stderr apart. Every one of these tools
 * exits non-zero when it finds something, so a non-zero status is the
 * normal case and says nothing on its own. Merging the two streams
 * corrupts the JSON on stdout with whatever the tool logged.
 */
function capture(cmd: string, args: string[]): { out: string; err: string; status: number } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { out, err: "", status: 0 };
  } catch (e) {
    const failed = e as { stdout?: string; stderr?: string; status?: number };
    return { out: failed.stdout ?? "", err: failed.stderr ?? "", status: failed.status ?? 1 };
  }
}

/**
 * Extract the first complete JSON value, ignoring anything a tool
 * prints around it. Scans for the matching close rather than trusting
 * the text to end there.
 */
function firstJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start] as "[" | "{";
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// --- oaverify -------------------------------------------------------

const runOaverify: Runner = (specPath) => {
  const { out, err, status } = capture("node", [OAV_CLI, "check", specPath, "--format", "json"]);
  const parsed = firstJson(out) as
    | { findings?: { code?: string; message?: string; location?: string }[] }
    | undefined;
  return oaverifyCheckRun(status, parsed, err);
};

// --- ajv ------------------------------------------------------------
//
// Ajv is a JSON Schema validator, not a spec linter, so the comparable
// operation is compiling each schema the document carries with strict
// mode on. That is the same moment oaverify does its own schema checks.

const runAjv: Runner = (specPath) => {
  const { out, err } = capture("node", [join(HERE, "ajv-probe.mjs"), specPath]);
  const parsed = firstJson(out) as { findings?: Finding[]; fatal?: string } | undefined;
  if (parsed === undefined) return { findings: [], fatal: err.trim().slice(0, 400) };
  return { findings: parsed.findings ?? [], fatal: parsed.fatal };
};

// --- Spectral -------------------------------------------------------

const runSpectral: Runner = (specPath) => {
  const { out, err } = capture("npx", [
    "--no-install",
    "spectral",
    "lint",
    specPath,
    "-f",
    "json",
    "--ruleset",
    join(HERE, ".spectral.yaml"),
  ]);
  const parsed = firstJson(out) as
    | { code?: string; message?: string; path?: unknown[]; severity?: number }[]
    | undefined;
  if (!Array.isArray(parsed)) return { findings: [], fatal: err.trim().slice(0, 400) };
  return {
    findings: parsed.map((f) => ({
      rule: String(f.code ?? ""),
      message: f.message ?? "",
      location: Array.isArray(f.path) ? f.path.join("/") : "",
      severity: f.severity === 0 ? "error" : "warn",
    })),
  };
};

// --- Redocly --------------------------------------------------------

const runRedocly: Runner = (specPath) => {
  const { out, err } = capture("npx", [
    "--no-install",
    "redocly",
    "lint",
    specPath,
    "--format=json",
  ]);
  const parsed = firstJson(out) as
    | {
        problems?: {
          ruleId?: string;
          message?: string;
          severity?: string;
          location?: { pointer?: string }[];
        }[];
      }
    | undefined;
  if (parsed?.problems === undefined) return { findings: [], fatal: err.trim().slice(0, 400) };
  return {
    findings: parsed.problems.map((p) => ({
      rule: p.ruleId ?? "",
      message: p.message ?? "",
      location: (p.location ?? []).map((l) => l.pointer ?? "").join(" "),
      severity: p.severity ?? "warn",
    })),
  };
};

const TOOLS: readonly (readonly [string, Runner])[] = [
  ["oaverify", runOaverify],
  ["ajv", runAjv],
  ["spectral", runSpectral],
  ["redocly", runRedocly],
];

// --- provenance -----------------------------------------------------
//
// The matrix is quoted outside this directory, so it has to say which
// versions produced it. Read from the installed tree rather than from
// package.json, whose ranges say what was asked for, not what ran.

/** Package directory each tool's version is read from. */
const TOOL_PACKAGES: Record<string, string> = {
  oaverify: join(HERE, "..", "packages", "oav"),
  ajv: join(HERE, "node_modules", "ajv"),
  spectral: join(HERE, "node_modules", "@stoplight", "spectral-cli"),
  redocly: join(HERE, "node_modules", "@redocly", "cli"),
};

function versionOf(tool: string): string {
  const dir = TOOL_PACKAGES[tool];
  if (dir === undefined) return "unknown";
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// --- report ---------------------------------------------------------

const raw: Record<string, Record<string, ToolRun>> = {};
const rows: Row[] = [];

for (const testCase of CASES) {
  const specPath = join(CASE_DIR, `${testCase.id}.yaml`);
  const runs = TOOLS.map(([name, run]) => [name, run(specPath)] as const);

  raw[testCase.id] = Object.fromEntries(runs) as Record<string, ToolRun>;
  rows.push(rowForCase(testCase, runs));
  process.stderr.write(`. ${testCase.id}\n`);
}

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "raw.json"), `${JSON.stringify(raw, null, 2)}\n`);

const names = TOOLS.map(([n]) => n);

const lines: string[] = [];
lines.push(`Run ${new Date().toISOString().slice(0, 10)} against:`);
lines.push("");
for (const name of names) lines.push(`- ${name} ${versionOf(name)}`);
lines.push("");
lines.push(`| case | class | ${names.join(" | ")} |`);
lines.push(`| --- | --- | ${names.map(() => "---").join(" | ")} |`);
for (const row of rows) {
  lines.push(
    `| \`${row.id}\` | ${row.class} | ${names
      .map((n) => mark(row.caught[n] ?? false, row.fatal[n] ?? false, row.class))
      .join(" | ")} |`,
  );
}

lines.push("");
lines.push(`| class | ${names.join(" | ")} |`);
lines.push(`| --- | ${names.map(() => "---").join(" | ")} |`);
for (const cls of ["malformed", "lint", "structural", "style"]) {
  const inClass = rows.filter((r) => r.class === cls);
  lines.push(
    `| ${cls} (${inClass.length}) | ${names
      .map((n) => classSummaryCell(inClass, n))
      .join(" | ")} |`,
  );
}
const controls = rows.filter((r) => r.class === "control");
lines.push(
  `| control false positives (${controls.length}) | ${names
    .map((n) => String(controlFalsePositiveCount(controls, n)))
    .join(" | ")} |`,
);

// Noise: total findings raised across the whole corpus, including the
// clean controls, excluding runs where the tool did not produce
// parseable results. Not a score -- a tool with more rules legitimately
// says more -- but it is what a reader has to read through.
lines.push(
  `| total findings raised | ${names
    .map((n) => String(totalFindingsRaised(rows, n)))
    .join(" | ")} |`,
);
lines.push(`| fatal runs | ${names.map((n) => String(totalFatalRuns(rows, n))).join(" | ")} |`);

const table = `${lines.join("\n")}\n`;
writeFileSync(join(HERE, "results", "matrix.md"), table);

// Every scored cell, with the finding that scored it. A matrix whose
// cells cannot be traced back to what the tool actually said is not
// evidence of anything.
const audit: string[] = ["# Detection audit", ""];
for (const row of rows) {
  audit.push(`## \`${row.id}\` (${row.class})`);
  for (const name of names) {
    audit.push(auditLine(row, name, raw[row.id]?.[name]));
  }
  audit.push("");
}
writeFileSync(join(HERE, "results", "audit.md"), `${audit.join("\n")}\n`);
process.stdout.write(`\n${table}`);
