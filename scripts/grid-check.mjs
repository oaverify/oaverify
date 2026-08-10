/**
 * Differential check: run the parameter grid against a base revision and
 * against the working tree, then triage every difference.
 *
 *   pnpm grid-check              # against main
 *   pnpm grid-check <rev>        # against any revision
 *   pnpm grid-check <rev> --keep # leave the dumps and worktree in place
 *
 * This is the R3 relation from #753, the one that found things: on the
 * broad #742 fix it read 80 regressions / 448 fixes / 288 silent changes,
 * and on the narrowed fix 0 / 160 / 0, which is what made the narrowing
 * defensible rather than merely smaller.
 *
 * It is a review aid rather than a gate. A deliberate behaviour change
 * shows up here as a regression, and the fix bucket needs a human to
 * confirm each entry was intended.
 *
 * ## How the base revision gets built
 *
 * A temporary git worktree, because the grid has to run against a real
 * build of the base and the base does not contain this script. `dump.mjs`
 * takes `--root`, so one copy of the harness drives both checkouts and no
 * revision needs to know it is being measured.
 *
 * `node_modules` is symlinked from the main checkout when the lockfile is
 * identical between the two revisions, which is the common case and turns
 * a two-minute install into a two-second one. When the lockfile differs the
 * worktree installs its own.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe", ...opts });

function step(msg) {
  process.stderr.write(`grid-check: ${msg}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const rev = argv.find((a) => !a.startsWith("--")) ?? "main";

  let baseSha;
  try {
    baseSha = run("git", ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  } catch {
    console.error(`grid-check: cannot resolve revision "${rev}"`);
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), "oav-grid-"));
  const tree = join(work, "base");
  const dumps = join(work, "dumps");
  mkdirSync(dumps, { recursive: true });

  let failed = false;
  try {
    step(`base ${rev} (${baseSha.slice(0, 7)})`);
    run("git", ["worktree", "add", "--detach", tree, baseSha]);

    // Reuse the main checkout's installed tree when the lockfile agrees,
    // which is what makes this fast enough to run on every branch.
    const lockChanged =
      run("git", ["diff", "--name-only", baseSha, "--", "pnpm-lock.yaml"]).trim() !== "";
    if (lockChanged) {
      step("lockfile differs from the base; installing in the worktree");
      run("pnpm", ["install", "--frozen-lockfile"], { cwd: tree, stdio: "inherit" });
    } else {
      step("lockfile unchanged; linking node_modules");
      linkModules(tree);
    }

    step("building base");
    run("pnpm", ["build"], { cwd: tree });
    step("building head");
    run("pnpm", ["build"]);

    const baseDump = join(dumps, "base.json");
    const headDump = join(dumps, "head.json");
    step("running the grid against base");
    run("node", [join(ROOT, "scripts/grid/dump.mjs"), baseDump, "--root", tree], {
      stdio: "inherit",
    });
    step("running the grid against head");
    run("node", [join(ROOT, "scripts/grid/dump.mjs"), headDump, "--root", ROOT], {
      stdio: "inherit",
    });

    process.stderr.write("\n");
    try {
      run("node", [join(ROOT, "scripts/grid/diff.mjs"), baseDump, headDump], { stdio: "inherit" });
    } catch (err) {
      // diff.mjs exits 1 when the regression bucket is non-empty.
      failed = err?.status === 1;
      if (!failed) throw err;
    }

    if (keep) process.stderr.write(`\ngrid-check: dumps in ${dumps}\n`);
  } finally {
    if (!keep) {
      try {
        run("git", ["worktree", "remove", "--force", tree]);
      } catch {
        /* the worktree may never have been created */
      }
      rmSync(work, { recursive: true, force: true });
    } else {
      process.stderr.write(`grid-check: worktree left at ${tree}\n`);
      process.stderr.write(`grid-check: remove it with "git worktree remove --force ${tree}"\n`);
    }
  }

  process.exit(failed ? 1 : 0);
}

/** Symlink every installed node_modules from the main checkout into `tree`. */
function linkModules(tree) {
  const dirs = ["node_modules"];
  for (const pkg of run("git", ["ls-files", "packages/*/package.json"]).trim().split("\n")) {
    if (pkg !== "") dirs.push(join(dirname(pkg), "node_modules"));
  }
  for (const dir of dirs) {
    const from = join(ROOT, dir);
    if (!existsSync(from)) continue;
    const to = join(tree, dir);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) symlinkSync(from, to, "dir");
  }
}

main();
