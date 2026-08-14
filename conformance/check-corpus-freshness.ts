/**
 * Report which pinned corpora have fallen behind upstream.
 *
 * The pin in `corpora.json` makes a committed baseline reproducible, and
 * on its own it would also make the corpus invisible: a frozen suite
 * means the nightly run goes green forever while upstream adds cases we
 * have never been measured against. That is the failure this script
 * exists to prevent. The pin is the gate; this is the radar.
 *
 * It is deliberately not a `--check-baseline` style gate on correctness.
 * Being behind upstream is not a defect, it is a maintenance signal.
 * Bumping is a decision, because a bump can add cases we fail and that
 * has to be triaged rather than absorbed.
 *
 * Which is why being behind exits **zero** by default. Someone following
 * the README should not be handed a failure for a condition that is
 * expected to hold most of the time; the report is the output, not the
 * exit code. CI passes `--fail-if-stale`, because there the exit code is
 * the only thing anyone sees.
 *
 * Usage:
 *   pnpm corpora:stale                   # always exits 0; report only
 *   pnpm corpora:stale --fail-if-stale   # exit 1 if behind or unreachable (what CI runs)
 *   pnpm corpora:stale --quiet-if-current
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { corpora, corpusPath } from "./corpora.ts";

/** How much history to fetch when listing what landed. */
const LOG_DEPTH = 200;
/** Commit subjects to print before truncating. */
const LOG_LIMIT = 15;

function tryGit(args: string[], cwd?: string): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The SHA upstream's default branch points at, without needing a checkout. */
function upstreamHead(url: string): string | undefined {
  const out = tryGit(["ls-remote", url, "HEAD"]);
  return out?.split(/\s+/)[0];
}

/**
 * The commits between the pin and upstream, newest first.
 *
 * Needs a local checkout to fetch into, and the range can still be
 * unavailable when the pin is older than `LOG_DEPTH` or the shallow
 * boundary cuts it. Both cases return undefined and the caller falls
 * back to reporting the two revisions.
 */
function commitsSincePin(dir: string, rev: string): string[] | undefined {
  if (!existsSync(dir)) return undefined;
  if (
    tryGit(["fetch", "--quiet", "--depth", String(LOG_DEPTH), "origin", "HEAD"], dir) === undefined
  )
    return undefined;
  const log = tryGit(["log", "--oneline", "--no-decorate", `${rev}..FETCH_HEAD`], dir);
  if (log === undefined) return undefined;
  return log.length === 0 ? [] : log.split("\n");
}

const argv = process.argv.slice(2);
const quietIfCurrent = argv.includes("--quiet-if-current");
const failIfStale = argv.includes("--fail-if-stale");
const stale: string[] = [];
const unreachable: string[] = [];

for (const [name, entry] of Object.entries(corpora())) {
  const head = upstreamHead(entry.url);
  if (head === undefined) {
    unreachable.push(name);
    console.log(`${name}: could not reach ${entry.url}`);
    continue;
  }
  if (head === entry.rev) {
    if (!quietIfCurrent) console.log(`${name}: current (${entry.rev.slice(0, 10)})`);
    continue;
  }

  stale.push(name);
  const commits = commitsSincePin(corpusPath(name), entry.rev);
  const behind = commits === undefined ? "behind" : `${commits.length} commits behind`;
  console.log(`\n${name}: ${behind} upstream`);
  console.log(`  pinned:   ${entry.rev}`);
  console.log(`  upstream: ${head}`);
  if (commits !== undefined && commits.length > 0) {
    for (const line of commits.slice(0, LOG_LIMIT)) console.log(`    ${line}`);
    if (commits.length > LOG_LIMIT) console.log(`    ... ${commits.length - LOG_LIMIT} more`);
  }
}

if (stale.length === 0 && unreachable.length === 0) {
  if (!quietIfCurrent) console.log("\nAll corpora are at upstream HEAD.");
  process.exit(0);
}

// A corpus that could not be checked is not fresh, it is unknown. Under
// --fail-if-stale the exit code is what colours the `pins` badge, so an
// unreachable upstream must not read as "all current". The failure shows
// up as a red `pins` workflow and nothing else; it does not open the
// nightly tracking issue, which tracks regressions rather than pins.
if (unreachable.length > 0) {
  console.log(
    `\n${unreachable.length} corpus/corpora could not be checked: ${unreachable.join(", ")}.`,
  );
}
if (stale.length > 0) {
  console.log(
    `\n${stale.length} corpus/corpora behind upstream: ${stale.join(", ")}.\n` +
      `To take the new cases, bump "rev" in corpora.json, run \`pnpm corpora\`,\n` +
      `then re-measure the affected baselines in the same commit. Expect the\n` +
      `bump to add failures; that is the point of looking.\n` +
      `\nThis is a maintenance signal, not a failed test.`,
  );
}
process.exit(failIfStale ? 1 : 0);
