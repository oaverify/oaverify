#!/usr/bin/env node
/**
 * Remove build output and incremental compiler state.
 *
 * The case this exists for: `tsc -b` caches per-project state in
 * `*.tsbuildinfo`, and if that state says a project is up to date while
 * its emitted `.d.ts` is missing or stale, `pnpm typecheck` reports
 * errors in files the author never touched. It looks exactly like a real
 * type error in someone else's code. A fresh clone never hits it, which
 * is what makes it confusing: CI is green and only the local checkout is
 * wrong.
 *
 * Everything removed here is gitignored and rebuilt by `pnpm build` or
 * `pnpm typecheck`, so this is always safe to run.
 */

import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Directories we never walk into. */
const SKIP = new Set(["node_modules", ".git"]);
/** Directory names to delete wholesale wherever they appear. */
const DIRS = new Set(["dist", "coverage", ".tsbuild"]);

const removed = [];

function walk(dir, depth) {
  // The tree is shallow (packages/*, sub-roots, sub-roots/*); no need to
  // descend into deep fixture directories.
  if (depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DIRS.has(entry.name)) {
        rmSync(abs, { recursive: true, force: true });
        removed.push(abs.slice(root.length + 1));
        continue;
      }
      walk(abs, depth + 1);
    } else if (entry.name.endsWith(".tsbuildinfo")) {
      rmSync(abs, { force: true });
      removed.push(abs.slice(root.length + 1));
    }
  }
}

walk(root, 0);

if (removed.length === 0) {
  console.log("clean: nothing to remove");
} else {
  for (const r of removed.sort()) console.log(`removed ${r}`);
  console.log(`clean: ${removed.length} path(s)`);
}
