import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { workspaceAliases } from "../workspace-aliases.js";

// Parity guard for the hand-maintained `@oaverify/internal-*` -> path
// tables. Each is edited by hand, so they drift, and a divergence means
// two toolchains resolve the same specifier to different files: tests
// pass while the build breaks, or the reverse. What a given table owes
// the builder differs, which is why the assertions below are grouped by
// table rather than stated once.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const onlyOav = (k: string): boolean => k.startsWith("@oaverify/internal-");

function aliasKeys(): string[] {
  return Object.keys(workspaceAliases(root)).filter(onlyOav).sort();
}

function tsconfigPathKeys(): string[] {
  return tsconfigPathEntries("tsconfig.build.json")
    .map(([key]) => key)
    .filter(onlyOav)
    .sort();
}

function tsupRewriteKeys(): string[] {
  // packages/oav/tsup.config.ts can't be imported here (it reads
  // `__dirname` at module load, which is undefined under ESM), so read
  // it as text and extract the quoted `@oaverify/internal-*` keys of its rewrite and
  // bundle maps. Values are `@oaverify/core/...` and comments use
  // backticks, so a quoted `@oaverify/internal-...` literal is always a map key.
  const src = readFileSync(resolve(root, "packages/oav/tsup.config.ts"), "utf8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/["'](@oaverify\/internal-[^"']+)["']/g)) keys.add(m[1]!);
  return [...keys].sort();
}

// The oaverify tarball bundles the CLI + router and rewrites the rest of
// `@oaverify/internal-*` to @oaverify/core subpaths; it never imports the framework
// adapters, so those keys appear in the resolution tables but not the
// tsup rewrite map. `@oaverify/internal-stream-validator` aliases the
// package published as `@oaverify/stream`, which the CLI consumes as an
// external runtime dependency (like @oaverify/core), so it is wired into
// the resolution tables (for typecheck / tests) but deliberately not
// bundled into any oaverify tarball. Update this list when adding or
// removing a published package.
const NOT_IN_OAV_BUNDLE = [
  "@oaverify/internal-oav-express4",
  "@oaverify/internal-oav-express5",
  "@oaverify/internal-oav-fastify",
  "@oaverify/internal-stream-validator",
  // The meta-schemas are `@oaverify/check`'s since #572, and that
  // package is an external runtime dep of the oaverify tarball rather
  // than a bundle member. The CLI reached them only through its
  // conformance pass, which moved.
  "@oaverify/internal-metaschema",
  "@oaverify/internal-metaschema/conformance",
].sort();

describe("@oaverify/internal-* alias parity across resolution tables", () => {
  it("workspace-aliases.ts and tsconfig.build.json cover the same @oaverify/internal-* keys", () => {
    expect(aliasKeys()).toEqual(tsconfigPathKeys());
  });

  it("the oav tsup rewrite map matches the alias set minus the bundle's non-deps", () => {
    const aliases = new Set(aliasKeys());
    const tsup = new Set(tsupRewriteKeys());
    // Every tsup key must be a known alias (no typo or stale entry).
    expect([...tsup].filter((k) => !aliases.has(k))).toEqual([]);
    // The only aliases absent from tsup are the documented non-deps.
    expect([...aliases].filter((k) => !tsup.has(k)).sort()).toEqual(NOT_IN_OAV_BUNDLE);
  });
});

// Read as JSONC rather than JSON, because a tsconfig may carry comments
// and `JSON.parse` rejects those.
//
// `paths` targets resolve against `baseUrl` where the config sets one,
// and against the config's own directory where it does not. Both tables
// asserted below set `"baseUrl": "."`, so the two agree for them; the
// rule is tsc's rather than theirs, and reading it wrong resolves every
// entry to a file that does not exist while still returning a string.
// The last block in this file pins that against a config that differs.
function tsconfigPathEntries(configPath: string): Array<[string, string]> {
  const absolute = resolve(root, configPath);
  const parsed = ts.parseConfigFileTextToJson(absolute, readFileSync(absolute, "utf8"));
  if (parsed.error)
    throw new Error(
      `${configPath}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`,
    );
  const { baseUrl, paths } = (
    parsed.config as { compilerOptions: { baseUrl?: string; paths: Record<string, string[]> } }
  ).compilerOptions;
  const base = resolve(dirname(absolute), baseUrl ?? ".");
  return Object.entries(paths).map(([key, [target]]) => [key, resolve(base, target!)]);
}

// A sub-table is a `paths` block covering part of the alias set. None
// of them has to be complete, so each is asserted against the builder
// rather than against the others: no key the builder lacks, no target
// it resolves elsewhere, and every subpath of a base the table does
// declare.
//
// What a missing entry costs differs by table, so this states no single
// failure mode: in `framework-tests`, an isolated pnpm root with no
// `@oaverify` in its `node_modules`, tsc raises TS2307, while at this
// root the same key falls through the workspace link to the same source
// file and costs nothing. #591 is the incident the guard was written
// for, when the vite half of `framework-tests` could still drift.
//
// Two known gaps rather than a claim of coverage. Only `@oaverify/internal-*`
// reaches the subpath rule (`onlyOav`), so a published name a table
// needs can be deleted with the suite green; that is #915, which
// proposes widening the filter. And the tsup map is compared by key
// alone, leaving its targets unasserted; that is #917.
//
// The `describeSubTable` calls below are the tables asserted. Adding one
// is a judgement about whether that table is meant to track the builder,
// so it belongs there rather than in a count. `conformance/tsconfig.json`
// is the standing no: it declares `@oaverify/internal-schema` without
// `/internals`, on purpose, for a harness that imports only the base.
function describeSubTable(configPath: string): void {
  describe(`${configPath} tracks the root builder`, () => {
    const aliases = workspaceAliases(root);

    it("aliases nothing the root builder does not, and resolves to the same file", () => {
      for (const [key, target] of tsconfigPathEntries(configPath)) {
        expect(aliases, `${configPath} aliases unknown ${key}`).toHaveProperty([key]);
        expect(aliases[key], `${configPath} resolves ${key} elsewhere`).toBe(target);
      }
    });

    it("carries every subpath of a package it already aliases", () => {
      const declared = new Set(tsconfigPathEntries(configPath).map(([key]) => key));
      const missing = Object.keys(aliases)
        .filter(onlyOav)
        .filter((key) => {
          const slash = key.indexOf("/", "@oaverify/".length);
          if (slash === -1) return false;
          return declared.has(key.slice(0, slash)) && !declared.has(key);
        });
      expect(missing).toEqual([]);
    });
  });
}

describeSubTable("tsconfig.build.json");
describeSubTable("framework-tests/tsconfig.json");
describeSubTable("tsconfig.tests.json");

// `examples/tsconfig.json` is not a sub-table: nothing resolves through
// it, since every example imports by relative path. It is used here
// only because it sets `"baseUrl": ".."`, the case no asserted table
// exercises. #916 proposes deleting that block, which would leave this
// needing another config that sets one.
describe("tsconfigPathEntries resolves paths against baseUrl", () => {
  it("does not resolve against the config's own directory when baseUrl differs", () => {
    const entries = new Map(tsconfigPathEntries("examples/tsconfig.json"));
    expect(entries.get("@oaverify/internal-core")).toBe(
      resolve(root, "packages/core/src/index.ts"),
    );
  });
});
