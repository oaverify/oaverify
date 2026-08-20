/**
 * Runs the real-world corpus through oaverify and three comparators,
 * and sorts the output into the leads worth chasing.
 *
 * Usage (from this directory):
 *   pnpm install          # in ../ -- this shares the detection sub-root
 *   pnpm --dir ../.. build
 *   ./download.sh
 *   node run.mjs [--tools oaverify,ajv,spectral,redocly] [--limit N]
 *
 * This is a lead generator, not a measurement. Nothing it writes is a
 * bug report: every entry has to be minimized against a hand-written
 * document before it means anything. The sibling `../run.ts` corpus is
 * where scored claims live, because there the defect in each file is
 * known in advance. Here it is not, so the output is sorted by "how
 * likely is this to repay a look", and that is all.
 *
 * The tool runners mirror ../run.ts (same normalized `Finding` shape,
 * same stdout/stderr separation, same first-JSON scan). They are copied
 * rather than imported because that file is TypeScript run through tsx
 * and this one has to stay plain node, and because the real-world path
 * needs per-spec timeouts and crash classification that the labelled
 * corpus has no use for.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = join(HERE, "specs");
const RESULTS = join(HERE, "results");
const OAV_CLI = join(HERE, "..", "..", "packages", "oav", "dist", "cli.js");

const TIMEOUT_MS = 120_000;
const CONCURRENCY = 6;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const WANTED = new Set(flag("tools", "oaverify,ajv,spectral,redocly").split(","));
const LIMIT = Number(flag("limit", "0"));

/**
 * Run a CLI, keeping stdout and stderr apart. Every one of these tools
 * exits non-zero when it finds something, so a non-zero status is the
 * normal case and says nothing on its own. Merging the two streams
 * corrupts the JSON on stdout with whatever the tool logged, which is
 * one of the two scoring bugs that made #506's first numbers wrong.
 */
function capture(cmd, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: TIMEOUT_MS },
      (err, out, errOut) => {
        const e = err ?? {};
        resolve({
          out: out ?? "",
          err: errOut ?? "",
          status: e.code ?? 0,
          signal: e.signal ?? undefined,
          ms: Date.now() - started,
        });
      },
    );
  });
}

/**
 * Extract the first complete JSON value, ignoring anything a tool
 * prints around it. Scans for the matching close rather than trusting
 * the text to end there.
 */
function firstJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start];
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
//
// Exit codes: 0 clean, 1 findings at/above --fail-on, 2 the document was
// rejected as malformed, 3 usage error. Exit 2 with a located message is
// correct behaviour. Exit 3 means this harness is calling the CLI wrong.

/**
 * Strip absolute filesystem paths out of a captured tool message.
 *
 * `results/` is committed, and the messages in it are third-party tool
 * output quoted verbatim, so an absolute path there names a developer
 * and a machine to every reader of the repository. It is also useless
 * as a reference: the paths committed before this named a checkout
 * that was not this one, so nobody could follow them anyway (#914).
 *
 * A corpus-relative path is what a reader can act on. The home-directory
 * fallback catches anything outside the corpus, which is rarer and has
 * no natural relative form.
 */
/**
 * Strip absolute filesystem paths out of a captured tool message.
 *
 * `results/` is committed, and the messages in it are third-party tool
 * output quoted verbatim, so an absolute path there names a developer
 * and a machine to every reader of the repository. It is also useless
 * as a reference: the paths committed before this named a checkout
 * that was not this one, so nobody could follow them anyway (#914).
 *
 * A corpus-relative path is what a reader can act on. The home-directory
 * fallback catches anything outside the corpus, which is rarer and has
 * no natural relative form.
 */
