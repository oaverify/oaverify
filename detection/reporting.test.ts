import assert from "node:assert/strict";
import type { DetectionCase } from "./cases.ts";
import { oaverifyCheckRun } from "./oaverify.ts";
import {
  auditLine,
  classSummaryCell,
  controlFalsePositiveCount,
  mark,
  rowForCase,
  totalFatalRuns,
  totalFindingsRaised,
  type ToolRun,
} from "./reporting.ts";

const matchingRun: ToolRun = {
  findings: [{ rule: "schema", message: "bad keyword", location: "/keyword", severity: "error" }],
};
const fatalWithFinding: ToolRun = {
  findings: [{ rule: "schema", message: "bad keyword", location: "/keyword", severity: "error" }],
  fatal: "stack trace mentioned bad keyword",
};
const emptyFatal: ToolRun = { findings: [], fatal: "" };

const seeded: DetectionCase = {
  id: "malformed/example",
  class: "malformed",
  defect: "bad keyword",
  signals: ["bad keyword"],
  oaverify: "catches",
};
const seededSibling: DetectionCase = {
  ...seeded,
  id: "malformed/other",
};
const control: DetectionCase = {
  id: "control/example",
  class: "control",
  defect: "nothing is wrong",
  signals: ["bad keyword"],
  oaverify: "misses",
};

const fatalSeeded = rowForCase(seeded, [["tool", fatalWithFinding]]);
const caughtSeeded = rowForCase(seededSibling, [["tool", matchingRun]]);
const fatalControl = rowForCase(control, [["tool", emptyFatal]]);
const oaverifyExit2 = rowForCase(seeded, [
  ["oaverify", oaverifyCheckRun(2, undefined, "check: bad keyword")],
]);
const oaverifyExit2Miss = rowForCase(seeded, [
  ["oaverify", oaverifyCheckRun(2, undefined, "check: different failure")],
]);
const oaverifyCrash = rowForCase(seeded, [
  ["oaverify", oaverifyCheckRun(1, undefined, "node crashed")],
]);

assert.equal(fatalSeeded.fatal.tool, true);
assert.equal(fatalSeeded.caught.tool, false);
assert.equal(fatalSeeded.counts.tool, 0);
assert.equal(mark(fatalSeeded.caught.tool, fatalSeeded.fatal.tool, fatalSeeded.class), "ERR");
assert.equal(classSummaryCell([fatalSeeded, caughtSeeded], "tool"), "1/1");

assert.equal(fatalControl.fatal.tool, true);
assert.equal(controlFalsePositiveCount([fatalControl], "tool"), 0);
assert.equal(totalFindingsRaised([fatalSeeded, caughtSeeded, fatalControl], "tool"), 1);
assert.equal(totalFatalRuns([fatalSeeded, caughtSeeded, fatalControl], "tool"), 2);
assert.equal(auditLine(fatalControl, "tool", emptyFatal), "- **tool**: tool failed (no output)");

assert.equal(oaverifyExit2.fatal.oaverify, false);
assert.equal(oaverifyExit2.caught.oaverify, true);
assert.equal(oaverifyExit2.counts.oaverify, 1);
assert.equal(classSummaryCell([oaverifyExit2, oaverifyExit2Miss], "oaverify"), "1/2");
assert.equal(totalFatalRuns([oaverifyExit2, oaverifyExit2Miss, oaverifyCrash], "oaverify"), 1);

process.stdout.write("reporting fatal semantics: ok\n");
