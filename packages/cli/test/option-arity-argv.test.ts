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
 * Two things are asserted, because arity alone is not the contract. The
 * flag has to work on either side of the positional, and repeating it
 * has to accumulate every value in the order written: dropping the
 * variadic marker without a collector would fix the first and silently
 * break the second, keeping only the last value.
 */

const SPEC = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} };
const OVERLAY = { overlay: "1.0.0", info: { title: "o", version: "1" }, actions: [] };

/**
 * The parsed options of one subcommand, plus the commander error code if
 * argv failed to parse.
 *
 * `usageError` rather than the exit code, because a command can exit 3
 * for reasons that have nothing to do with arity, and asserting on the
 * code would tie these tests to whether the command can complete in this
 * environment. `commander.missingArgument` and
 * `commander.excessArguments` are the two an arity mistake produces.
 */
async function parse(
  command: string,
  argv: readonly string[],
): Promise<{ usageError?: string; opts: Record<string, unknown> }> {
  const mem = memoryIo(
    [
      ["spec.json", SPEC],
      ["a.json", OVERLAY],
      ["b.json", OVERLAY],
      ["c.json", OVERLAY],
    ],
    [],
  );
  const program = buildProgram({ io: mem.io, exit: () => {} });
  let usageError: string | undefined;
  try {
    await program.parseAsync(["node", "oaverify", ...argv]);
  } catch (err) {
    // Commander throws a CommanderError after exitOverride. Anything
    // else is the command failing on its own terms, which is not what
    // this suite measures.
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("commander.")) usageError = code;
  }
  const sub = program.commands.find((c) => c.name() === command);
  return { ...(usageError !== undefined && { usageError }), opts: sub?.opts() ?? {} };
}

describe("a repeatable flag does not swallow the positional", () => {
  const CASES: ReadonlyArray<{
    flag: string;
    command: string;
    value: string;
    key: string;
    extra?: readonly string[];
  }> = [
    { flag: "--severity", command: "check", value: "unused-tag=error", key: "severity" },
    { flag: "--overlay", command: "resolve", value: "a.json", key: "overlay" },
    // compile-spec needs an output sink; --only is the flag whose help
    // text advertised the space-separated form, so it is the one a user
    // is most likely to have written that way.
    {
      flag: "--only",
      command: "compile-spec",
      value: "GET /a",
      key: "only",
      extra: ["--output", "out.mjs"],
    },
  ];

  for (const { flag, command, value, key, extra } of CASES) {
    const tail = extra ?? [];

    // `--severity` and `--overlay` are genuinely guarded here: both
    // cases fail against the pre-fix declarations.
    //
    // `--only` is exercised but not guarded. Its variadic form failed by
    // throwing from its own value parser part-way through argv, rather
    // than by producing a commander usage error, and the option is left
    // holding the value that parsed before the throw. Neither assertion
    // below separates that from success. Reinstating
    // `--only <method-path...>` would not fail this file; it would fail
    // the migration guide's worked example instead.
    it(`accepts ${flag} before the spec`, async () => {
      const { usageError, opts } = await parse(command, [
        command,
        flag,
        value,
        "spec.json",
        ...tail,
      ]);
      expect(usageError).toBeUndefined();
      expect(opts[key]).toHaveLength(1);
    });

    it(`accepts ${flag} after the spec`, async () => {
      const { usageError, opts } = await parse(command, [
        command,
        "spec.json",
        flag,
        value,
        ...tail,
      ]);
      expect(usageError).toBeUndefined();
      expect(opts[key]).toHaveLength(1);
    });
  }

  // The form the variadic marker used to accept. Now a usage error, and
  // named in docs/migration-v7.md; asserted so the guide cannot drift
  // from the behaviour.
  it("rejects space-separated values with a usage error", async () => {
    const { usageError } = await parse("resolve", [
      "resolve",
      "spec.json",
      "--overlay",
      "a.json",
      "b.json",
    ]);
    expect(usageError).toBe("commander.excessArguments");
  });
});

describe("repeating a flag accumulates every value, in order", () => {
  it("collects repeated --overlay", async () => {
    const { opts } = await parse("resolve", [
      "resolve",
      "--overlay",
      "a.json",
      "--overlay",
      "b.json",
      "--overlay",
      "c.json",
      "spec.json",
    ]);
    expect(opts["overlay"]).toEqual(["a.json", "b.json", "c.json"]);
  });

  it("collects repeated --severity", async () => {
    const { opts } = await parse("check", [
      "check",
      "--severity",
      "unused-tag=error",
      "--severity",
      "unused-component=error",
      "spec.json",
    ]);
    expect(opts["severity"]).toEqual(["unused-tag=error", "unused-component=error"]);
  });

  // `--only` parses each value into a method/path pair as it collects,
  // so this asserts the parsed shape rather than the raw strings.
  it("collects repeated --only", async () => {
    const { opts } = await parse("compile-spec", [
      "compile-spec",
      "--only",
      "GET /a",
      "--only",
      "POST /b",
      "spec.json",
      "--output",
      "out.mjs",
    ]);
    expect(opts["only"]).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b" },
    ]);
  });

  // The comma-separated form is what --severity's help text shows, and
  // it is a single value rather than a repeat, so it must survive the
  // collector untouched for the parser downstream to split.
  it("leaves a comma-separated --severity value in one piece", async () => {
    const { opts } = await parse("check", [
      "check",
      "--severity",
      "unused-tag=error,unused-component=error",
      "spec.json",
    ]);
    expect(opts["severity"]).toEqual(["unused-tag=error,unused-component=error"]);
  });
});