export function scrubPaths(text) {
  return String(text)
    .replace(/(?:\/[^\s"'()]+)?\/(?:detection\/real-world\/)?specs\//g, "specs/")
    .replace(/\/(?:Users|home)\/[^/\s"'()]+/g, "<home>");
}

/**
 * Does this rejection message say *where* in the document the problem
 * is? Matches oaverify's own location idioms rather than guessing at
 * path-shaped text, because guessing was wrong in both directions. Too
 * narrow first: the router's duplicate-route rejections name both
 * offending path templates and scored as unlocated. Then too wide: a
 * "looks like a dotted path in quotes" rule matched the *prose* of
 * `expected one of "integer". Did you mean "boolean"?`, which says
 * nothing about position, and hid two real unlocated rejections.
 */
function isLocated(message) {
  return (
    /\bat "[^"]+"/.test(message) || // at "properties.x.type"
    /\bat <root>\b/.test(message) ||
    /\bat [A-Za-z_$][\w.$-]*\)?/.test(message) || // (at DoesNotExist)
    /#\//.test(message) || // a JSON pointer
    /"\/[^"]*"/.test(message) || // a quoted path template
    /\bline \d+/.test(message)
  );
}

async function runOaverify(specPath) {
  // Read the report through `-o`, not stdout. On a pipe, any oaverify
  // report over ~64 KiB comes back truncated (the CLI exits before the
  // write drains), which showed up here as three large specs "producing
  // no findings". That truncation is itself one of the findings from
  // this pass; the harness must not depend on the code it is probing.
  const outFile = join(RESULTS, `.tmp-${basename(specPath)}.json`);
  const r = await capture("node", [OAV_CLI, "check", specPath, "--format", "json", "-o", outFile]);
  let parsed;
  try {
    parsed = firstJson(readFileSync(outFile, "utf8"));
    rmSync(outFile, { force: true });
  } catch {
    parsed = undefined;
  }
  const stderr = r.err.trim();
  const base = { ms: r.ms, status: r.status, stderr: stderr.slice(0, 2000) };

  if (r.signal !== undefined || r.status === null) {
    return { ...base, kind: "timeout", findings: [] };
  }
  if (r.status === 3) return { ...base, kind: "usage-error", findings: [] };
  // A stack frame on stderr is an uncaught throw escaping the CLI, no
  // matter what exit code it happened to produce.
  if (
    /^\s+at .+:\d+:\d+\)?$/m.test(r.err) ||
    /\b(TypeError|ReferenceError|RangeError)\b/.test(r.err)
  ) {
    return { ...base, kind: "crash", findings: [] };
  }
  if (parsed?.findings !== undefined) {
    return {
      ...base,
      kind: "ran",
      findings: parsed.findings.map((f) => ({
        rule: f.code ?? "",
        message: scrubPaths(f.message ?? ""),
        location: scrubPaths(f.location ?? ""),
        severity: f.class ?? "warn",
      })),
    };
  }
  if (r.status === 2) {
    return { ...base, kind: isLocated(stderr) ? "rejected" : "rejected-unlocated", findings: [] };
  }
  return { ...base, kind: "unknown", findings: [] };
}

// --- comparators ----------------------------------------------------

async function runAjv(specPath) {
  const r = await capture("node", [join(HERE, "..", "ajv-probe.mjs"), specPath]);
  const parsed = firstJson(r.out);
  if (parsed === undefined) {
    return {
      kind: "fatal",
      ms: r.ms,
      findings: [],
      stderr: scrubPaths(r.err.trim()).slice(0, 400),
    };
  }
  return { kind: "ran", ms: r.ms, findings: parsed.findings ?? [], stderr: parsed.fatal ?? "" };
}

async function runSpectral(specPath) {
  const r = await capture("npx", [
    "--no-install",
    "spectral",
    "lint",
    specPath,
    "-f",
    "json",
    "--ruleset",
    join(HERE, "..", ".spectral.yaml"),
  ]);
  const parsed = firstJson(r.out);
  if (!Array.isArray(parsed)) {
    return {
      kind: "fatal",
      ms: r.ms,
      findings: [],
      stderr: scrubPaths(r.err.trim()).slice(0, 400),
    };
  }
  return {
    kind: "ran",
    ms: r.ms,
    stderr: "",
    findings: parsed.map((f) => ({
      rule: String(f.code ?? ""),
      message: scrubPaths(f.message ?? ""),
      location: Array.isArray(f.path) ? f.path.join("/") : "",
      severity: f.severity === 0 ? "error" : "warn",
    })),
  };
}

async function runRedocly(specPath) {
  const r = await capture("npx", ["--no-install", "redocly", "lint", specPath, "--format=json"]);
  const parsed = firstJson(r.out);
  if (parsed?.problems === undefined) {
    return {
      kind: "fatal",
      ms: r.ms,
      findings: [],
      stderr: scrubPaths(r.err.trim()).slice(0, 400),
    };
  }
  return {
    kind: "ran",
    ms: r.ms,
    stderr: "",
    findings: parsed.problems.map((p) => ({
      rule: p.ruleId ?? "",
      message: scrubPaths(p.message ?? ""),
      location: (p.location ?? []).map((l) => l.pointer ?? "").join(" "),
      severity: p.severity ?? "warn",
    })),
  };
}

const TOOLS = [
  ["oaverify", runOaverify],
  ["ajv", runAjv],
  ["spectral", runSpectral],
  ["redocly", runRedocly],
].filter(([name]) => WANTED.has(name));

// --- drive ----------------------------------------------------------

let specs = readdirSync(SPEC_DIR)
  .filter((f) => !f.startsWith(".") && /\.(ya?ml|json)$/.test(f))
  .sort();
if (LIMIT > 0) specs = specs.slice(0, LIMIT);

mkdirSync(RESULTS, { recursive: true });
const perSpec = {};
const STAMP = new Date().toISOString().slice(0, 10);
let done = 0;

/**
 * Cap what `per-spec.json` carries per tool per spec. Uncapped the file
 * is 26 MB, which is not a reasonable thing to put in a git history for
 * an artifact that `download.sh` plus this script regenerate. The count
 * dropped is recorded on every entry, so a reader can never mistake a
 * capped list for a complete one: a spec where Spectral said 6000 things
 * says so. Analysis that needs the full list re-runs the script.
 */
const KEEP_PER_TOOL = 25;
function capFindings(run) {
  if (run.findings.length <= KEEP_PER_TOOL) return run;
  return {
    ...run,
    findings: run.findings.slice(0, KEEP_PER_TOOL),
    omitted: run.findings.length - KEEP_PER_TOOL,
  };
}

async function processSpec(file) {
  const specPath = join(SPEC_DIR, file);
  const entry = { file, bytes: statSync(specPath).size, tools: {} };
  for (const [name, run] of TOOLS) {
    try {
      entry.tools[name] = await run(specPath);
    } catch (e) {
      entry.tools[name] = { kind: "harness-error", findings: [], stderr: String(e) };
    }
  }
  perSpec[file] = entry;
  done += 1;
  process.stderr.write(`\r${done}/${specs.length} ${file.slice(0, 60).padEnd(62)}`);
}

const queue = [...specs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      await processSpec(file);
    }
  }),
);
process.stderr.write("\n");

