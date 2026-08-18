import { describe, expect, it } from "vitest";
import { primarySink } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";

/**
 * The sink's contract is one write per command. `--output` maps to a
 * truncating `writeText`, so a second write does not append, it destroys
 * the first: `check -o` shipped a one-line file for a four-finding
 * report that way (#848).
 *
 * The guard that enforces it cannot be reached through any command, by
 * construction, so it is pinned here instead.
 */
describe("primarySink", () => {
  const cases = [
    { name: "--output", opts: { output: "out.txt", quiet: false } },
    { name: "--quiet", opts: { quiet: true } },
    { name: "stdout", opts: { quiet: false } },
  ] as const;

  it.each(cases)("$name accepts one write", async ({ opts }) => {
    const { io } = memoryIo([]);
    await primarySink(io, opts)("the whole report\n");
  });

  it.each(cases)("$name refuses a second write", async ({ opts }) => {
    const { io } = memoryIo([]);
    const sink = primarySink(io, opts);
    await sink("first\n");

    await expect(async () => await sink("second\n")).rejects.toThrow(
      /wrote through its primary sink more than once/,
    );
  });

  it("delivers the content it was given", async () => {
    const { io, writes, stdout } = memoryIo([]);
    await primarySink(io, { output: "out.txt", quiet: false })("to the file\n");
    await primarySink(io, { quiet: false })("to stdout\n");

    expect(writes).toEqual([["out.txt", "to the file\n"]]);
    expect(stdout.value).toBe("to stdout\n");
  });

  it("calls stdout through io, so a method-shorthand implementation keeps its receiver", async () => {
    // `once(io.stdout)` passed the method unbound. Every in-repo
    // `CommandIo` writes `stdout` as an arrow, so nothing noticed, but
    // the interface declares a plain function property and a caller may
    // reasonably use `this`.
    const seen: string[] = [];
    const io = {
      ...memoryIo([]).io,
      stdout(chunk: string) {
        (this as { seen?: string[] }).seen?.push(chunk);
        seen.push(chunk);
      },
      seen: [] as string[],
    };

    await primarySink(io, { quiet: false })("through the receiver\n");

    expect(seen).toEqual(["through the receiver\n"]);
    expect(io.seen).toEqual(["through the receiver\n"]);
  });

  it("writes to the file even under --quiet, which suppresses stdout only", async () => {
    const { io, writes, stdout } = memoryIo([]);
    await primarySink(io, { output: "out.txt", quiet: true })("deliberate\n");

    expect(writes).toEqual([["out.txt", "deliberate\n"]]);
    expect(stdout.value).toBe("");
  });
});
