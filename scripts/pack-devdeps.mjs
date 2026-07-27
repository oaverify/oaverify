// Strip / restore `devDependencies` on the current package's
// package.json around `pnpm pack`. Devdeps in a published tarball
// are dead weight; for sub-packages they additionally expose the
// `@oaverify/internal-*` workspace names (rewritten to `0.0.0`).
//
// Considered alternative: `clean-publish` (the canonical npm-ecosystem
// tool for this) is incompatible with our setup. Its documented pnpm-
// workspaces pattern relies on `publishConfig.directory`, which pnpm
// 10 mishandles for `workspace:*` deps at pack time (pnpm/pnpm#6253):
// `pnpm pack` errors with ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL,
// breaking the pack-smoke CI job that simulates a real install.
// `pnpm publish` handles it, but `pnpm pack` does not.
//
// Use:
//   prepack:  ... && node <path>/pack-devdeps.mjs strip
//   postpack: node <path>/pack-devdeps.mjs restore
//
// `strip` is self-healing: if a `.bak` from a previous failed run
// exists, it is restored first so the strip starts from a clean
// source.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const path = "package.json";
const bak = "package.json.bak";

if (mode === "strip") {
  if (existsSync(bak)) renameSync(bak, path);
  const orig = readFileSync(path, "utf8");
  writeFileSync(bak, orig);
  const pkg = JSON.parse(orig);
  delete pkg.devDependencies;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
} else if (mode === "restore") {
  if (existsSync(bak)) renameSync(bak, path);
} else {
  console.error(`pack-devdeps: expected "strip" or "restore", got ${JSON.stringify(mode)}`);
  process.exit(2);
}
