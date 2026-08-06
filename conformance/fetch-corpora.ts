/**
 * Clone the pinned corpora listed in `corpora.json`.
 *
 * Usage:
 *   pnpm corpora                             # every corpus
 *   pnpm corpora:json-schema                 # just one
 *
 * Fetches the pinned revision by SHA at depth 1, so this stays as cheap
 * as the `git clone --depth 1` it replaces while landing on a known
 * commit instead of whatever `main` happens to be. An existing checkout
 * already at the pin is left alone; one that has drifted is moved onto
 * the pin.
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

const requested = process.argv.slice(2);
const all = corpora();
const names = requested.length > 0 ? requested : Object.keys(all);

for (const name of names) {
  const entry = all[name];
  if (entry === undefined) {
    console.error(`${name}: not listed in corpora.json`);
    process.exit(2);
  }
  const dir = corpusPath(name);
  if (existsSync(dir)) {
    if (headRev(dir) === entry.rev) {
      console.log(`${name}: already at ${entry.rev.slice(0, 10)}`);
      continue;
    }
    console.log(`${name}: moving existing checkout onto the pin`);
  } else {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", entry.url);
  }
  git(dir, "fetch", "-q", "--depth", "1", "origin", entry.rev);
  git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  console.log(`${name}: at ${entry.rev.slice(0, 10)}`);
}
