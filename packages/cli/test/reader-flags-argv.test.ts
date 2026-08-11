import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { memoryIo } from "./fixtures.js";
import type { ReaderPolicy } from "../src/reader-policy.js";

/**
 * Argv-level cover for the reader flags on every command that reads a
 * spec.
 *
 * The unit tests over `policyFor` and the composition prove the posture
 * is correct once a command holds it. What they cannot see is a command
 * that declares the flags and then drops them on the way to
 * `io.reader`, which leaves a security flag accepted, silent, and
 * inert. That is a per-command wiring fact, so it needs a per-command
 * test.
 */

const SPEC = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} };

/** Every command that takes a spec, with the argv that reaches loading. */
const SPEC_COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["resolve", ["resolve", "spec.json"]],
  ["check", ["check", "spec.json"]],
  ["stream-check", ["stream-check", "spec.json"]],
  ["validate", ["validate", "spec.json", "--path", "GET /a", "--body", "body.json"]],
  ["compile-spec", ["compile-spec", "spec.json", "--output", "out.mjs"]],
];

/** Run argv, capturing the policy each command handed to `io.reader`. */
async function policyFrom(argv: readonly string[]): Promise<ReaderPolicy | undefined> {
  const mem = memoryIo([["spec.json", SPEC]], [["body.json", "{}"]]);
  let seen: ReaderPolicy | undefined;
  const inner = mem.io.reader;
  const io = {
    ...mem.io,
    reader: (policy: ReaderPolicy) => {
      seen = policy;
      return inner(policy);
    },
  };
  const program = buildProgram({ io, exit: () => {} });
  try {
    await program.parseAsync(["node", "oaverify", ...argv]);
  } catch {
    // Commander throws on usage errors; the policy is what we assert.
  }
  return seen;
}

describe("reader flags reach every spec-taking command", () => {
  for (const [name, argv] of SPEC_COMMANDS) {
    it(`${name} honours --untrusted`, async () => {
      const policy = await policyFrom([...argv, "--untrusted"]);
      expect(policy?.untrusted, `${name} dropped --untrusted`).toBe(true);
      // --untrusted implies same-origin; a command that forwards one
      // field and not the other is the same bug in a smaller costume.
      expect(policy?.remoteRefs, `${name} dropped the implied posture`).toBe("same-origin");
    });

    it(`${name} honours --remote-refs`, async () => {
      const policy = await policyFrom([...argv, "--remote-refs", "deny"]);
      expect(policy?.remoteRefs, `${name} dropped --remote-refs`).toBe("deny");
    });

    it(`${name} defaults to same-origin`, async () => {
      // Every command has to arrive at the same default, not just the
      // one whose flag parsing someone remembered to change (#692).
      const policy = await policyFrom(argv);
      expect(policy?.remoteRefs).toBe("same-origin");
      expect(policy?.untrusted).toBe(false);
    });
  }
});
