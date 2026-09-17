import { describe, expect, it } from "vitest";
import { streamCheckCommand, type CommandOptions } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";

const textOpts: CommandOptions = { quiet: false };

// A spec with one streamable response and one request body that buffers
// unboundedly (a `pattern` string with no `maxLength`).
const SPEC = {
  openapi: "3.1.0",
  info: { title: "Demo", version: "1" },
  paths: {
    "/pets": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { code: { type: "string", pattern: "^[A-Z]+$" } },
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: { type: "array" } } } },
        },
      },
    },
  },
};

function io() {
  return memoryIo([["spec.json", SPEC]]);
}

const base = { spec: "spec.json", overlays: [], failOnUnbounded: false, verbose: false };

describe("streamCheckCommand", () => {
  // `--output` is a truncating write, so a command that reaches its sink
  // more than once silently loses all but the last call (#848). Both
  // formats are pinned here because the sink is per-command, not per
  // format, and only one of them was ever exercised with `-o`.
  it.each(["text", "json"] as const)("writes a %s report to --output exactly once", async (fmt) => {
    const { io: cmdIo, writes, stdout } = io();
    const res = await streamCheckCommand(
      { ...base, format: fmt, options: { ...textOpts, output: "out.txt" } },
      cmdIo,
    );

    expect(res.exitCode).toBe(0);
    expect(writes.map(([path]) => path)).toEqual(["out.txt"]);
    expect(writes[0]?.[1]).not.toBe("");
    // `-o` redirects the report rather than duplicating it.
    expect(stdout.value).toBe("");
  });

  it("prints a per-operation table with island counts (text, non-verbose)", async () => {
    const { io: cmdIo, stdout } = io();
    const res = await streamCheckCommand({ ...base, format: "text", options: textOpts }, cmdIo);
    expect(res.exitCode).toBe(0);
    expect(stdout.value).toContain('POST "/pets"');
    expect(stdout.value).toContain("buffer");
    expect(stdout.value).toContain("(1 unbounded, 0 bounded)");
    // Non-verbose: no per-position path lines.
    expect(stdout.value).not.toContain("code  pattern");
    expect(stdout.value).toContain("summary: 2 bodies in 1 operation.");
  });

  it("lists each unbounded position under --verbose", async () => {
    const { io: cmdIo, stdout } = io();
    await streamCheckCommand({ ...base, format: "text", verbose: true, options: textOpts }, cmdIo);
    expect(stdout.value).toContain("code  pattern  unbounded (needs maxLength)");
  });

  it.each([undefined, 4093, 4094, 65536, 131070, 131071])(
    "lists bounded estimates and compares them with cap %s",
    async (cap) => {
      const spec = structuredClone(SPEC);
      Object.assign(spec.paths["/pets"].post.requestBody.content["application/json"].schema, {
        properties: {
          message_id: { type: "string", pattern: "^.+$", maxLength: 1023 },
          entity_version: { type: "string", format: "uri", maxLength: 32767 },
          callback_url: { type: "string", format: "uri", maxLength: 32767 },
          code: { type: "string", pattern: "^[A-Z]+$" },
        },
      });
      const { io: cmdIo, stdout } = memoryIo([["spec.json", spec]]);
      const res = await streamCheckCommand(
        {
          ...base,
          format: "text",
          verbose: true,
          ...(cap === undefined ? {} : { maxBufferedBytes: cap }),
          options: textOpts,
        },
        cmdIo,
      );
      expect(res.exitCode).toBe(0);
      const overCap = (size: number) =>
        cap !== undefined && size > cap ? `; exceeds cap ${cap} B` : "";
      expect(stdout.value.split("\n").filter((line) => line.startsWith("         - "))).toEqual([
        `         - message_id  pattern  estimate 4094 B${overCap(4094)}`,
        `         - entity_version  format  estimate 131070 B${overCap(131070)}`,
        `         - callback_url  format  estimate 131070 B${overCap(131070)}`,
        "         - code  pattern  unbounded (needs maxLength)",
      ]);
    },
  );

  it.each([false, true])("renders a bounded root with verbose %s", async (verbose) => {
    const spec = structuredClone(SPEC);
    Object.assign(spec.paths["/pets"].post.requestBody.content["application/json"], {
      schema: { type: "string", pattern: "^.+$", maxLength: 10 },
    });
    const { io: cmdIo, stdout } = memoryIo([["spec.json", spec]]);
    const res = await streamCheckCommand(
      {
        ...base,
        format: "text",
        verbose,
        failOnUnbounded: true,
        maxBufferedBytes: 40,
        options: textOpts,
      },
      cmdIo,
    );
    expect(res.exitCode).toBe(0);
    expect(stdout.value).toContain("peak 42 B  (capped to 40 B)  (0 unbounded, 1 bounded)");
    expect(stdout.value.includes("         - ")).toBe(verbose);
    if (verbose) {
      expect(stdout.value).toContain("(root)  pattern  estimate 42 B; exceeds cap 40 B");
    }
  });

  it("compares concurrent buffers with the per-buffer cap", async () => {
    const spec = structuredClone(SPEC);
    Object.assign(spec.paths["/pets"].post.requestBody.content["application/json"], {
      schema: {
        allOf: [
          { type: "string", pattern: "^a", maxLength: 100 },
          { type: "string", pattern: "z$", maxLength: 100 },
        ],
      },
    });
    const { io: cmdIo, stdout } = memoryIo([["spec.json", spec]]);
    await streamCheckCommand(
      { ...base, format: "text", verbose: true, maxBufferedBytes: 300, options: textOpts },
      cmdIo,
    );
    expect(stdout.value).toContain("peak 804 B  (capped to 600 B)");
    expect(stdout.value).toContain("allOf.0  pattern  estimate 402 B; exceeds cap 300 B");
    expect(stdout.value).toContain("allOf.1  pattern  estimate 402 B; exceeds cap 300 B");
  });

  it("emits the SpecBudget as JSON under --format json", async () => {
    const { io: cmdIo, stdout } = io();
    await streamCheckCommand({ ...base, format: "json", options: textOpts }, cmdIo);
    const budget = JSON.parse(stdout.value);
    expect(budget.operations).toHaveLength(1);
    expect(budget.operations[0].bodies[0]).toMatchObject({
      role: "request",
      mediaType: "application/json",
    });
    expect(budget.operations[0].bodies[0].report.peakBytes).toBe("unbounded");
  });

  it("shows the effective peak in the text output when --max-buffered-bytes binds", async () => {
    const { io: cmdIo, stdout } = io();
    await streamCheckCommand(
      { ...base, format: "text", maxBufferedBytes: 1000, options: textOpts },
      cmdIo,
    );
    // The unbounded request body clamps to the cap; the table must surface it.
    expect(stdout.value).toContain("peak UNBOUNDED  (capped to 1000 B)");
  });

  it("does not show a cap suffix when no cap is set", async () => {
    const { io: cmdIo, stdout } = io();
    await streamCheckCommand({ ...base, format: "text", options: textOpts }, cmdIo);
    expect(stdout.value).not.toContain("capped to");
  });

  it("exits non-zero with --fail-on-unbounded when a body is unbounded", async () => {
    const { io: cmdIo } = io();
    const res = await streamCheckCommand(
      { ...base, format: "text", failOnUnbounded: true, options: textOpts },
      cmdIo,
    );
    expect(res.exitCode).toBe(1);
  });

  it("exits zero with --fail-on-unbounded when every body is bounded", async () => {
    const bounded = {
      openapi: "3.1.0",
      info: { title: "Bounded", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: { content: { "application/json": { schema: { type: "string" } } } },
          },
        },
      },
    };
    const { io: cmdIo } = memoryIo([["spec.json", bounded]]);
    const res = await streamCheckCommand(
      { ...base, format: "text", failOnUnbounded: true, options: textOpts },
      cmdIo,
    );
    expect(res.exitCode).toBe(0);
  });
});
