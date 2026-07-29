import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspaceAliases } from "../workspace-aliases.js";

// Parity guard for the hand-maintained `@oaverify/internal-*` -> path tables. Adding a
// subpath export (a new `*/internals`, a new package) means updating
// three places; missing one surfaces as a confusing resolve failure
// (tests pass but the build breaks, or vice versa) rather than a clear
// error. This asserts the tables agree, with an explicit allowlist for
// the entries the `oav` bundle legitimately doesn't reference.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const onlyOav = (k: string): boolean => k.startsWith("@oaverify/internal-");

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
// tsup rewrite map. `@oaverify/internal-stream-validator` aliases the package published
// as `@oaverify/stream`. It is consumed by the CLI and
// consumed by the CLI as an external runtime dependency (like @oaverify/core),
// so it is wired into the resolution tables (for typecheck / tests) but
// deliberately not bundled into any oaverify tarball. Update this list when
// adding or removing a published package.
// `@oaverify/internal-metaschema` is here for a different reason than the
// rest: it is not consumed by anything yet. It ships the pinned OpenAPI
// meta-schemas and the version dispatch over them, and the `check`
// wiring that will import it lands separately. Move it out of this list
// in the same change that adds the import, or the bundle will resolve
// the specifier at runtime instead of rewriting it.
const NOT_IN_OAV_BUNDLE = [
  "@oaverify/internal-metaschema",
  "@oaverify/internal-oav-express4",
  "@oaverify/internal-oav-express5",
  "@oaverify/internal-oav-fastify",
  "@oaverify/internal-stream-validator",
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
