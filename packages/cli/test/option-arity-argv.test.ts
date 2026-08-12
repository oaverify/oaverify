import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { memoryIo } from "./fixtures.js";

/**
 * Argv-level cover for option arity on the repeatable flags.
 *
 * Commander's variadic form (`<file...>`) keeps consuming argv until the
 * next `-`, so a variadic option placed before the positional swallows
 * it: `check --severity 'redos=error' spec.json` failed with "missing
 * required argument 'spec'" and exit 3. Nothing in-tree caught it
 * because every doc and every test happened to write the spec first.
 *
 * These assert the ordering a user actually types, in both orders, so a
 * flag that regains a variadic marker fails here rather than in
 * somebody's shell.
 */

const SPEC = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} };
const OVERLAY = { overlay: "1.0.0", info: { title: "o", version: "1" }, actions: [] };

/** Run argv; return the exit code the program settled on. */
async function exitFrom(argv: readonly string[]): Promise<number> {
  const mem = memoryIo(
    [
      ["spec.json", SPEC],
      ["a.json", OVERLAY],
      ["b.json", OVERLAY],
    ],
    [],
  );
  let code = 0;
  const program = buildProgram({
    io: mem.io,
    exit: (c: number) => {
      code = c;
    },
  });
  try {
    await program.parseAsync(["node", "oaverify", ...argv]);
  } catch {
    // Commander throws on a usage error after calling exitOverride; a
    // usage error is exactly what this suite is looking for, and it
    // shows up as a non-zero code below.
    return code === 0 ? 3 : code;
  }
  return code;
}

describe("a repeatable flag does not swallow the positional", () => {
  it("accepts --severity before the spec", async () => {
    expect(await exitFrom(["check", "--severity", "unused-tag=error", "spec.json"])).not.toBe(3);
  });

  it("accepts --severity after the spec", async () => {
    expect(await exitFrom(["check", "spec.json", "--severity", "unused-tag=error"])).not.toBe(3);
  });

  it("accepts --overlay before the spec", async () => {
    expect(await exitFrom(["resolve", "--overlay", "a.json", "spec.json"])).not.toBe(3);
  });

  it("accepts --overlay after the spec", async () => {
    expect(await exitFrom(["resolve", "spec.json", "--overlay", "a.json"])).not.toBe(3);
  });

  // Repeating is how more than one value is passed now that neither is
  // variadic, so it has to keep working in the position that used to
  // fail.
  it("accepts a repeated --overlay before the spec", async () => {
    expect(
      await exitFrom(["resolve", "--overlay", "a.json", "--overlay", "b.json", "spec.json"]),
    ).not.toBe(3);
  });

  it("accepts a repeated --severity before the spec", async () => {
    expect(
      await exitFrom([
        "check",
        "--severity",
        "unused-tag=error",
        "--severity",
        "unused-component=error",
        "spec.json",
      ]),
    ).not.toBe(3);
  });
});
