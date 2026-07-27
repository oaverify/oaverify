import { defineConfig } from "tsup";
import { workspaceAliases } from "./workspace-aliases.js";

/**
 * Build config for the publishable `@oaverify/core` — the lean
 * validator tarball with zero runtime dependencies. Each entry
 * becomes a subpath:
 *
 *   src/index.ts               -> "@oaverify/core"
 *   src/schema.ts              -> "@oaverify/core/schema"
 *   src/schema-internals.ts    -> "@oaverify/core/schema/internals"
 *   src/spec.ts                -> "@oaverify/core/spec"
 *   src/spec-internals.ts      -> "@oaverify/core/spec/internals"
 *   src/overlay-spec.ts        -> "@oaverify/core/overlay-spec"
 *   src/formats.ts             -> "@oaverify/core/formats"
 *   src/core.ts                -> "@oaverify/core/core"
 *   src/validator-internals.ts -> "@oaverify/core/validator/internals"
 *
 * The internal `@oaverify/internal-*` workspace packages are redirected to their
 * source via the esbuild `alias` option, then bundled in as normal
 * modules so consumers never see them.
 *
 * The companion `oaverify` package (`packages/oav/`) builds
 * separately and carries the CLI. Keeping the CLI and YAML parsing out
 * of this tarball is what delivers the zero-runtime-dependency claim.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    "schema-internals": "src/schema-internals.ts",
    spec: "src/spec.ts",
    "spec-internals": "src/spec-internals.ts",
    "overlay-spec": "src/overlay-spec.ts",
    formats: "src/formats.ts",
    core: "src/core.ts",
    "validator-internals": "src/validator-internals.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // No source maps in published tarballs: they were ~55% of @oaverify/core's
  // unpacked size (each map embeds the full original TS via sourcesContent),
  // and bundlers never pull .map into application output, so the cost was all
  // install-disk and npm sticker size for zero runtime benefit. The build is
  // unminified, so a consumer debugging into oaverify still lands in readable JS
  // with original identifier names and // src/*.ts markers.
  sourcemap: false,
  splitting: true,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
  esbuildOptions(options) {
    options.alias = workspaceAliases(__dirname);
  },
});
