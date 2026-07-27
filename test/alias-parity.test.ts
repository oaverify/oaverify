import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspaceAliases } from "../workspace-aliases.js";

// Parity guard for the hand-maintained `@oav/*` -> path tables. Adding a
// subpath export (a new `*/internals`, a new package) means updating
// three places; missing one surfaces as a confusing resolve failure
// (tests pass but the build breaks, or vice versa) rather than a clear
// error. This asserts the tables agree, with an explicit allowlist for
// the entries the `oav` bundle legitimately doesn't reference.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const onlyOav = (k: string): boolean => k.startsWith("@oav/");

function aliasKeys(): string[] {
  return Object.keys(workspaceAliases(root)).filter(onlyOav).sort();
}

function tsconfigPathKeys(): string[] {
  const json = JSON.parse(readFileSync(resolve(root, "tsconfig.build.json"), "utf8")) as {
    compilerOptions: { paths: Record<string, unknown> };
  };
  return Object.keys(json.compilerOptions.paths).filter(onlyOav).sort();
}

function tsupRewriteKeys(): string[] {
  // packages/oav/tsup.config.ts can't be imported here (it reads
  // `__dirname` at module load, which is undefined under ESM), so read
  // it as text and extract the quoted `@oav/*` keys of its rewrite and
  // bundle maps. Values are `@aahoughton/oav-core/...` and comments use
  // backticks, so a quoted `@oav/...` literal is always a map key.
  const src = readFileSync(resolve(root, "packages/oav/tsup.config.ts"), "utf8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/["'](@oav\/[^"']+)["']/g)) keys.add(m[1]!);
  return [...keys].sort();
}

// The oav tarball bundles the CLI + router and rewrites the rest of
// `@oav/*` to oav-core subpaths; it never imports the framework
// adapters, so those keys appear in the resolution tables but not the
// tsup rewrite map. `@oav/stream-validator` is published standalone and
// consumed by the CLI as an external runtime dependency (like oav-core),
// so it is wired into the resolution tables (for typecheck / tests) but
// deliberately not bundled into any oav tarball. Update this list when
// adding or removing a published package.
const NOT_IN_OAV_BUNDLE = [
  "@oav/oav-express4",
  "@oav/oav-express5",
  "@oav/oav-fastify",
  "@oav/stream-validator",
].sort();

describe("@oav/* alias parity across resolution tables", () => {
  it("workspace-aliases.ts and tsconfig.build.json cover the same @oav/* keys", () => {
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
