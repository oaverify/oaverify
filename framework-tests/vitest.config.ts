import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceAliases } from "../workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceAliases(resolve(dirname(fileURLToPath(import.meta.url)), "..")),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    passWithNoTests: false,
  },
});
