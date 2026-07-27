// Guard the workspace dependency graph the CLAUDE.md "Dependency graph
// (strictly enforced; no cycles)" section promises. Checks over every
// packages/*/package.json, scoped to internal `@oaverify/internal-*` specifiers (peer
// deps like express / fastify and external deps are out of scope):
//
//   1. ACYCLIC: the runtime @oaverify/internal-* graph (from `dependencies`) has no
//      cycle. This is the DAG the internal private packages form.
//   2. NO DRIFT between declarations and imports, both directions:
//        - phantom:    declared but never imported in shipped src (what
//                      #346 removed: cli->router, formats->core).
//        - undeclared: imported in shipped src but not declared (the more
//                      dangerous direction; works only by lockfile luck).
//
// "Declared" unions `dependencies` and `devDependencies`, because the two
// package kinds carry their @oaverify/internal-* deps differently: the internal private
// packages (`@oaverify/internal-*`) depend at runtime via `dependencies`, while the
// published `@aahoughton/*` packages tsup-bundle everything, so their
// @oaverify/internal-* sit in `devDependencies` (build/typecheck only) and their runtime
// dep is `@oaverify/core`. The cycle check uses `dependencies` only
// (the runtime DAG); the bundles contribute no runtime @oaverify/internal-* edges.
//
// Considered alternative: madge. It detects MODULE-level import cycles,
// not the PACKAGE-level DAG this repo specifies, so it needs the @oaverify/internal-*
// aliases resolved (a .madgerc with tsConfig) just to run, pulls a parser
// subtree for dependabot to track, and still does not catch phantom deps.
// This script reads the declarations the DAG is made of: zero deps, no
// alias resolution, package granularity.
//
// Two matching subtleties baked in:
//   - Match IMPORTS, not mentions. A TSDoc `{@link @oaverify/internal-schema!...}` or a
//     prose reference is not a use; only `from "..."`, `import("...")`,
//     and side-effect `import "..."` count. (formats mentions @oaverify/internal-schema
//     only in a @link; a substring grep would call it "used".)
//   - Collapse subpaths. An import of `@oaverify/internal-validator/internals` counts
//     as using `@oaverify/internal-validator` (the cli relies on this barrel).
//
// Two source sets, because the two assertions ask different questions:
//   - RUNTIME src = packages/<pkg>/src/**/*.ts minus *.test.ts. Feeds the
//     cycle check, which models the shipped dependency DAG; the package
//     tsconfigs exclude tests from the build, so a test import is not a
//     runtime edge.
//   - ALL src = the above plus *.test.ts anywhere under the package. Feeds
//     the declared-vs-imported checks, because a test-only import still
//     belongs in devDependencies. Scanning only runtime src made those two
//     checks contradict each other: the comment said test-only imports go in
//     devDependencies, and the phantom check then flagged them as unused.
//
// Use: node ./scripts/check-deps.mjs  (wired into `pnpm lint`).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = "packages";
const SCOPE = "@oaverify/internal-";

// Normalize a specifier to its owning package name: "@oaverify/internal-schema/internals"
// -> "@oaverify/internal-schema". Returns null for anything outside the @oaverify/internal-* scope.
function toPackageName(specifier) {
  if (!specifier.startsWith(SCOPE)) return null;
  const parts = specifier.split("/");
  return `${parts[0]}/${parts[1]}`;
}

// Every @oaverify/internal-* package imported (not merely mentioned) anywhere in `source`.
const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
  /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("x")
  /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
];
function importedPackages(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const pkg = toPackageName(match[1]);
      if (pkg !== null) found.add(pkg);
    }
  }
  return found;
}

// Recursively collect .ts sources under `dir`. `includeTests` selects
// between the two source sets described at the top of this file.
function collectSources(dir, includeTests = false) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a package without src/ contributes no imports.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full, includeTests));
    } else if (entry.name.endsWith(".ts")) {
      if (includeTests || !entry.name.endsWith(".test.ts")) out.push(full);
    }
  }
  return out;
}

// Read every package: its declared @oaverify/internal-* deps and its imported @oaverify/internal-* set.
function readPackages() {
  const packages = new Map();
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_DIR, entry.name);
    const manifestPath = join(dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // not a package.
    }
    const runtimeDeps = Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith(SCOPE));
    const declared = [
      ...new Set([
        ...runtimeDeps,
        ...Object.keys(manifest.devDependencies ?? {}).filter((d) => d.startsWith(SCOPE)),
      ]),
    ];
    // Declared-vs-imported spans tests; the cycle check does not (see the
    // two-source-sets note at the top).
    const imported = new Set();
    for (const file of [
      ...collectSources(join(dir, "src"), true),
      ...collectSources(join(dir, "test"), true),
    ]) {
      for (const pkg of importedPackages(readFileSync(file, "utf8"))) imported.add(pkg);
    }
    imported.delete(manifest.name); // a package importing its own subpath is not a dep.
    packages.set(manifest.name, { dir, runtimeDeps, declared, imported });
  }
  return packages;
}

// Depth-first cycle search over the declared graph. Returns the first
// cycle as a name path (["@oaverify/internal-a", "@oaverify/internal-b", "@oaverify/internal-a"]) or null.
function findCycle(packages) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map([...packages.keys()].map((name) => [name, WHITE]));
  const stack = [];

  function visit(name) {
    color.set(name, GREY);
    stack.push(name);
    for (const dep of packages.get(name)?.runtimeDeps ?? []) {
      if (!packages.has(dep)) continue; // external / unknown node, not part of the graph.
      const c = color.get(dep);
      if (c === GREY) return [...stack, dep]; // back-edge: cycle.
      if (c === WHITE) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(name, BLACK);
    return null;
  }

  for (const name of packages.keys()) {
    if (color.get(name) === WHITE) {
      const cycle = visit(name);
      if (cycle) return cycle;
    }
  }
  return null;
}

const packages = readPackages();
const errors = [];

const cycle = findCycle(packages);
if (cycle) errors.push(`cycle in @oaverify/internal-* dependency graph: ${cycle.join(" -> ")}`);

for (const [name, { declared, imported }] of packages) {
  for (const dep of declared) {
    if (!imported.has(dep)) {
      errors.push(`${name}: declares ${dep} but never imports it (phantom dependency)`);
    }
  }
  for (const dep of imported) {
    if (!declared.includes(dep)) {
      errors.push(`${name}: imports ${dep} but does not declare it (undeclared dependency)`);
    }
  }
}

if (errors.length > 0) {
  console.error("check-deps: dependency-graph violations:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`check-deps: ${packages.size} packages, graph acyclic, declarations match imports.`);