// Capped only on the way to disk. Everything below analyses the full
// in-memory results.
const forDisk = Object.fromEntries(
  Object.entries(perSpec).map(([file, entry]) => [
    file,
    {
      ...entry,
      tools: Object.fromEntries(
        Object.entries(entry.tools).map(([name, run]) => [name, capFindings(run)]),
      ),
    },
  ]),
);
writeFileSync(
  join(RESULTS, "per-spec.json"),
  `${JSON.stringify({ $measured: { specs: specs.length, on: STAMP, baseline: false }, ...forDisk }, null, 2)}\n`,
);

// --- crashes.md -----------------------------------------------------

/**
 * What population a generated file describes.
 *
 * Every file under `results/` is committed, and each opened with a bare
 * count and nothing else: `4 of 313 specs.` A reader has no way to tell
 * which corpus that was, so the numbers read as a baseline and are not
 * one. During the v7 review a finding-count move was nearly attributed
 * to a code change when the corpus had moved instead, and the only
 * reason it was caught is that the direction was wrong (#810).
 *
 * `specs/` is gitignored and `download.sh` re-selects from live
 * upstreams, so no revision can be pinned the way `conformance/` pins
 * its suites. What a reader can use instead is knowing what was
 * measured, and that nothing gates on it.
 */
function provenance(specCount) {
  const audited = specs.filter((f) => f.startsWith("audited-")).length;
  return [
    "> Measured against " + specCount + " specs on " + STAMP + ".",
    ">",
    "> Not a baseline. `specs/` is gitignored and `download.sh` re-selects",
    "> from live upstreams, so a later run measures a different population",
    "> and no CI job gates on these numbers. A count that moved may mean the",
    "> corpus moved. " +
      (audited > 0
        ? audited + " local `audited-*` specs are included, which nobody else has."
        : "No `audited-*` specs were present, so this is the public corpus alone."),
    "",
  ];
}

const entries = Object.values(perSpec);
const oav = (e) => e.tools.oaverify;
const BAD = new Set(["crash", "timeout", "usage-error", "unknown", "rejected-unlocated"]);
const crashed = entries.filter((e) => oav(e) !== undefined && BAD.has(oav(e).kind));

const crashLines = [
  "# oaverify crashes and unlocated rejections",
  "",
  ...provenance(entries.length),
  "Generated by `run.mjs`. Every row here is a _lead_: an oaverify run",
  "that either threw, timed out, or rejected a document without saying",
  "where the problem is. A located exit 2 is correct behaviour and is",
  "not listed.",
  "",
  `${crashed.length} of ${entries.length} specs.`,
  "",
];
for (const kind of ["crash", "timeout", "usage-error", "unknown", "rejected-unlocated"]) {
  const group = crashed.filter((e) => oav(e).kind === kind);
  if (group.length === 0) continue;
  crashLines.push(`## ${kind} (${group.length})`, "");
  for (const e of group) {
    crashLines.push(
      `### \`${e.file}\` (${(e.bytes / 1024).toFixed(0)} KiB, exit ${oav(e).status})`,
    );
    crashLines.push("");
    crashLines.push("```");
    crashLines.push(oav(e).stderr.split("\n").slice(0, 12).join("\n") || "(no stderr)");
    crashLines.push("```");
    crashLines.push("");
  }
}
// Trailing blanks accumulate from the per-section spacers, and oxfmt
// strips them, so emitting them meant every generated file needed a
// formatting pass before it could be committed.
writeFileSync(join(RESULTS, "crashes.md"), `${crashLines.join("\n").replace(/\n+$/, "")}\n`);

