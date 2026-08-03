#!/usr/bin/env node
// Roll `coverage/coverage-summary.json` up per workspace package.
//
// The global thresholds in vitest.config.ts are one number over ~9400
// statements, so a well-covered package can hide a thin one underneath
// it. This prints the breakdown the global number averages away. Run
// `pnpm test:coverage` first; this reads its json-summary output.
import { readFileSync } from "node:fs";

const SUMMARY = new URL("../coverage/coverage-summary.json", import.meta.url);

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") {
    process.stderr.write(
      "error: no coverage/coverage-summary.json; run `pnpm test:coverage` first\n",
    );
    process.exit(2);
  }
  throw err;
}

const METRICS = ["statements", "branches", "functions", "lines"];

/** @type {Map<string, Record<string, {covered: number, total: number}>>} */
const byPackage = new Map();
for (const [file, counts] of Object.entries(summary)) {
  if (file === "total") continue;
  const match = /\/packages\/([^/]+)\//.exec(file);
  if (!match) continue;
  const pkg = match[1];
  let acc = byPackage.get(pkg);
  if (!acc) {
    acc = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
    byPackage.set(pkg, acc);
  }
  for (const metric of METRICS) {
    acc[metric].covered += counts[metric].covered;
    acc[metric].total += counts[metric].total;
  }
}

// A package with no statements at all is fully excluded, not perfect;
// call it 100 so it sorts to the bottom rather than dividing by zero.
const pct = ({ covered, total }) => (total === 0 ? 100 : (covered * 100) / total);
const fmt = (n) => `${n.toFixed(1)}%`.padStart(7);

const rows = [...byPackage.entries()]
  .map(([pkg, acc]) => ({ pkg, acc, sort: pct(acc.statements) }))
  .sort((a, b) => a.sort - b.sort);

const width = Math.max(7, ...rows.map((r) => r.pkg.length));
process.stdout.write(
  `${"package".padEnd(width)}  ${"stmts".padStart(7)} ${"branch".padStart(7)} ${"funcs".padStart(7)} ${"lines".padStart(7)}  statements\n`,
);
for (const { pkg, acc } of rows) {
  const cells = METRICS.map((m) => fmt(pct(acc[m]))).join(" ");
  const { covered, total } = acc.statements;
  process.stdout.write(`${pkg.padEnd(width)}  ${cells}  ${covered}/${total}\n`);
}

const t = summary.total;
const totals = METRICS.map((m) => `${m} ${pct(t[m]).toFixed(1)}%`).join("  ");
process.stdout.write(`\ntotal: ${totals}\n`);
