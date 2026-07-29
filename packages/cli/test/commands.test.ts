import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCommand,
  defaultCommandIo,
  resolveCommand,
  validateCommand,
  type CommandOptions,
} from "../src/commands.js";
import { memoryIo } from "./fixtures.js";

const textOpts: CommandOptions = { format: "text", quiet: false };

describe("defaultCommandIo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts http:// and https:// URIs without extra wiring", async () => {
    const spec = { openapi: "3.1.0", info: { title: "URL Spec", version: "1" }, paths: {} };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(spec), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const io = defaultCommandIo();
    // Bypass io.stdout / process.stdout for the assertion: we only
    // care that the chain claimed + fetched the URL.
    expect(io.reader.canRead("https://example.com/spec.json")).toBe(true);
    const loaded = await io.reader.read("https://example.com/spec.json");
    expect(loaded).toEqual(spec);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/spec.json");
  });

  it("still rejects .yaml URLs at the JSON reader layer with the install-hint error", async () => {
    const io = defaultCommandIo();
    await expect(io.reader.read("https://example.com/spec.yaml")).rejects.toThrow(
      /Install @oaverify\/yaml/,
    );
  });
});

describe("resolveCommand", () => {
  it("stitches overlays into the resolved spec", async () => {
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
        },
      ],
      [
        "overlay.json",
        { addPaths: { "/health": { get: { responses: { "200": { description: "ok" } } } } } },
      ],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: ["overlay.json"], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(stdout.value);
    expect(doc.paths["/pets"]).toBeDefined();
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("applies a standard OpenAPI Overlay 1.0 document without clobbering info (#448)", async () => {
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "Pets", version: "2.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {},
        },
      ],
      [
        "overlay.json",
        {
          overlay: "1.0.0",
          info: { title: "Add EU server", version: "1.0.0" },
          actions: [{ target: "$.servers", update: [{ url: "https://eu.api.example.com" }] }],
        },
      ],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: ["overlay.json"], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(stdout.value);
    // The action applied...
    expect(doc.servers).toEqual([
      { url: "https://api.example.com" },
      { url: "https://eu.api.example.com" },
    ]);
    // ...and the overlay's own envelope metadata did not leak into the
    // document (the pre-#448 behavior overwrote info.title / version).
    expect(doc.info).toEqual({ title: "Pets", version: "2.0.0" });
  });

  it("exits 3 with the translator's message when an Overlay 1.0 action is malformed", async () => {
    const { io, stderr } = memoryIo([
      ["spec.json", { openapi: "3.1.0", info: { title: "X", version: "1" }, paths: {} }],
      [
        "overlay.json",
        {
          overlay: "1.0.0",
          info: { title: "Bad", version: "1" },
          actions: [{ target: "$.nonsense[?(@ === 1)]", update: {} }],
        },
      ],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: ["overlay.json"], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("resolve: overlay.json:");
  });

  it("exits 3 naming the missing field when an Overlay 1.0 envelope is incomplete", async () => {
    const { io, stderr } = memoryIo([
      ["spec.json", { openapi: "3.1.0", info: { title: "X", version: "1" }, paths: {} }],
      // `overlay` marks the standard format, but `actions` is missing.
      ["overlay.json", { overlay: "1.0.0", info: { title: "Y", version: "1" } }],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: ["overlay.json"], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("actions");
  });

  it("exits 3 listing unrecognised keys for a file that is neither format", async () => {
    const { io, stderr } = memoryIo([
      ["spec.json", { openapi: "3.1.0", info: { title: "X", version: "1" }, paths: {} }],
      ["overlay.json", { addPaths: {}, patches: [], stuff: true }],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: ["overlay.json"], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("unrecognised overlay shape");
    expect(stderr.value).toContain("patches, stuff");
    // Recognised verbs are not blamed.
    expect(stderr.value).not.toContain("addPaths");
  });

  it("writes the resolved spec to the output path when given and stays silent on stdout", async () => {
    const { io, writes, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {},
        },
      ],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: [], options: { ...textOpts, output: "out.json" } },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("out.json");
    expect(writes[0]?.[1]).toContain('"openapi"');
    // Regression: `-o` used to write both to the file AND stdout.
    expect(stdout.value).toBe("");
  });

  it("suppresses stdout when --quiet is set", async () => {
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {},
        },
      ],
    ]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: [], options: { ...textOpts, quiet: true } },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(stdout.value).toBe("");
  });

  function dirtySpec(): unknown {
    return {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
      components: { schemas: { Orphan: { type: "object" } } },
    };
  }

  it("resolve prints the document and nothing else", async () => {
    // Lint moved to `check`; resolve is back to stitching and printing.
    const { io, stdout, stderr } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await resolveCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    expect(result.exitCode).toBe(0);
    expect(stdout.value).toContain('"openapi"');
    expect(stderr.value).toBe("");
  });

  it("check reports hygiene findings with their class and pointer", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await checkCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    expect(result.exitCode).toBe(0);
    expect(stdout.value).toContain("hygiene [unused-component]");
    expect(stdout.value).toContain("/components/schemas/Orphan");
  });

  it("check reports a shared component's defect once, with a count", async () => {
    // Schemas compile per operation, so a component reached from three
    // of them produced three identical findings. One defect, one edit
    // (#520). Without the collapse the ref-following lint (#513) turns
    // a real improvement into a wall of near-duplicate lines.
    const shared = {
      openapi: "3.0.3",
      info: { title: "X", version: "1" },
      components: {
        schemas: {
          Wrapper: {
            type: "object",
            properties: { inner: { $ref: "#/components/schemas/Inner", readOnly: true } },
          },
          Inner: { type: "object", properties: { z: { type: "string" } } },
        },
      },
      paths: Object.fromEntries(
        ["/a", "/b", "/c"].map((p) => [
          p,
          {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { w: { $ref: "#/components/schemas/Wrapper" } },
                      },
                    },
                  },
                },
              },
            },
          },
        ]),
      ),
    };
    const { io, stdout } = memoryIo([["spec.json", shared]]);
    await checkCommand(
      { spec: "spec.json", overlays: [], only: ["schema"], format: "json", options: textOpts },
      io,
    );
    const { findings } = JSON.parse(stdout.value) as {
      findings: { code: string; occurrences?: number }[];
    };
    const siblings = findings.filter((f) => f.code === "silent-rewrite/ref-siblings-oas30");
    expect(siblings).toHaveLength(1);
    expect(siblings[0]?.occurrences).toBe(3);
  });

  it("check leaves a single occurrence uncounted", async () => {
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/a": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: { type: "object", properties: {}, required: ["nope"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    ]);
    await checkCommand(
      { spec: "spec.json", overlays: [], only: ["schema"], format: "json", options: textOpts },
      io,
    );
    const { findings } = JSON.parse(stdout.value) as { findings: { occurrences?: number }[] };
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrences).toBeUndefined();
  });

  it("check reports everything it found even when a schema is malformed", async () => {
    // The abort used to discard findings it had already collected, so
    // running fewer checks reported more: `--only hygiene` surfaced the
    // unused component and the full run surfaced nothing (#515).
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      components: { schemas: { NeverUsed: { type: "object" } } },
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { type: "array", items: [{ type: "string" }] } },
                },
              },
            },
          },
        },
      },
    };
    const { io, stdout } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      io,
    );
    const { findings } = JSON.parse(stdout.value) as {
      findings: { class: string; code: string }[];
    };
    expect(findings.map((f) => f.code).sort()).toEqual(["malformed-schema", "unused-component"]);
    // Still exit 2: the document cannot be compiled, whatever else the
    // report says.
    expect(result.exitCode).toBe(4);
  });

  it("check exits 4 for a malformed schema even under --fail-on warning", async () => {
    const { io } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/t": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: { "application/json": { schema: { items: [{ type: "string" }] } } },
                  },
                },
              },
            },
          },
        },
      ],
    ]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], failOn: "warning", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(4);
  });

  it("check --fail-on warning exits 1 when findings exist, 0 when clean", async () => {
    const dirty = memoryIo([["spec.json", dirtySpec()]]);
    expect(
      (
        await checkCommand(
          { spec: "spec.json", overlays: [], failOn: "warning", options: textOpts },
          dirty.io,
        )
      ).exitCode,
    ).toBe(1);

    const clean = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
        },
      ],
    ]);
    expect(
      (
        await checkCommand(
          { spec: "spec.json", overlays: [], failOn: "warning", options: textOpts },
          clean.io,
        )
      ).exitCode,
    ).toBe(0);
  });

  it("check --format json emits one findings array, every entry classed", async () => {
    const { io, stdout, stderr } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const payload = JSON.parse(stdout.value) as { findings: { class: string }[] };
    expect(payload.findings.length).toBeGreaterThan(0);
    // `class` is required: a consumer must be able to re-split the array.
    for (const f of payload.findings) expect(f.class).toBeTruthy();
  });

  it("check --only narrows the classes that run", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    await checkCommand(
      { spec: "spec.json", overlays: [], only: ["schema"], format: "json", options: textOpts },
      io,
    );
    const payload = JSON.parse(stdout.value) as { findings: { class: string }[] };
    expect(payload.findings.every((f) => f.class === "schema")).toBe(true);
  });

  it("check reports a malformed schema as a finding and exits 4", async () => {
    // This used to go to stderr on the reasoning that a document which
    // cannot be compiled has nothing to grade. That was wrong in the
    // part that mattered: the rest of the document still grades, and
    // discarding it meant a consumer could not tell an abort from a
    // clean run (#515). The exit code still says the document cannot be
    // compiled.
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/p": {
              get: {
                parameters: [{ name: "q", in: "query", schema: { type: "Strng" } }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      ],
    ]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(4);
    const { findings } = JSON.parse(stdout.value) as {
      findings: { class: string; code: string; message: string }[];
    };
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("malformed-schema");
    expect(findings[0]?.message).toContain("unknown type name");
    // Its own class, not "schema": malformed and schema-lint are
    // different problems with different remedies, and a consumer
    // re-splitting the array should not have to match on `code`.
    expect(findings[0]?.class).toBe("malformed");
  });

  it("check surfaces malformed findings under --only schema", async () => {
    // "malformed" is a reported class, not a selectable one: a malformed
    // schema is found by compiling, which is what the schema class does.
    // Asking for `schema` therefore still surfaces it.
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/p": {
              get: {
                parameters: [{ name: "q", in: "query", schema: { type: "Strng" } }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      ],
    ]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], only: ["schema"], format: "json", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(4);
    const { findings } = JSON.parse(stdout.value) as { findings: { class: string }[] };
    expect(findings.map((f) => f.class)).toEqual(["malformed"]);
  });

  it("check reports an unresolvable $ref as a finding too", async () => {
    // Also raised while compiling an operation, so it is collected and
    // located like any other compile failure rather than aborting the
    // run. stderr stays for the case where the document cannot be read
    // or parsed at all, where there is genuinely nothing to report.
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": { schema: { $ref: "#/components/schemas/Nope" } },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    ]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(4);
    const { findings } = JSON.parse(stdout.value) as {
      findings: { code: string; message: string }[];
    };
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("malformed-schema");
    expect(findings[0]?.message).toContain("Nope");
  });

  it("check exits 2 on stderr when the document cannot be read", async () => {
    const { io, stderr } = memoryIo([]);
    const result = await checkCommand(
      { spec: "missing.json", overlays: [], options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(2);
    expect(stderr.value).toContain("check:");
  });

  it("separates 2 (no report) from 4 (graded, a schema is fatal)", async () => {
    // The whole point of the split: a script has to be able to tell
    // "I could not open your file" from "here is a complete report and
    // one of its findings is fatal". Both answered 2 before.
    const unreadable = memoryIo([]);
    const cannotRead = await checkCommand(
      { spec: "missing.json", overlays: [], format: "json", options: textOpts },
      unreadable.io,
    );
    expect(cannotRead.exitCode).toBe(2);
    expect(unreadable.stdout.value).toBe("");

    const bad = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/p": {
              get: {
                parameters: [{ name: "q", in: "query", schema: { type: "Strng" } }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      ],
    ]);
    const graded = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      bad.io,
    );
    expect(graded.exitCode).toBe(4);
    // Exit 4 always carries a report; exit 2 never does.
    const payload = JSON.parse(bad.stdout.value) as { findings: unknown[] };
    expect(payload.findings.length).toBeGreaterThan(0);
  });
});

