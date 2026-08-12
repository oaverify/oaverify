import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as internals from "../src/internals.js";

/**
 * The guards `docs/extending.md` tells a keyword author to use, pinned
 * against what `@oaverify/core/schema/internals` actually exports.
 *
 * Two of them were in the table and in a worked snippet while being
 * absent from the re-export list, so the page an external author follows
 * did not compile for exactly the case it was demonstrating.
 *
 * The names are **parsed out of the page**, not copied here. A copy
 * would be a third list with the same drift problem one step further
 * back: a row added to the table without a matching re-export would
 * leave this file green and the page broken, which is the failure being
 * closed. Reading the table means the test fails the moment the two
 * disagree, in either direction.
 */
const EXTENDING_MD = fileURLToPath(new URL("../../../docs/extending.md", import.meta.url));

/**
 * Helper names from the guards table: rows whose first cell is a single
 * backticked identifier. The table's second column is prose, so only the
 * first cell is read.
 */
function documentedGuards(): string[] {
  const page = readFileSync(EXTENDING_MD, "utf8");
  const start = page.indexOf("| Helper ");
  if (start === -1) throw new Error("guards table not found in docs/extending.md");
  const table = page.slice(start, page.indexOf("\n\n", start));
  const names: string[] = [];
  for (const line of table.split("\n")) {
    const cell = /^\|\s*`([A-Za-z][A-Za-z0-9_]*)`\s*\|/.exec(line);
    if (cell?.[1] !== undefined) names.push(cell[1]);
  }
  return names;
}

describe("docs/extending.md's guards table", () => {
  const guards = documentedGuards();

  // If the table is ever restructured so the parse finds nothing, the
  // per-name assertions below would vacuously pass.
  it("finds the table", () => {
    expect(guards.length).toBeGreaterThanOrEqual(6);
  });

  it.each(guards)("exports %s", (name) => {
    expect(typeof (internals as Record<string, unknown>)[name]).toBe("function");
  });

  // The snippet the page shows, run rather than quoted.
  it("runs the worked example from the page", () => {
    expect(internals.stringArrayValue(["a", "b"], "myKeyword")).toEqual(["a", "b"]);
    expect(() => internals.stringArrayValue("nope", "myKeyword")).toThrow(/myKeyword/);
    expect(internals.checkStringArray(["a"])).toBeUndefined();
    expect(internals.checkStringArray("nope")).toMatch(/array of strings/);
  });

  // The page now names the subpath. It is the only one that resolves:
  // none of these is on the `@oaverify/core/schema` barrel, so a reader
  // following the page's own framing would hit a resolution failure.
  it("names the subpath the guards are actually on", () => {
    const page = readFileSync(EXTENDING_MD, "utf8");
    expect(page).toContain('from "@oaverify/core/schema/internals"');
  });
});
