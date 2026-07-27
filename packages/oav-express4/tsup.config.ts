import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `@oaverify/express4`, the Express 4 adapter.
 *
 * Thin tarball: nothing from `@oaverify/core` is bundled. The adapter
 * imports `@oaverify/internal-core` / `@oaverify/internal-validator` (workspace aliases) in
 * source; the plugin below rewrites those to `@oaverify/core/*`
 * AND marks them external so the published bundle resolves them
 * from the consumer's install of `@oaverify/core`.
 *
 * `express` is a peer dep, never bundled. `@types/express` is a
 * dev dep and only contributes to the .d.ts emit.
 */
const oavCoreRewrite: Record<string, string> = {
  "@oaverify/internal-core": "@oaverify/core/core",
  "@oaverify/internal-validator": "@oaverify/core",
};

function rewriteOavCore(): Plugin {
  return {
    name: "oaverify-core-rewrite",
    setup(build) {
      build.onResolve({ filter: /^@oaverify\/internal-/ }, (args) => {
        const rewrite = oavCoreRewrite[args.path];
        if (rewrite) return { path: rewrite, external: true };
        return null;
      });
    },
  };
}

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // No published source maps; see root tsup.config.ts for the rationale.
  sourcemap: false,
  target: "es2022",
  tsconfig: resolve(__dirname, "../../tsconfig.build.json"),
  external: ["express", "@oaverify/core"],
  esbuildPlugins: [rewriteOavCore()],
});
