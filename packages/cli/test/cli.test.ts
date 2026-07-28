import { describe, expect, it } from "vitest";
import { buildProgram, defaultExit } from "../src/cli.js";
import { memoryIo, type MemoryIo } from "./fixtures.js";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceAliases } from "../../../workspace-aliases.js";

// The emitted module imports `@oaverify/core` subpaths by their real
// published names, which resolve through that package's exports map to
// its build output. The suite runs against source with no prior build,
// so alias them to the workspace sources via the same table vitest uses.
const CORE_ALIASES = Object.fromEntries(
  Object.entries(
    workspaceAliases(resolvePath(fileURLToPath(new URL("../../..", import.meta.url)))),
  ).filter(([k]) => k.startsWith("@oaverify/core")),
);

/**
 * Argv-level coverage of the Commander program. Previously the CLI
 * could only be exercised end-to-end via `pnpm build` + `spawnSync`,
 * so argv wiring (deriveMode, --format validation, exit code 3 for
 * usage errors) had no in-process regression guard.
 */

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function runCli(argv: string[], mem: MemoryIo): Promise<Captured> {
  const out: Captured = { stdout: "", stderr: "", exitCode: undefined };
  class ExitTrap extends Error {
    constructor(public code: number) {
      super(`exit(${code})`);
    }
  }
  const program = buildProgram({
    io: mem.io,
    exit: (code) => {
      throw new ExitTrap(code);
    },
  });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof ExitTrap) {
      out.exitCode = err.code;
    } else {
      throw err;
    }
  }
  out.stdout = mem.stdout.value;
  out.stderr = mem.stderr.value;
  return out;
}

const spec = {
  openapi: "3.1.0",
  info: { title: "x", version: "1" },
  paths: {
    "/pets": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "ok" } },
      },
    },
  },
};

describe("buildProgram: argv-level", () => {
  it("resolve prints the stitched document and exits 0", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    const out = await runCli(["resolve", "spec.json"], mem);
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout);
    expect(doc.paths["/pets"]).toBeDefined();
  });

  it("resolve -o writes to the file and stays silent on stdout", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    const out = await runCli(["resolve", "spec.json", "-o", "resolved.json"], mem);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(mem.writes).toHaveLength(1);
    expect(mem.writes[0]?.[0]).toBe("resolved.json");
    expect(mem.writes[0]?.[1]).toContain('"openapi"');
  });

  it("check --fail-on warning exits 1 when the spec has hygiene issues", async () => {
    const dirty = {
      ...spec,
      components: { schemas: { Orphan: { type: "object" } } },
    };
    const mem = memoryIo([["spec.json", dirty]]);
    const out = await runCli(["check", "spec.json", "--fail-on", "warning"], mem);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("hygiene [unused-component]");
  });

  it("check --format json emits one classed findings array", async () => {
    const dirty = {
      ...spec,
      components: { schemas: { Orphan: { type: "object" } } },
    };
    const mem = memoryIo([["spec.json", dirty]]);
    const out = await runCli(["check", "spec.json", "--format", "json"], mem);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const payload = JSON.parse(out.stdout) as { findings: { class: string; code: string }[] };
    expect(payload.findings.some((f) => f.code === "unused-component")).toBe(true);
    for (const f of payload.findings) expect(f.class).toBeTruthy();
  });

  it("check rejects an unknown --only class as a usage error", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    await expect(runCli(["check", "spec.json", "--only", "nonsense"], mem)).rejects.toThrow(
      /unknown check class/,
    );
  });

  it("resolve no longer accepts --lint", async () => {
    // Moved to `check`. Commander rejects the unknown option.
    const mem = memoryIo([["spec.json", spec]]);
    await expect(runCli(["resolve", "spec.json", "--lint"], mem)).rejects.toThrow(
      /unknown option .--lint./,
    );
  });

  it("validate --path/--body happy path exits 0 and stays silent", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", JSON.stringify({ name: "Fido" })]]);
    const out = await runCli(
      ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json"],
      mem,
    );
    expect(out.stderr, `stderr: ${out.stderr}`).toBe("");
    expect(out.stdout).toBe("");
    expect(out.exitCode).toBe(0);
  });

  it("validate --path/--body failure exits 1 and prints an error", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", JSON.stringify({})]]);
    const out = await runCli(
      ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json"],
      mem,
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("required");
  });

  it("validate without --request or --path is a usage error (exit 3)", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    const out = await runCli(["validate", "spec.json"], mem);
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain("provide either --request");
  });

  it("validate --response requires --status", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", "{}"]]);
    const out = await runCli(
      ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json", "--response"],
      mem,
    );
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain("--response requires --status");
  });

  it("validate --format rejects unknown formats with a usage error", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", "{}"]]);
    // Commander surfaces its own error for argument-validator throws; exit 3
    // is driven by our catch block.
    await expect(
      runCli(
        ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json", "--format", "xml"],
        mem,
      ),
    ).rejects.toThrow(/unknown format: xml/);
  });

  it("compile-schema rejects an unknown --dialect with a usage error", async () => {
    const mem = memoryIo([], [["schema.json", "{}"]]);
    await expect(
      runCli(["compile-schema", "schema.json", "--dialect", "draft-07"], mem),
    ).rejects.toThrow(/unknown dialect: draft-07/);
  });

  it("validate --request reads an .http file and exits 0 on success", async () => {
    const httpFile = "POST /pets HTTP/1.1\nContent-Type: application/json\n\n" + '{"name":"Fido"}';
    const mem = memoryIo([["spec.json", spec]], [["req.http", httpFile]]);
    const out = await runCli(["validate", "spec.json", "--request", "req.http"], mem);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
  });

  it("validate --request surfaces validation errors with exit 1", async () => {
    const httpFile =
      "POST /pets HTTP/1.1\nContent-Type: application/json\n\n" + '{"wrong":"field"}';
    const mem = memoryIo([["spec.json", spec]], [["req.http", httpFile]]);
    const out = await runCli(["validate", "spec.json", "--request", "req.http"], mem);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("required");
  });

  it("validate --response --status validates a response body", async () => {
    // Spec with a typed 200 response so the validator has something to
    // check. The base `spec` only has `description: ok` on responses.
    const respSpec = {
      ...spec,
      paths: {
        "/pets/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["name"],
                      properties: { name: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const okMem = memoryIo(
      [["spec.json", respSpec]],
      [["body.json", JSON.stringify({ name: "Fido" })]],
    );
    const ok = await runCli(
      [
        "validate",
        "spec.json",
        "--path",
        "GET /pets/42",
        "--body",
        "body.json",
        "--response",
        "--status",
        "200",
      ],
      okMem,
    );
    expect(ok.exitCode).toBe(0);

    const failMem = memoryIo([["spec.json", respSpec]], [["body.json", JSON.stringify({})]]);
    const fail = await runCli(
      [
        "validate",
        "spec.json",
        "--path",
        "GET /pets/42",
        "--body",
        "body.json",
        "--response",
        "--status",
        "200",
      ],
      failMem,
    );
    expect(fail.exitCode).toBe(1);
    expect(failMem.stdout.value).toContain("required");
  });

  it("validate --format json on the error path emits parseable JSON", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", JSON.stringify({})]]);
    const out = await runCli(
      ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json", "--format", "json"],
      mem,
    );
    expect(out.exitCode).toBe(1);
    // stdout for the error tree (exit code is what flags failure).
    const parsed = JSON.parse(out.stdout);
    expect(parsed.code).toBeDefined();
  });

  it("validate --format summary on the error path emits one error per line", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", JSON.stringify({})]]);
    const out = await runCli(
      [
        "validate",
        "spec.json",
        "--path",
        "POST /pets",
        "--body",
        "body.json",
        "--format",
        "summary",
      ],
      mem,
    );
    expect(out.exitCode).toBe(1);
    const lines = out.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // Summary format puts each leaf on its own line; no nested indentation.
    for (const line of lines) expect(line.startsWith(" ")).toBe(false);
  });

  it("validate --format flat still parses as a deprecated alias of summary", async () => {
    const mem = memoryIo([["spec.json", spec]], [["body.json", JSON.stringify({})]]);
    const out = await runCli(
      ["validate", "spec.json", "--path", "POST /pets", "--body", "body.json", "--format", "flat"],
      mem,
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout.length).toBeGreaterThan(0);
  });
});

