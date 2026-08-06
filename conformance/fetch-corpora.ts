/**
 * Clone the pinned corpora listed in `corpora.json`.
 *
 * Usage:
 *   pnpm corpora                             # every corpus, at its pin
 *   pnpm corpora:json-schema                 # just one
 *   pnpm corpora --latest                    # upstream HEAD instead (nightly)
 *
 * Fetches the pinned revision by SHA at depth 1, so this stays as cheap
 * as the `git clone --depth 1` it replaces while landing on a known
 * commit instead of whatever `main` happens to be. An existing checkout
 * already at the pin is left alone; one that has drifted is moved onto
 * the pin.
 *
 * `--latest` fetches upstream HEAD and prints the revision it landed on.
 * That is what the nightly wants: the pin makes the PR gate reproducible,
 * and this answers the question the pin cannot, which is whether we still
 * pass against what upstream has now. It deliberately leaves
 * `corpora.json` alone, so bumping a pin stays a reviewed commit rather
 * than something a scheduled job does behind you.
 *
 * Runners detect this themselves: `assertPinned` refuses to compare a
 * drifted checkout against a committed baseline, so a `--latest` fetch
 * has to be paired with `--floating` on the runner.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { corpora, corpusPath } from "./corpora.ts";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "inherit"] });
}

function headRev(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const argv = process.argv.slice(2);
const latest = argv.includes("--latest");
const requested = argv.filter((a) => !a.startsWith("--"));
const all = corpora();
const names = requested.length > 0 ? requested : Object.keys(all);

for (const name of names) {
  const entry = all[name];
  if (entry === undefined) {
    console.error(`${name}: not listed in corpora.json`);
    process.exit(2);
  }
  const dir = corpusPath(name);
  const target = latest ? "HEAD" : entry.rev;
  if (existsSync(dir)) {
    if (!latest && headRev(dir) === entry.rev) {
      console.log(`${name}: already at ${entry.rev.slice(0, 10)}`);
      continue;
    }
    console.log(latest ? `${name}: moving to upstream HEAD` : `${name}: moving onto the pin`);
  } else {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", entry.url);
  }
  git(dir, "fetch", "-q", "--depth", "1", "origin", target);
  git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  const landed = headRev(dir) ?? "unknown";
  if (latest) {
    const moved =
      landed === entry.rev ? " (same as the pin)" : ` (pin is ${entry.rev.slice(0, 10)})`;
    console.log(`${name}: at ${landed.slice(0, 10)}${moved}`);
  } else {
    console.log(`${name}: at ${landed.slice(0, 10)}`);
  }
}
