import { resolve } from "node:path";

// Single source of truth for the @oaverify/internal-* -> packages/*/src/index.ts alias
// map. Imported by tsup.config.ts and vitest.config.ts. tsconfig.build.json
// has its own copy under "paths" because JSON cannot import TS — keep it
// in sync when adding a new workspace package.

const PACKAGES = [
  "core",
  "schema",
  "formats",
  "spec",
  "overlay-spec",
  "metaschema",
  "router",
  "validator",
  "stream-validator",
  "cli",
  "oav-express4",
  "oav-express5",
  "oav-fastify",
] as const;

export function workspaceAliases(rootDir: string): Record<string, string> {
  // Sub-path barrel keys (more specific) come first so bundlers that
  // match on longest prefix / insertion order pick `@oaverify/internal-<pkg>/internals`
  // before the base `@oaverify/internal-<pkg>` alias.
  const subpathEntries: Array<[string, string]> = [
    [
      "@oaverify/internal-core/prototype-properties",
      resolve(rootDir, "packages", "core", "src", "prototype-properties.ts"),
    ],
    [
      "@oaverify/internal-core/subschema-positions",
      resolve(rootDir, "packages", "core", "src", "subschema-positions.ts"),
    ],
    [
      "@oaverify/internal-metaschema/conformance",
      resolve(rootDir, "packages", "metaschema", "src", "conformance.ts"),
    ],
    [
      "@oaverify/internal-schema/internals",
      resolve(rootDir, "packages", "schema", "src", "internals.ts"),
    ],
    [
      "@oaverify/internal-spec/internals",
      resolve(rootDir, "packages", "spec", "src", "internals.ts"),
    ],
    [
      "@oaverify/internal-validator/internals",
      resolve(rootDir, "packages", "validator", "src", "internals.ts"),
    ],
  ];
  const packageEntries = PACKAGES.map(
    (pkg) =>
      [`@oaverify/internal-${pkg}`, resolve(rootDir, "packages", pkg, "src", "index.ts")] as [
        string,
        string,
      ],
  );
  // Packages published standalone rather than folded into the @oaverify/core
  // bundle, so consumers inside the workspace (the CLI) import them by
  // their published names. Alias them to source too, so tests / bundling
  // resolve them without a prior build of their dist.
  const publishedEntries: Array<[string, string]> = [
    ["@oaverify/stream", resolve(rootDir, "packages", "stream-validator", "src", "index.ts")],
    ["@oaverify/syntax", resolve(rootDir, "packages", "syntax", "src", "index.ts")],
    ["@oaverify/check", resolve(rootDir, "packages", "check", "src", "index.ts")],
    // The published subpaths of `@oaverify/core`. Emitted standalone
    // validators import these by their real names, so tests that write a
    // generated module to a tmpdir and import it need them resolvable to
    // source. Longest-first, as above.
    [
      "@oaverify/core/schema/internals",
      resolve(rootDir, "packages", "schema", "src", "internals.ts"),
    ],
    ["@oaverify/core/spec/internals", resolve(rootDir, "packages", "spec", "src", "internals.ts")],
    [
      "@oaverify/core/validator/internals",
      resolve(rootDir, "packages", "validator", "src", "internals.ts"),
    ],
    [
      "@oaverify/core/codegen-runtime",
      resolve(rootDir, "packages", "validator", "src", "codegen-runtime.ts"),
    ],
    ["@oaverify/core/schema", resolve(rootDir, "packages", "schema", "src", "index.ts")],
    ["@oaverify/core/spec", resolve(rootDir, "packages", "spec", "src", "index.ts")],
    [
      "@oaverify/core/overlay-spec",
      resolve(rootDir, "packages", "overlay-spec", "src", "index.ts"),
    ],
    ["@oaverify/core/formats", resolve(rootDir, "packages", "formats", "src", "index.ts")],
    ["@oaverify/core/core", resolve(rootDir, "packages", "core", "src", "index.ts")],
    ["@oaverify/core", resolve(rootDir, "packages", "validator", "src", "index.ts")],
  ];
  return Object.fromEntries([...subpathEntries, ...packageEntries, ...publishedEntries]);
}
