// Assert docs/comparison.md's defect-detection table against the generated
// detection/results/matrix.md that it summarises.
//
// `pnpm detect` regenerates the matrix; the doc quotes it by hand. Nothing
// asserted one against the other, and by #936 the two disagreed on every
// axis that can drift: the lint class size (7 vs 9), three of the four
// scores in it, two competitor totals, both competitor versions, and the
// seeded-case count in the prose. The matrix had been regenerated against
// oaverify 5.4.0 and the doc never followed.
//
// detection/ is typecheck-only in CI on purpose (`pnpm detect` rewrites
// three committed files, so a `check` that ran it would dirty the tree), so
// this does not re-run the corpus. It asserts that whoever last ran it
// carried the numbers across.
//
// Two decisions worth knowing before editing:
//
//   Everything is scoped to the "## Defect detection" section. A first
//   draft asked `doc.includes(version)` against the whole file, which the
//   performance section satisfies for free: it already names Ajv 8.20.0 and
//   carries its own run date, so the ajv arm asserted nothing at all.
//
//   The prose counts are matched by three literal sentence patterns rather
//   than by looking for the digits anywhere nearby. Digit-presence was
//   satisfiable by a different number in the same sentence, so "oaverify
//   catches 29 of the 29" passed on the strength of "raises 25 findings",
//   and a spectral total that drifted to 22 passed on redocly's 22. The
//   cost is that rewording the sentence fails loudly here; that is the
//   intended direction.
//
// Exit 0 clean; exit 1 with every mismatch listed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const MATRIX = "detection/results/matrix.md";
const DOC = "docs/comparison.md";
const TOOLS = ["oaverify", "ajv", "spectral", "redocly"];

const matrix = read(MATRIX);
const wholeDoc = read(DOC);
const problems = [];
const say = (m) => problems.push(m);

/** The "## Defect detection" section, up to the next h2. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

const doc = section(wholeDoc, "Defect detection");
if (doc === null) {
  console.error(`check-detection-table: ${DOC} has no "## Defect detection" section`);
  process.exit(1);
}

/** Split a markdown table row into trimmed cells. */
const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().replace(/\s+/g, " "));

/**
 * The header cells and body rows of the summary table `startPattern` opens.
 * Duplicate labels are reported rather than collapsed: keying by label
 * alone let a bogus row hide behind a real one with the same name.
 */
function summaryTable(text, startPattern, where) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => startPattern.test(l));
  if (start === -1) return null;
  const header = cells(lines[start]);
  const rows = new Map();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const c = cells(line);
    if (rows.has(c[0])) say(`${where}: duplicate summary row "${c[0]}"`);
    rows.set(c[0], c.slice(1));
  }
  return { header, rows };
}

const want = summaryTable(matrix, /^\| class \| oaverify \|/, MATRIX);
const got = summaryTable(doc, /^\| class\s+\| oaverify \|/, DOC);

if (!want) say(`${MATRIX}: no summary table found`);
if (!got) say(`${DOC}: no defect-detection summary table found`);

if (want && got) {
  // The header decides which column each score belongs to, so a reordered
  // header silently reattributes every row.
  if (want.header.join(" ") !== got.header.join(" ")) {
    say(
      `${DOC}: summary header is "${got.header.join(" | ")}", ${MATRIX} has "${want.header.join(" | ")}"`,
    );
  }
  for (const [label, cols] of want.rows) {
    const mine = got.rows.get(label);
    if (!mine) say(`${DOC}: missing summary row "${label}"`);
    else if (mine.join(" ") !== cols.join(" ")) {
      say(`${DOC}: row "${label}" is "${mine.join(" ")}", ${MATRIX} says "${cols.join(" ")}"`);
    }
  }
  for (const label of got.rows.keys()) {
    if (!want.rows.has(label)) say(`${DOC}: summary row "${label}" is not in ${MATRIX}`);
  }
}

// Versions and run date, inside the detection section only.
const header = matrix.slice(0, matrix.indexOf("| case |"));
const runDate = /^Run (\d{4}-\d{2}-\d{2}) against:/m.exec(header)?.[1];
const versions = new Map();
for (const m of header.matchAll(/^- (\S+) (\S+)$/gm)) versions.set(m[1], m[2]);

if (!runDate) say(`${MATRIX}: no "Run <date> against:" header`);
else if (!doc.includes(runDate)) {
  say(`${DOC}: the defect-detection section does not name the matrix run date ${runDate}`);
}
for (const [tool, version] of versions) {
  const named = tool === "oaverify" ? `oaverify ${version}` : version;
  if (!doc.includes(named)) {
    say(
      `${DOC}: the defect-detection section does not name ${tool} ${version}, ` +
        `which ${MATRIX} was run against`,
    );
  }
}

// Prose counts, recomputed from the matrix's per-case rows.
const caseRows = matrix
  .split("\n")
  .filter((l) => l.startsWith("| `"))
  .map(cells);
const seeded = caseRows.filter((r) => r[1] !== "control");
const catches = Object.fromEntries(
  TOOLS.map((t, i) => [t, seeded.filter((r) => r[2 + i] === "yes").length]),
);
const raised = Object.fromEntries(
  TOOLS.map((t, i) => [t, want ? Number(want.rows.get("total findings raised")?.[i]) : NaN]),
);

const patterns = [
  [/Across (\d+) seeded-defect cases/, [["seeded-case count", () => seeded.length]]],
  [
    /oaverify raises (\d+) findings and catches (\d+) of the (\d+)/,
    [
      ["oaverify findings raised", () => raised.oaverify],
      ["oaverify catch total", () => catches.oaverify],
      ["seeded-case count", () => seeded.length],
    ],
  ],
  [
    /Spectral raises (\d+) findings to catch (\d+)/,
    [
      ["spectral findings raised", () => raised.spectral],
      ["spectral catch total", () => catches.spectral],
    ],
  ],
  [
    /Redocly (\d+) to catch (\d+)/,
    [
      ["redocly findings raised", () => raised.redocly],
      ["redocly catch total", () => catches.redocly],
    ],
  ],
];

for (const [re, fields] of patterns) {
  const m = re.exec(doc);
  if (!m) {
    say(`${DOC}: no sentence matching ${re} to check the prose counts against`);
    continue;
  }
  fields.forEach(([what, expected], i) => {
    const value = expected();
    if (Number(m[i + 1]) !== value) {
      say(`${DOC}: prose ${what} is ${m[i + 1]}, ${MATRIX} gives ${value}`);
    }
  });
}

if (problems.length > 0) {
  console.error("check-detection-table: docs/comparison.md disagrees with the generated matrix\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nRe-run \`cd detection && pnpm detect\` and carry the numbers into ${DOC}, or\n` +
      `carry the committed matrix's numbers across if the corpus has not moved.`,
  );
  process.exit(1);
}

console.log(
  `check-detection-table: ${want.rows.size} summary rows, ${versions.size} tool versions ` +
    `and ${seeded.length} seeded cases agree between ${DOC} and ${MATRIX}.`,
);
