import { describe, expect, it } from "vitest";
import { stripBundlerPathComments } from "../src/commands.js";

/**
 * esbuild labels each bundled module with its path relative to the
 * working directory, so the string `compile-spec` has to strip is not
 * fixed: it depends on where the CLI runs from.
 *
 * The first draft anchored on `dist/chunk-…`, which only appears when
 * the CLI runs inside this repo (where `@oaverify/core` resolves by
 * package self-reference). For an installed user, the case the fix is
 * *for*, the label carries a `node_modules/…` prefix and nothing was
 * stripped.
 *
 * `compile-spec.test.ts` cannot catch that: it bundles from
 * `packages/*\/src` with no prior build, so its labels read
 * `// packages/schema/src/…` and never take this shape at all. Hence a
 * unit test on the helper, against the three real forms.
 */
describe("stripBundlerPathComments", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["run from this repo", "// dist/chunk-2YDUB5Q2.js"],
    ["installed under npm", "// node_modules/@oaverify/core/dist/chunk-2YDUB5Q2.js"],
    [
      "installed under pnpm",
      "// node_modules/.pnpm/@oaverify+core@7.0.0/node_modules/@oaverify/core/dist/chunk-AJWIQJ3K.js",
    ],
  ];

  for (const [where, comment] of cases) {
    it(`strips the label when ${where}`, () => {
      const bundle = `${comment}\nvar SELF_LOCATING_ERROR_CODES = [];\n`;
      expect(stripBundlerPathComments(bundle)).toBe("var SELF_LOCATING_ERROR_CODES = [];\n");
    });
  }

  it("strips every occurrence, not just the first", () => {
    const bundle =
      "// dist/chunk-AAAAAAAA.js\nvar a = 1;\n\n// dist/chunk-BBBBBBBB.js\nvar b = 2;\n";
    expect(stripBundlerPathComments(bundle)).toBe("var a = 1;\n\nvar b = 2;\n");
  });

  // The `<stdin>` label marks the caller's own entry rather than a
  // bundled dependency, and it carries no build-internal name, so it
  // stays.
  it("leaves the stdin label alone", () => {
    const bundle = "// <stdin>\nexport const validateRequest = () => {};\n";
    expect(stripBundlerPathComments(bundle)).toBe(bundle);
  });

  it("leaves ordinary comments and code alone", () => {
    const bundle = "// a note the author wrote\nvar x = 1; // dist/chunk-NOTALINE.js\n";
    expect(stripBundlerPathComments(bundle)).toBe(bundle);
  });
});