describe("validateCommand", () => {
  function specWithRequiredBody(): unknown {
    return {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/pets": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", required: ["name"] },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
  }

  it("exits 3 on an unrecognised overlay shape (shared readOverlay path)", async () => {
    const { io, stderr } = memoryIo(
      [
        ["spec.json", specWithRequiredBody()],
        ["overlay.json", { patches: [] }],
      ],
      [["body.json", '{"name":"a"}']],
    );
    const result = await validateCommand(
      {
        spec: "spec.json",
        overlays: ["overlay.json"],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "body.json" },
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("validate: overlay.json:");
  });

  it("exits 0 when the body satisfies the schema, with nothing on stdout", async () => {
    const { io, stdout } = memoryIo(
      [["spec.json", specWithRequiredBody()]],
      [["body.json", '{"name":"a"}']],
    );
    const result = await validateCommand(
      {
        spec: "spec.json",
        overlays: [],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "body.json" },
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(0);
    // Silence on success: no bare newline leak.
    expect(stdout.value).toBe("");
  });

  it("exits 1 when the body is missing a required field", async () => {
    const { io, stdout } = memoryIo([["spec.json", specWithRequiredBody()]], [["body.json", "{}"]]);
    const result = await validateCommand(
      {
        spec: "spec.json",
        overlays: [],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "body.json" },
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(1);
    expect(stdout.value).toMatch(/required/i);
  });

  it("writes the rendered error to --output when given and stays silent on stdout", async () => {
    const { io, writes, stdout } = memoryIo(
      [["spec.json", specWithRequiredBody()]],
      [["body.json", "{}"]],
    );
    const result = await validateCommand(
      {
        spec: "spec.json",
        overlays: [],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "body.json" },
        options: { ...textOpts, output: "err.txt" },
      },
      io,
    );
    expect(result.exitCode).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("err.txt");
    expect(writes[0]?.[1]).toMatch(/required/i);
    // Regression: `-o` used to write both to the file AND stdout.
    expect(stdout.value).toBe("");
  });
});
