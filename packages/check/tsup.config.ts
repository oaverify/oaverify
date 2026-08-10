import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `@oaverify/check`, the composed document check.
 *
 * Same tarball shape as `@oaverify/syntax`: the package imports
 * `@oaverify/internal-*` by workspace alias in source, and the plugin
 * below rewrites the ones with a published counterpart to
 * `@oaverify/core/*` AND marks them external, so the bundle resolves
 * them from the consumer's install rather than inlining a second copy
 * of the compiler.
 *
 * `redos-detector` is a regular runtime dependency and stays external.
 * It is ~1MB unpacked,
 * which is the reason this package exists rather than a
 * `@oaverify/core/check` subpath: npm installs a dependency whichever
 * entry imports it, so behind a core subpath that weight would reach
 * every `@oaverify/core` consumer and break the zero-runtime-dependency
 * claim.
 */
const repoRoot = resolve(__dirname, "..", "..");

// Bundled rather than rewritten to a `@oaverify/core` subpath, because
// it is not one. It carries ~100KB of vendored OpenAPI meta-schemas and
// `metaschemaFor` reaches all three, so anything importing it pays in
// full; only the conformance pass needs them, so they belong in this
// tarball rather than in the library every framework adapter depends on.
const bundledWorkspace: Record<string, string> = {
  "@oaverify/internal-metaschema": resolve(repoRoot, "packages", "metaschema", "src", "index.ts"),
  "@oaverify/internal-metaschema/conformance": resolve(
    repoRoot,
    "packages",
    "metaschema",
    "src",
    "conformance.ts",
  ),
};

const oavCoreRewrite: Record<string, string> = {
  "@oaverify/internal-core": "@oaverify/core/core",
  "@oaverify/internal-schema": "@oaverify/core/schema",
  "@oaverify/internal-schema/internals": "@oaverify/core/schema/internals",
  "@oaverify/internal-spec": "@oaverify/core/spec",
  "@oaverify/internal-spec/internals": "@oaverify/core/spec/internals",
  "@oaverify/internal-formats": "@oaverify/core/formats",
  "@oaverify/internal-validator": "@oaverify/core",
  "@oaverify/internal-validator/internals": "@oaverify/core/validator/internals",
};

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // No published source maps; see root tsup.config.ts for the rationale.
  sourcemap: false,
  target: "es2022",
  tsconfig: resolve(__dirname, "../../tsconfig.build.json"),
  external: ["@oaverify/core", "redos-detector"],
  esbuildPlugins: [rewriteOavCore()],
});

/**
 * esbuild resolves aliases before external-matching, but only for the
 * originally-imported specifier, so the rewrite and the external mark
 * have to happen in one `onResolve` hook. See the same note in
 * `packages/oav/tsup.config.ts`.
 */
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
