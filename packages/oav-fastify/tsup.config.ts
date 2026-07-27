import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `@oaverify/fastify`, the Fastify adapter.
 * Same shape as `@oaverify/express4` / `@oaverify/express5`: thin tarball,
 * `@oaverify/core` externalized, fastify marked external (peer dep).
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
  external: ["fastify", "@oaverify/core"],
  esbuildPlugins: [rewriteOavCore()],
});
