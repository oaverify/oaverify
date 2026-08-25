// Assert conformance/REPORT.md's numbers against the committed baselines.
//
// The report is hand-written prose over numbers six runners produce, and
// nothing checked it, so it drifted in the two ways a hand-copied number
// drifts (#937). It carried a "Generated <date> against commit <sha>" stamp
// that went 167 commits stale; #945 then refreshed the format section
// underneath that stamp, so the document attributed fresh measurements to a
// commit that did not produce them. Separately, #805 raised the required
// row when a fix closed one required and one optional case, and left the
// optional row alone, so the summary table disagreed with the report's own
// optional breakdown two sections below it.
//
// What is gated, and what is not, because the header says so and must stay
// true:
//
//   Against committed baselines: the required-suite row and the sentence
//   beside it, the overlay row and all three translator buckets, and the
//   format subtree's size, score and both failure directions.
//
//   Against three independent statements of the same fact: the +optional
//   row. Its runner writes a gitignored file, so the row is bounded by the
//   committed required baseline (same errors, no fewer mismatches, more
//   cases) and cross-checked against both the prose sentence and the
//   per-file table that enumerate its non-passing cases. Agreeing with the
//   required baseline and disagreeing with either statement fails.
//
//   Not gated: the petstore row, whose runner also writes a gitignored
//   file and which has no second statement to check against, and the
//   derived figures in the prose (162 extra cases, 425 expecting a
//   rejection, "58 of the 61 failures").
//
// A review of the first draft built three inputs that passed when they
// should have failed, all worth knowing before editing:
//
//   A count with no left boundary matched as a suffix of the stale number
//   already there, so "0 **false accepts**" passed against "40 **false
//   accepts**". Every count needs \b.
//
//   Comparing two hand-typed strings to each other is not a gate: the
//   first draft checked the +optional row against the prose sentence and
//   nothing else, so restoring both to main's wrong numbers together was
//   green. Every claim needs a source that is not prose.
//
//   `includes()` over the whole document asks whether a string exists,
//   not whether it is in the sentence that matters. Section-scope first.
//
// Exit 0 clean; exit 1 with every mismatch listed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

const REPORT = "conformance/REPORT.md";
const report = read(REPORT);
const problems = [];
const say = (m) => problems.push(m);

const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
const cells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

