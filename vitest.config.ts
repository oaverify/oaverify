import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceAliases(__dirname),
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    globals: false,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Report on every shipped source file, not only the ones a test
      // happened to import: without `include`, v8 reports 100% for a
      // module nothing loads, because it never appears in the profile.
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/dist/**",
        // The `oaverify` bin. Top-level await runs the whole program on
        // import, so there is nothing a unit test can call; the pack-smoke
        // CI job execs the built binary instead.
        "packages/oav/src/cli.ts",
      ],
      // Floors, set just under the numbers on the day they were
      // introduced (see AGENTS.md "Coverage"). They ratchet: raise them
      // when a run clears the next step, never lower them to make a red
      // run green.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 94,
        lines: 93,
      },
    },
  },
});
