import { describe, expect, it } from "vitest";
import type { CommandOptions } from "../src/commands.js";
import { checkCommand } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";

/**
 * `-o FILE` writes through `io.writeText`, which truncates. A command
 * that calls its sink once per line therefore leaves the file holding
 * the last line only, while stdout looks correct: the text report went
 * out a line at a time and `check spec.yaml -o out.txt` produced a
 * one-line file (#848).
 *
 * These pin the sink's stated invariant, one write per command, for
 * every format rather than only the one that broke. The count is the
 * assertion that matters; the memory io records writes instead of
 * truncating, so a regression shows up here as several writes rather
 * than as lost bytes.
 */
const spec = (orphan: boolean): unknown => ({
  openapi: "3.1.0",
  info: { title: "X", version: "1" },
  paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
  ...(orphan ? { components: { schemas: { Orphan: { type: "object" } } } } : {}),
});

// `format` is a top-level argument; `output` and `quiet` live in
// `options`. Passing format into `options` silently selects the default
// text branch instead of failing, which is how the first draft of this
// file "covered" three formats while exercising one. (`CommandOptions`
// carries a `format` of its own, over a different set of values, and
// `checkCommand` does not read it.)
type Format = "text" | "json" | "sarif";

const run = async (format: Format, orphan: boolean) => {
  const options: CommandOptions = { quiet: false };

  const toFile = memoryIo([["spec.json", spec(orphan)]]);
  await checkCommand(
    {
      spec: "spec.json",
      overlays: [],
      format,
      options: { ...options, output: "out.txt" },
    },
    toFile.io,
  );

  // The same run without `-o`, to compare the file against what the
  // user would have seen on stdout.
  const toStdout = memoryIo([["spec.json", spec(orphan)]]);
  await checkCommand({ spec: "spec.json", overlays: [], format, options }, toStdout.io);

  return { writes: toFile.writes, stdout: toStdout.stdout.value };
};

describe("check --output (#848)", () => {
  describe.each(["text", "json", "sarif"] as const)("--format %s", (format) => {
    it("writes the report exactly once", async () => {
      const { writes } = await run(format, true);
      expect(writes.map(([path]) => path)).toEqual(["out.txt"]);
    });

    it("writes the same bytes the report would have printed", async () => {
      const { writes, stdout } = await run(format, true);
      expect(writes[0]?.[1]).toBe(stdout);
    });
  });

  describe("with no findings", () => {
    it("writes exactly once", async () => {
      const { writes } = await run("text", false);
      expect(writes.map(([path]) => path)).toEqual(["out.txt"]);
    });

    it("writes the same bytes the report would have printed", async () => {
      const { writes, stdout } = await run("text", false);
      expect(writes[0]?.[1]).toBe(stdout);
    });
  });

  it("writes exactly once when a skip line follows a no-findings report", async () => {
    // The no-findings branch has the same one-call-per-line shape, but
    // only shows it once a skip or no-op line joins the summary. With
    // neither it writes once by accident, which is why the plain
    // no-findings case above cannot pin this.
    const { io, writes } = memoryIo([["spec.json", spec(true)]]);
    await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        format: "text",
        findings: "-hygiene",
        options: { quiet: false, output: "out.txt" },
      },
      io,
    );

    expect(writes.map(([path]) => path)).toEqual(["out.txt"]);
    expect(writes[0]?.[1]).toContain("skipped:");
  });

  it("hands the sink the whole report in one piece", async () => {
    // The user-visible shape of the bug was a file holding
    // "    and unabbreviated." and nothing above it. `memoryIo` appends
    // rather than truncating, so the harness cannot show that directly;
    // what it can show is the property that caused it, which is whether
    // the single write carries the whole report or one line of it.
    const { writes } = await run("text", true);
    const written = writes[0]?.[1] ?? "";

    expect(written).toContain("hygiene      unused-component");
    expect(written).toContain("/components/schemas/Orphan");
    expect(written.trimEnd().split("\n").length).toBeGreaterThan(1);
  });
});
