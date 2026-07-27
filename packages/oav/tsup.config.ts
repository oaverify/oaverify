import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `oav`, the CLI tarball.
 *
 * This package ships one thing: the `oav` binary. The library API
 * lives in `oav-core`, the YAML readers in `oav-yaml`; neither is
 * re-exported here.
 *
 * Dependency shape:
 * - `oav-core` and `oav-yaml` are external runtime deps the
 *   consumer's install already provides.
 * - `commander` is an external runtime dep, imported dynamically at
 *   CLI start with a clear error when the install is corrupt.
 * - `esbuild` is an external optional peer, used only by
 *   `compile-schema` / `compile-spec` and reported lazily by them.
 * - `@oav/cli` (the workspace package that owns the CLI logic) is
 *   bundled in, along with everything it transitively imports from
 *   `@oav/*`. Those transitive imports are rewritten to the
 *   corresponding `oav-core/*` subpaths AND marked external by the
 *   plugin below, so the bundle imports the compiler / validator from
 *   oav-core at run time rather than inlining a second copy.
 *
 * ESM only: `cli.ts` uses top-level `await`, which isn't legal in a
 * CJS output. The `bin` field points at `./dist/cli.js` and Node picks
 * up the ESM build regardless of the consumer's package type.
 */
const repoRoot = resolve(__dirname, "..", "..");

// `@oav/*` → `oav-core[/*]`: kept external (resolved at
// run time from the consumer's install of oav-core).
const oavCoreRewrite: Record<string, string> = {
  "@oav/core": "@aahoughton/oav-core/core",
  "@oav/schema": "@aahoughton/oav-core/schema",
  "@oav/schema/internals": "@aahoughton/oav-core/schema/internals",
  "@oav/spec": "@aahoughton/oav-core/spec",
  "@oav/spec/internals": "@aahoughton/oav-core/spec/internals",
  "@oav/overlay-spec": "@aahoughton/oav-core/overlay-spec",
  "@oav/formats": "@aahoughton/oav-core/formats",
  "@oav/validator": "@aahoughton/oav-core",
  "@oav/validator/internals": "@aahoughton/oav-core/validator/internals",
};

// `@oav/cli` + `@oav/router`: private workspace packages bundled
// into this tarball (no external runtime counterpart).
const bundledWorkspace: Record<string, string> = {
  "@oav/cli": resolve(repoRoot, "packages", "cli", "src", "index.ts"),
  "@oav/router": resolve(repoRoot, "packages", "router", "src", "index.ts"),
};

// esbuild resolves aliases before external-matching, but only for
// the originally-imported specifier. Doing the rewrite+external in a
// single onResolve hook is the reliable way to get imports like
// `@oav/schema` emitted into the bundle as
// `import ... from "oav-core/schema"`.
function rewriteOavCore(): Plugin {
  return {
    name: "oav-core-rewrite",
    setup(build) {
      build.onResolve({ filter: /^@oav\// }, (args) => {
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
    "@aahoughton/oav-core",
    "@aahoughton/oav-stream-validator",
    "@aahoughton/oav-yaml",
    "commander",
    "esbuild",
  ],
  esbuildPlugins: [rewriteOavCore()],
});
