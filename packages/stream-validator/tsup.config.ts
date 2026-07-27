import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `oav-stream-validator`, the streaming JSON Schema
 * validator.
 *
 * Thin tarball: nothing from `oav-core` is bundled. The engine imports
 * `@oaverify/internal-core` / `@oaverify/internal-schema` (workspace aliases) in source; the plugin
 * below rewrites those to `@oaverify/core/*` AND marks them
 * external, so the published bundle resolves them from the consumer's
 * install of `@oaverify/core` (a regular dependency). This is the
 * same pattern the framework adapters use; it keeps the in-memory
 * compiler from being duplicated into this tarball.
 *
 * The map covers every `@oaverify/internal-*` subpath the source imports: the base
 * `@oaverify/internal-schema` and `@oaverify/internal-schema/internals` are distinct npm subpaths and
 * map separately. Keep this in sync with the imports if a new one is
 * added (an unmapped `@oaverify/internal-*` import would be bundled from source instead
 * of externalized, silently fattening the tarball).
 */
const oavCoreRewrite: Record<string, string> = {
  "@oaverify/internal-core": "@oaverify/core/core",
  "@oaverify/internal-schema": "@oaverify/core/schema",
  "@oaverify/internal-schema/internals": "@oaverify/core/schema/internals",
};

function rewriteOavCore(): Plugin {
  return {
    name: "oav-core-rewrite",
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
  external: ["@oaverify/core"],
  esbuildPlugins: [rewriteOavCore()],
});
