import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";
import { workspaceAliases } from "../../workspace-aliases.js";

/**
 * Build config for `oaverify`, the CLI tarball.
 *
 * This package ships one thing: the `oaverify` binary. The library API
 * lives in `@oaverify/core`, the YAML readers in `@oaverify/syntax`; neither is
 * re-exported here.
 *
 * Dependency shape:
 * - `@oaverify/core` and `@oaverify/syntax` are external runtime deps the
 *   consumer's install already provides.
 * - `commander` is an external runtime dep, imported dynamically at
 *   CLI start with a clear error when the install is corrupt.
 * - `esbuild` is an external optional peer, used only by
 *   `compile-schema` / `compile-spec` and reported lazily by them.
 * - `@oaverify/check` is an external runtime dep. The conformance pass
 *   and its ~100KB of vendored meta-schemas moved there with the rest
 *   of the check logic, so this tarball no longer bundles them.
 * - `@oaverify/internal-cli` (the workspace package that owns the CLI logic) is
 *   bundled in, along with everything it transitively imports from
 *   `@oaverify/internal-*`. Those transitive imports are rewritten to the
 *   corresponding `@oaverify/core/*` subpaths AND marked external by the
 *   plugin below, so the bundle imports the compiler / validator from
 *   `@oaverify/core` at run time rather than inlining a second copy.
 *
 * ESM only: `cli.ts` uses top-level `await`, which isn't legal in a
 * CJS output. The `bin` field points at `./dist/cli.js` and Node picks
 * up the ESM build regardless of the consumer's package type.
 */
const repoRoot = resolve(__dirname, "..", "..");
const workspace = workspaceAliases(repoRoot);

// `@oaverify/internal-*` -> `@oaverify/core[/*]`: kept external (resolved at
// run time from the consumer's install of `@oaverify/core`).
const oavCoreRewrite: Record<string, string> = {
  "@oaverify/internal-core": "@oaverify/core/core",
  "@oaverify/internal-schema": "@oaverify/core/schema",
  "@oaverify/internal-schema/internals": "@oaverify/core/schema/internals",
  "@oaverify/internal-spec": "@oaverify/core/spec",
  "@oaverify/internal-spec/internals": "@oaverify/core/spec/internals",
  "@oaverify/internal-overlay-spec": "@oaverify/core/overlay-spec",
  "@oaverify/internal-formats": "@oaverify/core/formats",
  "@oaverify/internal-validator": "@oaverify/core",
  "@oaverify/internal-validator/internals": "@oaverify/core/validator/internals",
};

function workspaceTarget(specifier: string): string {
  const target = workspace[specifier];
  if (target === undefined) throw new Error(`workspace alias missing for ${specifier}`);
  return target;
}

// Private workspace modules bundled into this tarball. The keys are this
// package's bundle boundary; the source targets come from the root builder.
const bundledWorkspace = Object.fromEntries(
  [
    "@oaverify/internal-core/prototype-properties",
    "@oaverify/internal-core/ref-siblings",
    "@oaverify/internal-core/subschema-positions",
    "@oaverify/internal-cli",
    "@oaverify/internal-router",
  ].map((specifier) => [specifier, workspaceTarget(specifier)]),
);

// esbuild resolves aliases before external-matching, but only for
// the originally-imported specifier. Doing the rewrite+external in a
// single onResolve hook is the reliable way to get imports like
// `@oaverify/internal-schema` emitted into the bundle as
// `import ... from "@oaverify/core/schema"`.
function rewriteOavCore(): Plugin {
  return {
    name: "oaverify-core-rewrite",
    setup(build) {
      build.onResolve({ filter: /^@oaverify\/internal-/ }, (args) => {
        const rewrite = oavCoreRewrite[args.path];
        if (rewrite) return { path: rewrite, external: true };
        const bundled = bundledWorkspace[args.path];
        if (bundled) return { path: bundled };
        return null;
      });
    },
  };
}

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  // No published source maps; see root tsup.config.ts for the rationale.
  sourcemap: false,
  target: "es2022",
  tsconfig: resolve(__dirname, "../../tsconfig.build.json"),
  external: [
    "@oaverify/core",
    "@oaverify/check",
    "@oaverify/stream",
    "@oaverify/syntax",
    "commander",
    "esbuild",
  ],
  esbuildPlugins: [rewriteOavCore()],
});
