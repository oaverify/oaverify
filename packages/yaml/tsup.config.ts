import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Build config for `oav-yaml`, the YAML reader package.
 *
 * Thin tarball: nothing from `oav-core` is bundled. The package
 * imports `@oav/spec` / `@oav/spec/internals` (workspace aliases) in
 * source; the plugin below rewrites those to `@aahoughton/oav-core/*`
 * AND marks them external, so the published bundle resolves them from
 * the consumer's install of `@aahoughton/oav-core`.
 *
 * `yaml` is a regular runtime dependency and stays external; bundling
 * it would ship a second copy for consumers who already have one.
 */
const oavCoreRewrite: Record<string, string> = {
  "@oav/spec": "@aahoughton/oav-core/spec",
  "@oav/spec/internals": "@aahoughton/oav-core/spec/internals",
};

function rewriteOavCore(): Plugin {
  return {
    name: "oav-core-rewrite",
    setup(build) {
      build.onResolve({ filter: /^@oav\// }, (args) => {
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
  external: ["yaml", "@aahoughton/oav-core"],
  esbuildPlugins: [rewriteOavCore()],
});
