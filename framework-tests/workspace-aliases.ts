import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mirror of the root workspace-aliases.ts, scoped to the packages the
// integration tests need (the framework adapters plus their immediate
// dependencies). Lives here so that framework-tests stays an isolated
// pnpm root; importing the root file would pull this sub-package into
// the main workspace's resolution graph.

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");

const PACKAGES = ["core", "validator", "oav-express4", "oav-express5", "oav-fastify"] as const;

export function workspaceAliases(): Record<string, string> {
  return Object.fromEntries([
    [
      "@oaverify/internal-core/prototype-properties",
      resolve(rootDir, "packages", "core", "src", "prototype-properties.ts"),
    ],
    ...PACKAGES.map((pkg) => [
      `@oaverify/internal-${pkg}`,
      resolve(rootDir, "packages", pkg, "src", "index.ts"),
    ]),
  ]);
}
