/**
 * Render a benchmark results JSON (written by run.ts) into markdown
 * tables.
 *
 *   - Compile: one combined table (absolute + the `N×` oav speedup).
 *   - Validate, valid input: an absolute table + a relative table.
 *   - Validate, invalid input: an absolute table (average with the
 *     min–max range across the failure-position fixtures) + a relative
 *     table (average speed vs the baseline).
 *
 * Splitting absolute from relative keeps every cell to a single value.
 * Absolute tables are latency (lower is faster) and list every config;
 * relative tables show each oav config against the ajv mode doing the
 * same job (fast-fail vs fast-fail, full-collect vs full-collect), so
 * 100% = same and higher is faster (large speedups render as `N×`).
 *
 * Usage:
 *   pnpm bench:render [path/to/results.json]
 *
 * With no path, the most recent file under ./results/ is used. The
 * provenance header records the host the numbers came from, so a table
 * pasted into the README can't drift away from where it was measured.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Result = {
  schema: string;
  metric: "compile" | "validate";
  lib: "ajv" | "ajv-fast" | "oav" | "oav-all" | "oav-predicate";
  validity?: "valid" | "invalid";
  mean: number; // µs/op
};
type Meta = Record<string, unknown>;

const perfDir = dirname(fileURLToPath(import.meta.url));

function latestResults(): string {
  const dir = resolve(perfDir, "results");
  const files = readdirSync(dir)
    // run.ts outputs are `<ISO>.json`; skip `mem-*.json` and other
    // sibling-bench outputs, which have a different shape.
    .filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort(); // ISO timestamps sort chronologically
  const last = files.at(-1);
  if (last === undefined)
    throw new Error(`no run.ts result files in ${dir}; run \`pnpm bench\` first`);
  return join(dir, last);
}

function fmtUs(us: number): string {
  if (us < 1) return (us * 1000).toFixed(1) + "ns";
  if (us < 1000) return us.toFixed(2) + "µs";
  return (us / 1000).toFixed(2) + "ms";
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Unique schema names in first-seen order: keeps the README's shape
// ordering stable instead of reshuffling on Object key iteration.
function schemaOrder(results: Result[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const r of results) {
    if (!seen.has(r.schema)) {
      seen.add(r.schema);
      order.push(r.schema);
    }
  }
  return order;
}

function table(header: string[], rows: string[][]): string {
  const head = `| ${header.join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

const path = process.argv[2] ?? latestResults();
const { meta, results } = JSON.parse(readFileSync(path, "utf8")) as {
  meta: Meta;
  results: Result[];
};
const shapes = schemaOrder(results);

function pickMean(
  schema: string,
  lib: Result["lib"],
  metric: "compile" | "validate",
  validity?: "valid" | "invalid",
): number | null {
  const r = results.find(
    (x) =>
      x.schema === schema &&
      x.metric === metric &&
      x.lib === lib &&
      (validity === undefined || x.validity === validity),
  );
  return r ? r.mean : null;
}

function invalidStats(
  schema: string,
  lib: Result["lib"],
): { avg: number; min: number; max: number } | null {
  const means = results
    .filter(
      (r) =>
        r.schema === schema && r.metric === "validate" && r.validity === "invalid" && r.lib === lib,
    )
    .map((r) => r.mean);
  if (means.length === 0) return null;
  return { avg: avg(means), min: Math.min(...means), max: Math.max(...means) };
}

// Speed of a cell relative to its row's baseline (the first column):
// baseline latency / cell latency. 100% = same speed, >100% faster,
// <100% slower. Large compile speedups render as an `N×` multiplier
// rather than an unwieldy four-digit percentage.
function rel(baseline: number | null, value: number | null): string {
  if (baseline === null || value === null || value === 0) return "-";
  const r = baseline / value;
  if (r >= 10) return `${r.toFixed(0)}×`;
  const pct = r * 100;
  return pct < 1 ? "<1%" : `${pct.toFixed(0)}%`;
}

const COLS: { label: string; lib: Result["lib"] }[] = [
  { label: "ajv fast-fail", lib: "ajv-fast" },
  { label: "ajv full-collect", lib: "ajv" },
  { label: "oav fast-fail", lib: "oav" },
  { label: "oav full-collect", lib: "oav-all" },
  { label: "oav predicate", lib: "oav-predicate" },
];
const COL_LABELS = COLS.map((c) => c.label);

// Relative tables pair each oav config with the ajv mode doing the same
// job, so the comparison is like-for-like (full-collect against
// full-collect, not against fast-fail). ajv has no boolean-only mode, so
// predicate is measured against ajv's fastest path, fast-fail.
const MATCHED: { label: string; oav: Result["lib"]; ajv: Result["lib"] }[] = [
  { label: "oav fast-fail", oav: "oav", ajv: "ajv-fast" },
  { label: "oav full-collect", oav: "oav-all", ajv: "ajv" },
  { label: "oav predicate", oav: "oav-predicate", ajv: "ajv-fast" },
];
const MATCHED_LABELS = MATCHED.map((p) => p.label);
const MATCHED_NOTE =
  "_Each oav config vs the matched ajv mode (fast-fail→fast-fail, " +
  "full-collect→full-collect, predicate→fast-fail). 100% = same, higher is faster._";

const m = (k: string): string => String(meta[k] ?? "?");
const sha = m("commitSha");
console.log(`### Benchmark results\n`);
console.log(
  [
    `- **Host:** ${m("cpu")} (${m("arch")}, ${m("cpuCount")} vCPU, ${m("platform")})`,
    `- **Runtime:** Node ${m("nodeVersion")}, ajv ${m("ajvVersion")}`,
    `- **Run:** ${m("mode")} mode, ${m("timePerTaskMs")}ms/task, ${m("cooldownMs")}ms cooldown`,
    `- **Commit:** \`${sha === "?" ? sha : sha.slice(0, 12)}\` · ${m("timestamp")}`,
    meta["specPath"] ? `- **Spec:** ${m("specPath")}` : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

// --- Compile (combined: absolute + oav speedup) ---------------------------
const compileRows = shapes
  .filter((s) => results.some((r) => r.schema === s && r.metric === "compile"))
  .map((s) => {
    const ajv = pickMean(s, "ajv", "compile");
    const oav = pickMean(s, "oav", "compile");
    return [
      `\`${s}\``,
      ajv === null ? "-" : fmtUs(ajv),
      oav === null ? "-" : `${fmtUs(oav)} / ${rel(ajv, oav)}`,
    ];
  });
console.log(`\n#### Compile (ajv vs oav)\n`);
console.log(
  `_Mean per schema. oav's \`N×\` is its speedup over the ajv baseline; higher is faster._\n`,
);
console.log(table(["shape", "ajv", "oav (vs ajv)"], compileRows));

// --- Validate, valid input ------------------------------------------------
if (results.some((r) => r.metric === "validate" && r.validity === "valid")) {
  const validShapes = shapes.filter((s) =>
    results.some((r) => r.schema === s && r.metric === "validate" && r.validity === "valid"),
  );
  const absRows = validShapes.map((s) => [
    `\`${s}\``,
    ...COLS.map((c) => {
      const v = pickMean(s, c.lib, "validate", "valid");
      return v === null ? "-" : fmtUs(v);
    }),
  ]);
  const relRows = validShapes.map((s) => [
    `\`${s}\``,
    ...MATCHED.map((p) =>
      rel(pickMean(s, p.ajv, "validate", "valid"), pickMean(s, p.oav, "validate", "valid")),
    ),
  ]);

  console.log(`\n#### Validate: valid input · absolute\n`);
  console.log(`_Mean latency per op. Lower is faster._\n`);
  console.log(table(["shape", ...COL_LABELS], absRows));

  console.log(`\n#### Validate: valid input · oav vs matched ajv mode\n`);
  console.log(`${MATCHED_NOTE}\n`);
  console.log(table(["shape", ...MATCHED_LABELS], relRows));
}

// --- Validate, invalid input ----------------------------------------------
if (results.some((r) => r.metric === "validate" && r.validity === "invalid")) {
  const invalidShapes = shapes.filter((s) =>
    results.some((r) => r.schema === s && r.metric === "validate" && r.validity === "invalid"),
  );
  const absRows = invalidShapes.map((s) => [
    `\`${s}\``,
    ...COLS.map((c) => {
      const st = invalidStats(s, c.lib);
      if (st === null) return "-";
      return st.min === st.max
        ? fmtUs(st.avg)
        : `${fmtUs(st.avg)} (${fmtUs(st.min)}–${fmtUs(st.max)})`;
    }),
  ]);
  const relRows = invalidShapes.map((s) => [
    `\`${s}\``,
    ...MATCHED.map((p) =>
      rel(invalidStats(s, p.ajv)?.avg ?? null, invalidStats(s, p.oav)?.avg ?? null),
    ),
  ]);

  console.log(`\n#### Validate: invalid input · absolute\n`);
  console.log(
    `_Average per op with the min–max range across the failure-position fixtures. Lower is faster._\n`,
  );
  console.log(table(["shape", ...COL_LABELS], absRows));

  console.log(`\n#### Validate: invalid input · oav vs matched ajv mode\n`);
  console.log(`${MATCHED_NOTE}\n`);
  console.log(table(["shape", ...MATCHED_LABELS], relRows));
}