// --- leads.md -------------------------------------------------------
//
// Two differential seams, both noisy by construction:
//   - oaverify said nothing while a comparator reported something in
//     oaverify's stated scope (schema-shape defects only; every naming,
//     servers, examples and operationId rule is filtered out here
//     because those are out of scope by design, not misses).
//   - oaverify raised a finding no comparator agrees with, which is
//     where a false positive would show.

/** Comparator findings that could plausibly be in oaverify's scope. */
const IN_SCOPE = [
  /must be (an? )?(object|array|boolean|string|number)/i,
  /should be (an? )?(object|array|boolean|string|number)/i,
  /expected type/i,
  /unknown keyword/i,
  /strict mode/i,
  /invalid (schema|type)/i,
  /is not a valid/i,
  /required property/i,
  /schema is invalid/i,
  /can't resolve|cannot resolve|resolve the reference/i,
];
const OUT_OF_SCOPE =
  /operation-?id|operation-4xx|tag|summary|description|example|server|contact|license|security|no-\$ref-siblings|path-params|naming|casing|markdown|unused-component|info-|openapi-tags|response-contains|parameter-description|media-type-examples|spec-strict-refs/i;

function inScope(f) {
  const text = `${f.rule}: ${f.message}`;
  if (OUT_OF_SCOPE.test(text)) return false;
  return IN_SCOPE.some((re) => re.test(text));
}

const misses = [];
const solos = [];
for (const e of entries) {
  const o = oav(e);
  if (o === undefined || o.kind !== "ran") continue;
  const others = ["ajv", "spectral", "redocly"]
    .map((n) => [n, e.tools[n]])
    .filter(([, t]) => t !== undefined && t.kind === "ran");

  if (o.findings.length === 0) {
    const flagged = others.flatMap(([n, t]) => t.findings.filter(inScope).map((f) => [n, f]));
    if (flagged.length > 0) misses.push([e, flagged.slice(0, 4)]);
  }

  for (const f of o.findings) {
    const corroborated = others.some(([, t]) =>
      t.findings.some(
        (g) => g.location !== "" && f.location !== "" && g.location.includes(f.location),
      ),
    );
    if (!corroborated) solos.push([e, f]);
  }
}

// Group solo oaverify findings by rule: a false positive shows up as one
// rule firing on many unrelated real specs, so the rule is the unit to
// read, not the individual finding.
const byRule = new Map();
for (const [e, f] of solos) {
  const bucket = byRule.get(f.rule) ?? [];
  bucket.push([e.file, f]);
  byRule.set(f.rule, bucket);
}

const leadLines = [
  "# Differential leads",
  "",
  ...provenance(entries.length),
  "Noisy by construction. Nothing here is a finding until it has been",
  "minimized to a hand-written document; the filters below are keyword",
  "heuristics over four tools' prose and they misjudge both ways.",
  "",
  "## oaverify silent, a comparator flagged something schema-shaped",
  "",
  `${misses.length} specs.`,
  "",
];
for (const [e, flagged] of misses.slice(0, 60)) {
  leadLines.push(`- \`${e.file}\``);
  for (const [n, f] of flagged) {
    leadLines.push(`  - **${n}** \`${f.rule}\`: ${f.message.slice(0, 160)} @ \`${f.location}\``);
  }
}

leadLines.push("", "## oaverify findings no comparator locates, by rule", "");
for (const [rule, hits] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  leadLines.push(
    `### \`${rule}\` (${hits.length} findings, ${new Set(hits.map(([f]) => f)).size} specs)`,
  );
  leadLines.push("");
  for (const [file, f] of hits.slice(0, 15)) {
    leadLines.push(`- \`${file}\`: ${f.message.slice(0, 200)}`);
  }
  leadLines.push("");
}
writeFileSync(join(RESULTS, "leads.md"), `${leadLines.join("\n").replace(/\n+$/, "")}\n`);

// --- console summary ------------------------------------------------

const tally = {};
for (const e of entries) {
  const k = oav(e)?.kind ?? "skipped";
  tally[k] = (tally[k] ?? 0) + 1;
}
process.stdout.write(`specs: ${entries.length}\n`);
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  oaverify ${k}: ${n}\n`);
}
process.stdout.write(
  `differential leads: ${misses.length} silent, ${solos.length} uncorroborated\n`,
);
