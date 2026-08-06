/**
 * The pinned-corpus registry, shared by `pnpm corpora` and the runners.
 *
 * Every corpus checkout under `conformance/` is gitignored, so the
 * revision a committed baseline was measured against lives in
 * `corpora.json` and nowhere else. Two things read it:
 * `fetch-corpora.ts`, which clones at the pin, and `assertPinned`,
 * which the runners call so a drifted checkout fails loudly instead of
 * quietly reporting different numbers.
 *
 * That second half is the point. A floating `git clone --depth 1` is
 * how an issue's measurement and a fresh clone's measurement come to
 * disagree with nothing to point at.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname);

export interface Corpus {
  url: string;
  rev: string;
  note?: string;
}

interface CorporaFile {
  corpora: Record<string, Corpus>;
}

export function corpora(): Record<string, Corpus> {
  const raw = readFileSync(join(ROOT, "corpora.json"), "utf8");
  return (JSON.parse(raw) as CorporaFile).corpora;
}

export function corpusPath(name: string): string {
  return join(ROOT, name);
}

/** The checkout's HEAD revision, or undefined for a missing or non-git dir. */
export function headRev(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Exit with a usable message unless `name` has a git checkout at all.
 *
 * The floating runners' lighter sibling of `assertPinned`: any revision
 * is acceptable there, but a missing or non-git directory still wants
 * the clean exit-2 message rather than a raw ENOENT or git stderr.
 */
export function assertPresent(name: string): void {
  const dir = corpusPath(name);
  if (!existsSync(dir)) {
    console.error(`${name}: not cloned. Run: pnpm corpora`);
    process.exit(2);
  }
  if (headRev(dir) === undefined) {
    console.error(`${name}: ${dir} is not a git checkout; remove it and run: pnpm corpora`);
    process.exit(2);
  }
}

/**
 * Exit with a usable message unless `name` is checked out at its pin.
 *
 * Called by every runner that compares against a committed baseline.
 * The three failure modes get three different messages, because
 * "missing" wants `pnpm corpora` and "drifted" wants a decision about
 * which of the two revisions is the one you meant.
 */
export function assertPinned(name: string): void {
  const entry = corpora()[name];
  if (entry === undefined) {
    console.error(`${name}: not listed in corpora.json.`);
    process.exit(2);
  }
  assertPresent(name);
  const dir = corpusPath(name);
  const head = headRev(dir);
  if (head !== entry.rev) {
    console.error(
      `${name}: checkout drifted from the pin.\n` +
        `  pinned:   ${entry.rev}\n` +
        `  checkout: ${head}\n` +
        `Baselines were measured at the pin. Either restore it:\n` +
        `  git -C ${dir} fetch --depth 1 origin ${entry.rev} && git -C ${dir} checkout FETCH_HEAD\n` +
        `or bump "rev" in corpora.json and re-measure the baselines in the same commit.`,
    );
    process.exit(2);
  }
}
