/**
 * Tests for the verdict rules in `openapi-case-outcome.ts`.
 *
 * `conformance/` has no unit-test harness, only tsx runners composed by
 * `pnpm check`, so this follows that idiom: assertions, a summary line,
 * and a non-zero exit. Adding vitest here would mean a devDependency, a
 * config and a dependabot entry for one module.
 *
 * Every case below is a defect that reached this repository. Three
 * review passes on #804 each found a blocking one, and all of them live
 * in branches that fire only when something has already gone wrong,
 * which is when nobody reads the output closely.
 *
 * Scope: the pure verdict rules only. The runner's liveness probes
 * (`assertCliAnswers`, `assertCliUnchanged`) need a live process and a
 * filesystem race, so they are verified by hand and tracked in #920.
 *
 * Usage:
 *   pnpm tsx run-openapi-selftest.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { makeOutcome, selectStderrLine, stampCli, type Case } from "./openapi-case-outcome.js";

let failed = 0;
let ran = 0;

function it(name: string, body: () => void): void {
  ran += 1;
  try {
    body();
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`);
  }
}

/** A `spawnSync` result, defaulted to the healthy shape. */
function spawn(over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...over,
  } as SpawnSyncReturns<string>;
}

const validCase: Case = { name: "c", kind: "request", method: "GET", path: "/p", expect: "valid" };
const invalidCase: Case = { ...validCase, expect: "invalid" };
const TREE = JSON.stringify({ code: "root", children: [{ code: "type" }] });

// --- the #804 regression itself ------------------------------------

it("exit 1 with no stdout is an error, not a verdict", () => {
  const o = makeOutcome(invalidCase, spawn({ status: 1 }));
  assert.equal(o.actual, "error");
  assert.equal(o.pass, false);
  assert.match(o.note ?? "", /^CLI exited 1 without a parseable JSON verdict/);
});

it("exit 1 with a parsed tree is a verdict, and collects codes", () => {
  const o = makeOutcome(invalidCase, spawn({ status: 1, stdout: TREE }));
  assert.equal(o.actual, "invalid");
  assert.equal(o.pass, true);
  assert.deepEqual(o.actualCodes, ["root", "type"]);
  assert.equal(o.note, undefined);
});

it("exit 1 with truncated JSON is an error, not a verdict", () => {
  assert.equal(
    makeOutcome(invalidCase, spawn({ status: 1, stdout: TREE.slice(0, 20) })).actual,
    "error",
  );
});

it("exit 0 stays valid, which only the runner's probes can qualify", () => {
  assert.equal(makeOutcome(validCase, spawn({ status: 0 })).actual, "valid");
});

for (const status of [2, 3]) {
  it(`exit ${status} is an error`, () => {
    assert.equal(makeOutcome(validCase, spawn({ status })).actual, "error");
  });
}

// --- how a dead process is described -------------------------------

it("a signalled process reports the signal, which is all SIGKILL leaves", () => {
  const o = makeOutcome(validCase, spawn({ status: null, signal: "SIGKILL", stderr: "" }));
  assert.equal(o.note, "CLI was killed by SIGKILL without a parseable JSON verdict");
});

it("a spawn failure reports its error, since stdio is undefined there", () => {
  const o = makeOutcome(
    validCase,
    spawn({
      status: null,
      signal: null,
      stdout: undefined as unknown as string,
      stderr: undefined as unknown as string,
      error: new Error("spawnSync /usr/bin/node ENOENT"),
    }),
  );
  assert.match(o.note ?? "", /^CLI failed to spawn.*ENOENT/);
});

it("a maxBuffer kill reads as killed, not as a failure to spawn", () => {
  // `spawnSync` sets BOTH `error` and `signal` here, and the process ran.
  const o = makeOutcome(
    validCase,
    spawn({ status: null, signal: "SIGTERM", error: new Error("spawnSync ENOBUFS") }),
  );
  assert.match(o.note ?? "", /^CLI was killed by SIGTERM/);
});

it("the note is always one line, so the report table survives it", () => {
  assert.equal(
    makeOutcome(validCase, spawn({ status: 1, stderr: "a\nb\nc" })).note?.includes("\n"),
    false,
  );
});

it("a long detail is capped without splitting a surrogate pair", () => {
  const note =
    makeOutcome(validCase, spawn({ status: 1, stderr: `Error: ${"A".repeat(152)}\u{1F600}tail` }))
      .note ?? "";
  assert.equal(note.includes("\uD83D") && !note.includes("\u{1F600}"), false);
});

// --- picking the line that says something --------------------------

const STDERR: Array<[string, string, string]> = [
  [
    "module resolution, the #804 shape",
    "node:internal/modules/run_main:123\n    triggerUncaughtException(\n    ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/y.js'\n    at file:///z",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/y.js'",
  ],
  [
    "a throw of a non-Error, which has no Error line at all",
    '/abs/path/cli.js:2\nthrow "just a string";\n^\njust a string\n(Use `node --trace-uncaught ...`)',
    "just a string",
  ],
  [
    "an OOM abort, which prints no caret",
    "<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed",
    "FATAL ERROR: Reached heap limit Allocation failed",
  ],
  ["nothing at all, as a SIGKILL leaves", "", ""],
  [
    "the CLI's own diagnostic, which has no caret either",
    "error: failed to read spec.yaml",
    "error: failed to read spec.yaml",
  ],
];
for (const [label, stderr, expected] of STDERR) {
  it(`selects the message from ${label}`, () => {
    assert.equal(selectStderrLine(stderr), expected);
  });
}

// --- the binary-identity stamp -------------------------------------

it("a missing binary stamps as absent rather than throwing", () => {
  // Throwing here would surface as exit 1, this runner's "cases failed",
  // for what is really "results are meaningless".
  assert.equal(stampCli(join(tmpdir(), "oaverify-definitely-absent-xyz")), "absent");
});

it("a rewritten binary stamps differently", () => {
  const dir = mkdtempSync(join(tmpdir(), "oaverify-stamp-"));
  try {
    const f = join(dir, "cli.js");
    writeFileSync(f, "one");
    const before = stampCli(f);
    assert.notEqual(before, "absent");
    writeFileSync(f, "two");
    assert.notEqual(stampCli(f), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${ran - failed}/${ran} openapi-case-outcome self-tests pass`);
if (failed > 0) process.exit(1);
