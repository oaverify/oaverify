/**
 * Bundles harness.ts into a single dependency-free ESM file.
 *
 * The engine's source imports only `@oaverify/internal-core` and
 * `@oaverify/internal-formats`, so esbuild can bundle straight from
 * each package's `src` with no prior `pnpm build`. Aliases come from
 * workspace-aliases.ts, the same map vitest and tsup read.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

import * as esbuild from "esbuild";

import { workspaceAliases } from "../workspace-aliases.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const version = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")).version;

await esbuild.build({
  entryPoints: [resolve(here, "harness.ts")],
  outfile: resolve(here, "dist", "harness.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  alias: workspaceAliases(rootDir),
  define: { __OAVERIFY_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
