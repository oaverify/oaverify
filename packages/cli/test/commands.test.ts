import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
      /Install @aahoughton\/oav/,
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

  it("--lint emits warnings to stderr, document still on stdout, exit 0", async () => {
    const { io, stdout, stderr } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await resolveCommand(
      { spec: "spec.json", overlays: [], lint: true, options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(stderr.value).toContain("warning [unused-component]");
    expect(stderr.value).toContain("/components/schemas/Orphan");
    expect(stdout.value).toContain('"openapi"');
  });

  it("--lint --fail-on warning bumps exit code to 1 when findings exist", async () => {
    const { io } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await resolveCommand(
      {
        spec: "spec.json",
        overlays: [],
        lint: true,
        failOn: "warning",
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(1);
  });

  it("--lint --fail-on warning stays at 0 when the spec is clean", async () => {
    const cleanSpec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const { io } = memoryIo([["spec.json", cleanSpec]]);
    const result = await resolveCommand(
      {
        spec: "spec.json",
        overlays: [],
        lint: true,
        failOn: "warning",
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(0);
  });

  it("--envelope json folds findings into the envelope (no stderr split)", async () => {
    const { io, stdout, stderr } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await resolveCommand(
      {
        spec: "spec.json",
        overlays: [],
        lint: true,
        envelope: "json",
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const envelope = JSON.parse(stdout.value);
    expect(envelope).toHaveProperty("document");
    expect(envelope.specHygieneIssues).toHaveLength(1);
    expect(envelope.specHygieneIssues[0].code).toBe("unused-component");
  });

  it("--fail-on without --lint is a usage error (exit 3)", async () => {
    const { io, stderr } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await resolveCommand(
      {
        spec: "spec.json",
        overlays: [],
        failOn: "warning",
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("--fail-on requires --lint");
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