// The compile-schema command always bundles via esbuild. These tests
// invoke the command directly (not through runCli) so they can override
// the esbuild resolveDir to point at packages/cli/, which declares every
// `@oaverify/core` the emitted module imports and so has the symlink. In
// production the consumer's cwd has @oaverify/core installed and the
// default resolveDir is correct.
describe("compile-schema output", () => {
  it("produces an import-free bundle that runs", async () => {
    const { compileSchemaCommand } = await import("../src/commands.js");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const mem = memoryIo([], [["schema.json", JSON.stringify(schema)]]);
    const resolveDir = resolve(fileURLToPath(new URL("../../oav", import.meta.url)));
    const res = await compileSchemaCommand(
      {
        schema: "schema.json",
        output: "v.mjs",
        dialect: "2020-12",
        resolveDir,
        bundleAlias: CORE_ALIASES,
      },
      mem.io,
    );
    if (res.exitCode !== 0) console.error("stderr:", mem.stderr.value);
    expect(res.exitCode).toBe(0);

    const bundled = mem.writes[0]?.[1] ?? "";
    expect(bundled).not.toMatch(/from\s+["']@oaverify\//);
    expect(bundled).not.toMatch(/from\s+["']@oaverify\/internal-/);
    expect(bundled).toMatch(/\bvalidate\b/);

    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`
    )) as { validate: (d: unknown) => { valid: boolean } };
    expect(mod.validate({ name: "Fido" })).toEqual({ valid: true });
    expect(mod.validate({}).valid).toBe(false);
  });

  it("surfaces unknown-format errors on stderr with exit 3 (before bundle)", async () => {
    const { compileSchemaCommand } = await import("../src/commands.js");
    const schema = { type: "string", format: "phone-number" };
    const mem = memoryIo([], [["schema.json", JSON.stringify(schema)]]);
    const res = await compileSchemaCommand({ schema: "schema.json" }, mem.io);
    expect(res.exitCode).toBe(3);
    expect(mem.stderr.value).toContain("phone-number");
    expect(mem.stderr.value).toContain("built-in");
  });
});

describe("default exit handler", () => {
  // The bug this guards is process-level: `process.exit` discards
  // whatever is still queued on a pipe, so a report over 64 KiB arrived
  // truncated at exit 0 (#510). The end-to-end proof needs a real pipe
  // and lives in the pack-smoke CI job; this pins the mechanism so a
  // revert to `process.exit` fails here first.
  it("sets the exit code instead of terminating", () => {
    const before = process.exitCode;
    try {
      defaultExit(2);
      expect(process.exitCode).toBe(2);
      // Reaching this line at all is the other half of the assertion:
      // `process.exit(2)` would have taken the test runner with it.
      defaultExit(0);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = before;
    }
  });
});
