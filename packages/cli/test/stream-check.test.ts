import { describe, expect, it } from "vitest";
import { streamCheckCommand, type CommandOptions } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";

const textOpts: CommandOptions = { format: "text", quiet: false };

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
