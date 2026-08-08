/**
 * Compare two grid dumps and triage every difference.
 *
 * The three buckets #753 named, plus three the prototypes did not have and
 * that turn out to matter:
 *
 * - **regression**  base valid  -> head invalid. The list to read first.
 * - **fix**         base invalid -> head valid. Intended, usually; worth
 *                   reading to confirm each one was actually intended.
 * - **silent**      both valid, different deserialized value. No gate shows
 *                   these today, and a request that still passes while
 *                   arriving at the handler as a different value is the
 *                   failure mode #751 shipped (`?filter[n]=0x1A` reaching a
 *                   handler as 26).
 * - **shape**       both invalid, different error codes. The verdict is
 *                   unchanged, so no user is broken, but the reported reason
 *                   moved and that is a contract in its own right.
 * - **crash**       a throw or a refused build appeared or disappeared.
 * - **drift**       a case exists on one side only, so the grid itself
 *                   changed and the two dumps are not comparable.
 *
 * Usage:
 *   node scripts/grid/diff.mjs <base.json> <head.json> [--limit N] [--bucket B]
 *
 * Exits 1 when the regression bucket is non-empty. That is a convenience for
 * a human running this on a branch, not a gate: the fix bucket needs a
 * reader, and a legitimate behaviour change lands here as a regression.
 */

import { readFileSync } from "node:fs";

const BUCKETS = ["regression", "fix", "silent", "shape", "crash", "drift"];

function parseArgs(argv) {
  const positional = [];
  let limit = 12;
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") {
      limit = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--bucket") {
      only = argv[i + 1];
      i += 1;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error("usage: node scripts/grid/diff.mjs <base.json> <head.json> [--limit N]");
    process.exit(2);
  }
  if (only !== null && !BUCKETS.includes(only)) {
    console.error(`unknown bucket "${only}"; expected one of ${BUCKETS.join(", ")}`);
    process.exit(2);
  }
  return { base: positional[0], head: positional[1], limit, only };
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const json = (v) => JSON.stringify(v);
const isCrash = (r) => r.verdict === "throw" || r.verdict === "build-error";

function classify(a, b) {
  if (isCrash(a) || isCrash(b)) {
    return a.verdict === b.verdict && a.error === b.error ? null : "crash";
  }
  if (a.verdict === "valid" && b.verdict === "invalid") return "regression";
  if (a.verdict === "invalid" && b.verdict === "valid") return "fix";
  if (a.verdict === "valid" && b.verdict === "valid") {
    return json(a.value) === json(b.value) ? null : "silent";
  }
  // Both invalid: the verdict agrees, so only the reported reason can differ.
  if (json(a.codes) !== json(b.codes)) return "shape";
  return json(a.value) === json(b.value) ? null : "silent";
}

function main() {
  const { base, head, limit, only } = parseArgs(process.argv.slice(2));
  const a = read(base);
  const b = read(head);

  const found = Object.fromEntries(BUCKETS.map((k) => [k, []]));
  const keys = new Set([...Object.keys(a.results), ...Object.keys(b.results)]);

  for (const key of [...keys].sort()) {
    const ra = a.results[key];
    const rb = b.results[key];
    if (ra === undefined || rb === undefined) {
      found.drift.push({ key, base: ra ?? null, head: rb ?? null });
      continue;
    }
    const bucket = classify(ra, rb);
    if (bucket !== null) found[bucket].push({ key, base: ra, head: rb });
  }

  const total = BUCKETS.reduce((n, k) => n + found[k].length, 0);

  console.log(`base  ${base}  (${Object.keys(a.results).length} cases, oas ${a.meta.oasVersion})`);
  console.log(`head  ${head}  (${Object.keys(b.results).length} cases, oas ${b.meta.oasVersion})`);
  console.log("");
  console.log(BUCKETS.map((k) => `${k} ${found[k].length}`).join("   "));
  console.log("");

  if (total === 0) {
    console.log("no differences.");
    return 0;
  }

  for (const bucket of BUCKETS) {
    const rows = found[bucket];
    if (rows.length === 0) continue;
    if (only !== null && only !== bucket) continue;
    console.log(`## ${bucket} (${rows.length})`);
    console.log("");
    for (const row of rows.slice(0, limit)) {
      console.log(`  ${row.key}`);
      console.log(`      base  ${json(row.base)}`);
      console.log(`      head  ${json(row.head)}`);
    }
    if (rows.length > limit) {
      console.log(`  ... ${rows.length - limit} more (--limit ${rows.length} to see all)`);
    }
    console.log("");
  }

  if (found.drift.length > 0) {
    console.log("NOTE: the grid changed between these dumps, so the buckets above");
    console.log("undercount. Regenerate both dumps from the same cases.mjs.");
    console.log("");
  }

  return found.regression.length > 0 ? 1 : 0;
}

process.exit(main());
