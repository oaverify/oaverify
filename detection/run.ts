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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, type DetectionCase } from "./cases.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(HERE, "cases");
const OAV_CLI = join(HERE, "..", "packages", "oav", "dist", "cli.js");

/**
 * One normalized finding, whatever tool produced it.
 *
 * `location` matters for fairness: Redocly's struct rule reports
 * "Expected type `array` but got `integer`" and names the offending
 * keyword only in the pointer. Matching on the message alone would
 * score that as a miss when the tool plainly caught the defect.
 */
interface Finding {
  readonly rule: string;
  readonly message: string;
  readonly location: string;
  readonly severity: string;
}

interface ToolRun {
  readonly findings: Finding[];
  /** Set when the tool refused to process the document at all. */
  readonly fatal?: string;
}

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
  if (parsed?.findings === undefined) {
    // Exit 2 is `check` rejecting a malformed document, which is a
    // catch, not a failure to run. The message is on stderr.
    return status === 0 ? { findings: [] } : { findings: [], fatal: err.trim().slice(0, 400) };
  }
  return {
    findings: parsed.findings.map((f) => ({
      rule: f.code ?? "",
      message: f.message ?? "",
      location: f.location ?? "",
      severity: "warn",
    })),
  };
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

/**
 * Did this run identify *this* defect? One finding must match one
 * signal. Signals are therefore written to be discriminating -- the
 * misspelled property name, the offending keyword -- so that a generic
 * "schema is invalid" cannot score on every malformed case. Requiring
 * *all* signals instead looks stricter and is worse: it silently
 * scores real catches as misses whenever the tool's wording differs
 * from the guess, which is most of the time.
 */
function caught(run: ToolRun, testCase: DetectionCase): string | undefined {
  if (testCase.signals.length === 0) return undefined;
  const texts = run.findings.map((f) => `${f.rule}: ${f.message} [${f.location}]`);
  if (run.fatal !== undefined && run.fatal.length > 0) texts.push(`(fatal) ${run.fatal}`);
  return texts.find((t) => testCase.signals.some((s) => t.toLowerCase().includes(s.toLowerCase())));
}

// --- report ---------------------------------------------------------

interface Row {
  readonly id: string;
  readonly class: string;
  readonly caught: Record<string, boolean>;
  readonly evidence: Record<string, string>;
  readonly counts: Record<string, number>;
}

const raw: Record<string, Record<string, ToolRun>> = {};
const rows: Row[] = [];

for (const testCase of CASES) {
  const specPath = join(CASE_DIR, `${testCase.id}.yaml`);
  const perTool: Record<string, ToolRun> = {};
  const caughtBy: Record<string, boolean> = {};
  const evidence: Record<string, string> = {};
  const counts: Record<string, number> = {};

  for (const [name, run] of TOOLS) {
    const result = run(specPath);
    perTool[name] = result;
    const hit = caught(result, testCase);
    caughtBy[name] = hit !== undefined;
    if (hit !== undefined) evidence[name] = hit;
    counts[name] = result.findings.length + (result.fatal === undefined ? 0 : 1);
  }

  raw[testCase.id] = perTool;
  rows.push({ id: testCase.id, class: testCase.class, caught: caughtBy, evidence, counts });
  process.stderr.write(`. ${testCase.id}\n`);
}

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "raw.json"), `${JSON.stringify(raw, null, 2)}\n`);

const names = TOOLS.map(([n]) => n);
const mark = (hit: boolean, cls: string): string => {
  // In the control class nothing is wrong, so a "hit" is a false positive.
  if (cls === "control") return hit ? "FP" : "-";
  return hit ? "yes" : "-";
};

const lines: string[] = [];
lines.push(`| case | class | ${names.join(" | ")} |`);
lines.push(`| --- | --- | ${names.map(() => "---").join(" | ")} |`);
for (const row of rows) {
  lines.push(
    `| \`${row.id}\` | ${row.class} | ${names
      .map((n) => mark(row.caught[n] ?? false, row.class))
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
      .map((n) => `${inClass.filter((r) => r.caught[n]).length}/${inClass.length}`)
      .join(" | ")} |`,
  );
}
const controls = rows.filter((r) => r.class === "control");
lines.push(
  `| control false positives (${controls.length}) | ${names
    .map((n) => String(controls.filter((r) => r.caught[n]).length))
    .join(" | ")} |`,
);

// Noise: total findings raised across the whole corpus, including the
// clean controls. Not a score -- a tool with more rules legitimately
// says more -- but it is what a reader has to read through.
lines.push(
  `| total findings raised | ${names
    .map((n) => String(rows.reduce((sum, r) => sum + (r.counts[n] ?? 0), 0)))
    .join(" | ")} |`,
);

const table = `${lines.join("\n")}\n`;
writeFileSync(join(HERE, "results", "matrix.md"), table);

// Every scored cell, with the finding that scored it. A matrix whose
// cells cannot be traced back to what the tool actually said is not
// evidence of anything.
const audit: string[] = ["# Detection audit", ""];
for (const row of rows) {
  audit.push(`## \`${row.id}\` (${row.class})`);
  for (const name of names) {
    audit.push(
      row.caught[name]
        ? `- **${name}**: ${row.evidence[name]}`
        : `- ${name}: no matching finding (${row.counts[name] ?? 0} raised)`,
    );
  }
  audit.push("");
}
writeFileSync(join(HERE, "results", "audit.md"), `${audit.join("\n")}\n`);
process.stdout.write(`\n${table}`);