/** A `## ` section of the report, up to the next `## `. */
function section(heading) {
  const start = report.indexOf(`\n## ${heading}\n`);
  if (start === -1) return null;
  const rest = report.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The one summary row whose first cell starts with `label`. Two is an error. */
function summaryRow(label) {
  const hits = report.split("\n").filter((l) => l.startsWith(`| ${label}`));
  if (hits.length === 0) {
    say(`${REPORT}: no "${label}" summary row`);
    return null;
  }
  if (hits.length > 1) {
    say(`${REPORT}: ${hits.length} rows start with "${label}"; the check needs exactly one`);
    return null;
  }
  return cells(hits[0]);
}

/** Assert `text` states `count` immediately before `phrase`, and not as a suffix. */
function statesCount(text, where, count, phrase) {
  if (!new RegExp(`\\b${count} ${phrase}`).test(text)) {
    say(`${REPORT}: ${where} does not state "${count} ${phrase.replace(/\\/g, "")}"`);
  }
}

const required = json("conformance/json-schema-results.json");
const requiredTotals = {
  cases: sum(required, "cases"),
  pass: sum(required, "pass"),
  mismatch: sum(required, "fail"),
  error: sum(required, "error"),
};

// 1. Required suite: the summary row, and the sentence that restates it.
{
  const row = summaryRow("JSON Schema Test Suite (required)");
  if (row) {
    const got = { cases: +row[1], pass: +row[2], mismatch: +row[3], error: +row[4] };
    for (const k of Object.keys(requiredTotals)) {
      if (got[k] !== requiredTotals[k]) {
        say(
          `${REPORT}: required-suite ${k} is ${got[k]}, json-schema-results.json says ${requiredTotals[k]}`,
        );
      }
    }
    const pct = `${((100 * requiredTotals.pass) / requiredTotals.cases).toFixed(1)}%`;
    if (row[5] !== pct) say(`${REPORT}: required-suite % pass is ${row[5]}, computes to ${pct}`);
  }
  const m = /The (\d+) non-passing required-suite\s+cases \((\d+) mismatch \+ (\d+) error\)/.exec(
    report,
  );
  if (!m) {
    say(
      `${REPORT}: no "The <n> non-passing required-suite cases (<n> mismatch + <n> error)" sentence`,
    );
  } else {
    const [total, mismatch, error] = [+m[1], +m[2], +m[3]];
    const want = requiredTotals.mismatch + requiredTotals.error;
    if (total !== want || mismatch !== requiredTotals.mismatch || error !== requiredTotals.error) {
      say(
        `${REPORT}: the required-suite sentence says ${total} (${mismatch} mismatch + ${error} error), ` +
          `json-schema-results.json says ${want} (${requiredTotals.mismatch} + ${requiredTotals.error})`,
      );
    }
  }
}

// 2. Overlay: the summary row, the parity phrase, and the three buckets.
{
  const o = json("conformance/overlay-results.json");
  const row = summaryRow("OpenAPI Overlay 1.0 (envelope)");
  if (row && (+row[1] !== o.cases || +row[2] !== o.envelopePass)) {
    say(
      `${REPORT}: overlay row is ${row[1]} cases / ${row[2]} pass, ` +
        `overlay-results.json says ${o.cases} / ${o.envelopePass}`,
    );
  }
  const overlay = section("OpenAPI Overlay 1.0");
  if (overlay === null) {
    say(`${REPORT}: no "## OpenAPI Overlay 1.0" section`);
  } else {
    if (!overlay.includes(`**${o.envelopePass}/${o.cases} envelope parity**`)) {
      say(
        `${REPORT}: the Overlay section does not state "**${o.envelopePass}/${o.cases} envelope parity**"`,
      );
    }
    for (const [bucket, count] of [
      ["`ok`", o.translatorOk],
      ["`unrecognised-target`", o.translatorUnrecognised],
      ["`translator-error`", o.translatorError],
    ]) {
      const line = overlay.split("\n").find((l) => l.startsWith(`| ${bucket}`));
      if (!line) say(`${REPORT}: no translator bucket row for ${bucket}`);
      else if (+cells(line)[1] !== count) {
        say(
          `${REPORT}: translator ${bucket} is ${cells(line)[1]}, overlay-results.json says ${count}`,
        );
      }
    }
  }
}

// 3. Format subtree.
{
  const f = json("conformance/format-results.json");
  const optional = section("Optional-suite breakdown");
  if (optional === null) {
    say(`${REPORT}: no "## Optional-suite breakdown" section to check the format numbers in`);
  } else {
    const where = "the format section";
    statesCount(optional, where, sum(f, "cases"), `cases across ${f.length} formats`);
    if (!optional.includes(`**${sum(f, "pass")}/${sum(f, "cases")}**`)) {
      say(`${REPORT}: ${where} does not state "**${sum(f, "pass")}/${sum(f, "cases")}**"`);
    }
    statesCount(optional, where, sum(f, "falseAccept"), "\\*\\*false accepts\\*\\*");
    statesCount(optional, where, sum(f, "falseReject"), "\\*\\*false rejects\\*\\*");
  }
}

// 4. +optional: bounded by the committed required baseline, and cross-checked
//    against both statements of its own non-passing set.
{
  const row = summaryRow("JSON Schema Test Suite (+ optional)");
  const sentence = /The (\d+) non-passing optional\s+cases \((\d+) mismatch \+ (\d+) error\)/.exec(
    report,
  );

  // The per-file table under the sentence, which is the third statement.
  const optional = section("Optional-suite breakdown") ?? "";
  const table = { mismatch: 0, error: 0 };
  let tableRows = 0;
  for (const line of optional.split("\n")) {
    if (!line.startsWith("| `")) continue;
    tableRows += 1;
    for (const m of cells(line)[1].matchAll(/(\d+) (mismatch|mismatches|error|errors)\b/g)) {
      table[m[2].startsWith("mismatch") ? "mismatch" : "error"] += +m[1];
    }
  }

  if (!sentence) {
    say(`${REPORT}: no "The <n> non-passing optional cases (<n> mismatch + <n> error)" sentence`);
  }
  if (tableRows === 0) say(`${REPORT}: no per-file breakdown table under the optional section`);

  if (row && sentence && tableRows > 0) {
    const stated = { total: +sentence[1], mismatch: +sentence[2], error: +sentence[3] };
    const rowN = { cases: +row[1], pass: +row[2], mismatch: +row[3], error: +row[4] };

    if (stated.mismatch !== table.mismatch || stated.error !== table.error) {
      say(
        `${REPORT}: the optional sentence says ${stated.mismatch} mismatch / ${stated.error} error, ` +
          `its own per-file table sums to ${table.mismatch} / ${table.error}`,
      );
    }
    if (stated.mismatch + stated.error !== stated.total) {
      say(
        `${REPORT}: the optional sentence says ${stated.total} non-passing but ` +
          `${stated.mismatch} + ${stated.error}`,
      );
    }
    if (rowN.mismatch !== table.mismatch || rowN.error !== table.error) {
      say(
        `${REPORT}: +optional row says ${rowN.mismatch} mismatch / ${rowN.error} error, ` +
          `the per-file table sums to ${table.mismatch} / ${table.error}`,
      );
    }
    if (rowN.cases - rowN.pass !== table.mismatch + table.error) {
      say(
        `${REPORT}: +optional row is ${rowN.cases} cases / ${rowN.pass} pass, a gap of ` +
          `${rowN.cases - rowN.pass}, against ${table.mismatch + table.error} non-passing`,
      );
    }
    const pct = `${((100 * rowN.pass) / rowN.cases).toFixed(1)}%`;
    if (row[5] !== pct) say(`${REPORT}: +optional % pass is ${row[5]}, computes to ${pct}`);

    // Bounds from the committed required baseline: --optional only adds
    // files, so it cannot lose a case, resolve a required mismatch, or
    // change the error set.
    if (rowN.cases <= requiredTotals.cases) {
      say(
        `${REPORT}: +optional row has ${rowN.cases} cases, not more than the required suite's ${requiredTotals.cases}`,
      );
    }
    if (rowN.error !== requiredTotals.error) {
      say(
        `${REPORT}: +optional row has ${rowN.error} errors, the committed required baseline has ${requiredTotals.error}`,
      );
    }
    if (rowN.mismatch < requiredTotals.mismatch) {
      say(
        `${REPORT}: +optional row has ${rowN.mismatch} mismatches, fewer than the committed required baseline's ${requiredTotals.mismatch}`,
      );
    }
  }
}

// 5. The README headline an evaluator reads before opening the report, checked
//    on the bullet that carries it rather than anywhere in the file.
{
  const headline = `${requiredTotals.pass}/${requiredTotals.cases}`;
  const bullet = read("README.md")
    .split("\n")
    .find((l) => l.includes("on the") && /\d+\/\d+/.test(l) && l.startsWith("- **"));
  if (!bullet) say(`README.md: no required-suite headline bullet to check`);
  else if (!bullet.includes(headline)) {
    say(
      `README.md: the headline bullet says "${/\d+\/\d+/.exec(bullet)?.[0]}", baselines give ${headline}`,
    );
  }
}

// 6. The stamp must not come back.
if (/Generated \d{4}-\d{2}-\d{2} against commit/.test(report)) {
  say(
    `${REPORT}: carries a hand-typed "Generated <date> against commit <sha>" stamp again. ` +
      `It went 167 commits stale and then outlived a partial refresh underneath it (#937).`,
  );
}

if (problems.length > 0) {
  console.error("check-conformance-report: REPORT.md disagrees with the committed baselines\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nRe-run the conformance runners (see ${REPORT}'s Reproduce section) and carry\n` +
      `the numbers across, or correct the report against the committed baselines.`,
  );
  process.exit(1);
}

console.log(
  "check-conformance-report: REPORT.md's required, overlay and format numbers agree with " +
    "the committed baselines, and its +optional row agrees with the required baseline's " +
    "bounds and with both statements of its own non-passing set.",
);
