import { resolveJsonPointer } from "@oaverify/internal-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckFinding } from "@oaverify/check";
import {
  checkCommand,
  compileSchemaCommand,
  defaultCommandIo,
  resolveCommand,
  validateCommand,
  type CommandOptions,
} from "../src/commands.js";
import { policyFor } from "../src/reader-policy.js";
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
    const reader = io.reader(policyFor("https://example.com/spec.json"));
    expect(reader.canRead("https://example.com/spec.json")).toBe(true);
    const loaded = await reader.read("https://example.com/spec.json");
    expect(loaded).toEqual(spec);
    // The default caps put a timeout on every request, so the reader
    // now always passes an init rather than calling fetch bare.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/spec.json",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("still rejects .yaml URLs at the JSON reader layer with the install-hint error", async () => {
    const io = defaultCommandIo();
    await expect(
      io.reader(policyFor("https://example.com/spec.yaml")).read("https://example.com/spec.yaml"),
    ).rejects.toThrow(/Install @oaverify\/yaml/);
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
    expect(stdout.value).toContain("hygiene      unused-component");
    expect(stdout.value).toContain("/components/schemas/Orphan");
  });

  it("check reports document conformance against the meta-schema for the declared version", async () => {
    // The defect this whole class exists for: a null `description` on a
    // Response Object. It is not a schema, so the schema classes cannot
    // reach it, and it is legal YAML, so parsing does not.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: { "/t": { get: { responses: { "202": { description: null } } } } },
    };
    const { io, stdout } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    // A conformance violation is error severity, and the gate defaults
    // to error (#549), so this exits 1 with no flag.
    expect(result.exitCode).toBe(1);
    expect(stdout.value).toContain("conformance  type");
    expect(stdout.value).toContain("/paths/~1t/get/responses/202/description");
  });

  it("check --format json carries structured reasons on examples findings (#580)", async () => {
    // The point of the field: a consumer keying on the rejected value
    // reads `params`, and never parses the message to find it.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: {
        "/t": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", enum: ["ACH", "CHECK"] },
                  example: "EFT",
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { io, stdout } = memoryIo([["spec.json", spec]]);
    await checkCommand({ spec: "spec.json", overlays: [], format: "json", options: textOpts }, io);

    const findings = (JSON.parse(stdout.value) as { findings: CheckFinding[] }).findings;
    const example = findings.find((f) => f.class === "examples");
    expect(example?.reasons).toEqual([
      {
        code: "enum",
        path: [],
        message: expect.any(String),
        params: { allowed: ["ACH", "CHECK"], actual: "EFT" },
      },
    ]);
  });

  it("check leaves reasons absent on the classes that produce no leaf causes", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    await checkCommand({ spec: "spec.json", overlays: [], format: "json", options: textOpts }, io);

    const findings = (JSON.parse(stdout.value) as { findings: CheckFinding[] }).findings;
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      if (f.class !== "examples") expect(f.reasons).toBeUndefined();
    }
  });

  describe("finding source provenance (#596)", () => {
    const findingsOf = async (
      entries: Array<[string, unknown]>,
      spec = "entry.json",
    ): Promise<CheckFinding[]> => {
      const { io, stdout } = memoryIo(entries);
      await checkCommand({ spec, overlays: [], format: "json", options: textOpts }, io);
      return (JSON.parse(stdout.value) as { findings: CheckFinding[] }).findings;
    };

    /** The defect lives in the referenced file, not in the entry. */
    const twoFiles: Array<[string, unknown]> = [
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1.0.0" },
          paths: {
            "/orders": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { $ref: "./order.json#/components/schemas/Order" },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      ],
      [
        "order.json",
        {
          components: {
            schemas: {
              Order: {
                type: "object",
                required: ["id", "nope"],
                properties: { id: { type: "string" } },
              },
            },
          },
        },
      ],
    ];

    it("names the file a finding came from, and the reference that reached it", async () => {
      const findings = await findingsOf(twoFiles);
      const issue = findings.find((f) => f.code === "silent-rewrite/required-not-in-properties");
      // Before this, the report named `/components/schemas/Order`, a
      // component the entry document does not contain, and nothing
      // named order.json at all.
      expect(issue?.target).toEqual({
        pointer: "/components/schemas/Order/required",
        anchor: "scoped-definition",
        source: {
          uri: "order.json",
          pointer: "/components/schemas/Order/required",
          via: [
            {
              uri: "entry.json",
              pointer: "/paths/~1orders/post/requestBody/content/application~1json/schema",
            },
          ],
        },
      });
    });

    it("gives a single-file spec its own file, with an empty chain", async () => {
      const findings = await findingsOf([["spec.json", dirtySpec()]], "spec.json");
      const unused = findings.find((f) => f.code === "unused-component");
      expect(unused?.target?.source).toEqual({
        uri: "spec.json",
        pointer: "/components/schemas/Orphan",
        via: [],
      });
    });

    it("leaves no source on a node the resolver invented", async () => {
      // `components` exists only because hoisting needed somewhere to
      // put the target, so a finding addressed there has no file to
      // name. `unused-component` fires on the hoisted schema, whose own
      // address is real.
      const findings = await findingsOf(twoFiles);
      for (const finding of findings) {
        const source = finding.target?.source;
        if (source === undefined) continue;
        expect(["entry.json", "order.json"]).toContain(source.uri);
      }
    });
  });

  describe("machine-readable finding target (#517)", () => {
    const findingsOf = async (spec: unknown): Promise<CheckFinding[]> => {
      const { io, stdout } = memoryIo([["spec.json", spec]]);
      await checkCommand(
        { spec: "spec.json", overlays: [], format: "json", options: textOpts },
        io,
      );
      return (JSON.parse(stdout.value) as { findings: CheckFinding[] }).findings;
    };

    it("anchors a hygiene finding at the node, since no ref was crossed", async () => {
      const findings = await findingsOf(dirtySpec());
      const unused = findings.find((f) => f.code === "unused-component");
      expect(unused?.target).toMatchObject({
        pointer: "/components/schemas/Orphan",
        anchor: "node",
      });
    });

    it("anchors an inline schema finding at the node", async () => {
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        paths: {
          "/t": {
            get: {
              parameters: [{ name: "q", in: "query", schema: { type: "string", minLenght: 1 } }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const issue = findings.find((f) => f.code === "unknown-keyword");
      expect(issue?.target).toMatchObject({
        pointer: "/paths/~1t/get/parameters/0/schema",
        anchor: "node",
      });
    });

    it("anchors a ref-crossing, route-independent finding at the definition", async () => {
      // Half one of the anchor invariant: a rule whose verdict is a property
      // of the text it points at, reached through a `$ref`.
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: { schemas: { T: { type: "object", properties: { a: { minLenght: 1 } } } } },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/T" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const issue = findings.find((f) => f.code === "unknown-keyword");
      expect(issue?.target).toMatchObject({
        pointer: "/components/schemas/T/properties/a",
        anchor: "definition",
      });
    });

    it("anchors a ref-crossing, route-dependent finding as scoped-definition", async () => {
      // Half two of the anchor invariant. `required-not-in-properties`
      // asks what is reachable at
      // an instance position, so the component it points at may be
      // perfectly correct for its other users. `definition` here would
      // tell a reader to fix shared text that is not wrong.
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: {
          schemas: {
            T: { type: "object", properties: { name: { type: "string" } }, required: ["nam"] },
          },
        },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/T" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const issue = findings.find((f) => f.code === "silent-rewrite/required-not-in-properties");
      expect(issue?.target).toMatchObject({
        pointer: "/components/schemas/T/required",
        anchor: "scoped-definition",
      });
    });

    it("addresses a malformed schema at the same place a lint issue would be", async () => {
      // A schema that will not compile still has an address, and it is
      // the one the successful path would have used.
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { type: "object", items: [1, 2] } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const malformed = findings.find((f) => f.class === "malformed");
      expect(malformed?.target).toMatchObject({
        pointer: "/paths/~1t/post/requestBody/content/application~1json/schema",
        anchor: "node",
      });
    });

    it("addresses a malformed ref-rooted body at its component", async () => {
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: { schemas: { Bad: { type: "object", items: [1, 2] } } },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Bad" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      const malformed = findings.find((f) => f.class === "malformed");
      expect(malformed?.target).toMatchObject({
        pointer: "/components/schemas/Bad",
        anchor: "definition",
      });
    });

    it("reports two components with the same defect separately", async () => {
      // The message carries only the path within a schema, so these two
      // share one. They are two edits in two places, and collapsing
      // them hid the second entirely.
      const body = (ref: string) => ({
        post: {
          requestBody: { content: { "application/json": { schema: { $ref: ref } } } },
          responses: { "200": { description: "ok" } },
        },
      });
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: {
          schemas: {
            Alpha: { type: "object", properties: { a: { nope: 1 } } },
            Beta: { type: "object", properties: { a: { nope: 1 } } },
          },
        },
        paths: {
          "/one": body("#/components/schemas/Alpha"),
          "/two": body("#/components/schemas/Beta"),
        },
      });

      const pointers = findings
        .filter((f) => f.code === "unknown-keyword")
        .map((f) => f.target?.pointer)
        .sort((a, b) => (a ?? "").localeCompare(b ?? ""));
      expect(pointers).toEqual([
        "/components/schemas/Alpha/properties/a",
        "/components/schemas/Beta/properties/a",
      ]);
    });

    it("still collapses one defect reported at one address twice", async () => {
      // What #520 wanted: the same address reached more than once is one
      // edit, and is reported once.
      const findings = await findingsOf({
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: { schemas: { Shared: { type: "object", properties: { a: { nope: 1 } } } } },
        paths: {
          "/one": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Shared" } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
          "/two": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Shared" } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });

      const shared = findings.filter((f) => f.code === "unknown-keyword");
      expect(shared).toHaveLength(1);
      expect(shared[0]?.target?.pointer).toBe("/components/schemas/Shared/properties/a");
    });

    it("keeps every emitted pointer resolvable against the graded document", async () => {
      // The contract FindingTarget.pointer states. Asserted over a
      // document that exercises several classes at once rather than
      // per-case, since the guarantee is about the field and not about
      // any one producer.
      const doc = {
        openapi: "3.1.0",
        info: { title: "X", version: "1.0.0" },
        components: {
          schemas: {
            Orphan: { type: "object" },
            Shared: { type: "object", properties: { a: { minLenght: 1 } }, required: ["nope"] },
          },
        },
        paths: {
          "/t/{id}": {
            post: {
              parameters: [{ name: "id", in: "path", required: true, schema: { nope: 1 } }],
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Shared" } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const findings = await findingsOf(doc);
      const targeted = findings.filter((f) => f.target !== undefined);
      expect(targeted.length).toBeGreaterThan(3);
      for (const f of targeted) {
        expect(() => resolveJsonPointer(doc, f.target!.pointer)).not.toThrow();
      }
    });
  });

  it("carries each leaf issue's document address under the reserved name", async () => {
    // The four-referent rule: `pointer` is a document address,
    // `location` is prose. `ConformanceIssue` used to call its pointer
    // `location`, which made one name mean two things at two altitudes.
    const { io, stdout } = memoryIo([
      [
        "spec.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1.0.0" },
          paths: { "/t": { get: { responses: { "202": { description: null } } } } },
        },
      ],
    ]);
    await checkCommand({ spec: "spec.json", overlays: [], format: "json", options: textOpts }, io);
    const findings = (JSON.parse(stdout.value) as { findings: CheckFinding[] }).findings;
    const conformance = findings.find((f) => f.class === "conformance");
    expect(conformance?.target?.pointer).toBe("/paths/~1t/get/responses/202/description");
    // The deprecated alias still carries the same value.
    expect(conformance?.location).toBe("/paths/~1t/get/responses/202/description");
  });

  it("check --only conformance runs neither hygiene nor the schema compile", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], findings: "conformance", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(stdout.value).not.toMatch(/^\w+\s+hygiene\s/m);
    expect(stdout.value).not.toMatch(/^\w+\s+schema\s/m);
  });

  it("check labels every finding with a severity", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    await checkCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    // Severity leads each line, and the summary breaks the total down.
    expect(stdout.value).toMatch(/^(warning|error|fatal)\s+\w+\s+\S+$/m);
    expect(stdout.value).toMatch(/finding\(s\): /);
  });

  it("check renders each finding as a header, an indented message and a deeper location", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    await checkCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    // The three parts a reader asks for separately, each at its own left
    // edge: severity/class/code flush, message at 2, location at 4. The
    // indents are the whole point of the layout, so they are asserted
    // rather than the wording of any one finding.
    expect(stdout.value).toMatch(
      /^warning {2}hygiene {6}unused-component\n {2}\S.*\n {4}at \/components\/schemas\/Orphan\n\n/m,
    );
  });

  it("check wraps report prose to the requested width", async () => {
    const { io, stdout } = memoryIo([["spec.json", dirtySpec()]]);
    await checkCommand({ spec: "spec.json", overlays: [], width: 40, options: textOpts }, io);
    const wrapped = stdout.value
      .split("\n")
      .filter((l) => l.startsWith("  ") && !l.includes(" at "));
    expect(wrapped.length).toBeGreaterThan(1);
    // Wrapping is greedy on whitespace and never splits a token, so a
    // line may overrun only when it holds one word that does not fit.
    for (const line of wrapped) {
      expect(line.length <= 40 || line.trim().split(/\s+/).length === 1).toBe(true);
    }
  });

  it("check --fail-on error gates on specification violations and ignores the rest", async () => {
    // The capability severity exists to provide. An unused component is
    // legal; before this there was no way to say "break the build on
    // things that are actually wrong" without also breaking it on that.
    const tidyOnly = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
      components: { schemas: { Orphan: { type: "string" } } },
    };
    const { io } = memoryIo([["spec.json", tidyOnly]]);
    expect(
      (
        await checkCommand(
          { spec: "spec.json", overlays: [], failOn: "error", options: textOpts },
          io,
        )
      ).exitCode,
    ).toBe(0);

    const { io: io2 } = memoryIo([["spec.json", tidyOnly]]);
    expect(
      (
        await checkCommand(
          { spec: "spec.json", overlays: [], failOn: "warning", options: textOpts },
          io2,
        )
      ).exitCode,
    ).toBe(1);
  });

  it("check --format sarif carries the consumer's grading into level (#606)", async () => {
    // The coupling with #607: SARIF `level` comes from the severity as
    // this run reported it, so a consumer's policy reaches code
    // scanning without the converter holding one of its own.
    const tidyOnly = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
      components: { schemas: { Orphan: { type: "string" } } },
    };

    const { io, stdout } = memoryIo([["spec.json", tidyOnly]]);
    await checkCommand({ spec: "spec.json", overlays: [], format: "sarif", options: textOpts }, io);
    const before = JSON.parse(stdout.value);
    expect(before.version).toBe("2.1.0");
    expect(before.runs[0].results[0].level).toBe("warning");

    const { io: io2, stdout: out2 } = memoryIo([["spec.json", tidyOnly]]);
    await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        format: "sarif",
        severity: ["hygiene=error"],
        options: textOpts,
      },
      io2,
    );
    expect(JSON.parse(out2.value).runs[0].results[0].level).toBe("error");
  });

  it("check --severity regrades a class, and that changes the gate (#607)", async () => {
    // The point of the option. An unused component is graded `warning`,
    // so `--fail-on error` ignores it; a team that disagrees says so and
    // the exit code follows, without post-processing JSON.
    const tidyOnly = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
      components: { schemas: { Orphan: { type: "string" } } },
    };

    const { io } = memoryIo([["spec.json", tidyOnly]]);
    const before = await checkCommand(
      { spec: "spec.json", overlays: [], failOn: "error", options: textOpts },
      io,
    );
    expect(before.exitCode).toBe(0);

    const { io: io2, stdout } = memoryIo([["spec.json", tidyOnly]]);
    const after = await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        failOn: "error",
        severity: ["hygiene=error"],
        options: textOpts,
      },
      io2,
    );
    expect(after.exitCode).toBe(1);
    // And the report says so too, not only the exit code.
    expect(stdout.value).toContain("error");
  });

  it("check --severity refuses a bad map before reading the document", async () => {
    // No spec entry at all: reaching the reader would throw something
    // else, so the usage error has to come first.
    const { io, stderr } = memoryIo([]);
    const res = await checkCommand(
      { spec: "absent.json", overlays: [], severity: ["typo=error"], options: textOpts },
      io,
    );
    expect(res.exitCode).toBe(3);
    expect(stderr.value).toContain("--severity");
    expect(stderr.value).toContain("is not a class");
  });

  it("check --severity cannot remap malformed", async () => {
    const { io, stderr } = memoryIo([]);
    const res = await checkCommand(
      { spec: "absent.json", overlays: [], severity: ["malformed=warning"], options: textOpts },
      io,
    );
    expect(res.exitCode).toBe(3);
    expect(stderr.value).toContain("always exit 4");
  });

  it("check --fail-on warning still means any finding at all", async () => {
    // Backward compatibility, asserted rather than assumed. Introducing
    // severity must not quietly demote existing findings below an
    // existing gate; anyone with --fail-on warning in CI keeps the
    // behaviour they had.
    const { io } = memoryIo([["spec.json", dirtySpec()]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], failOn: "warning", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(1);
  });

  it("check --fail-on error fires on a path parameter that is never declared", async () => {
    // A hygiene finding that is a specification violation, so it gates
    // at error even though its class is shared with tidiness codes.
    // This is the case that proves class and severity are independent.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1.0.0" },
      paths: { "/t/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const { io } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], failOn: "error", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(1);
  });

  it("check stays quiet about conformance for a version it has no schema for", async () => {
    // Swagger 2.0 is not "non-conformant"; it is unknown. Reporting
    // failures against a guessed schema would be worse than silence.
    const { io, stdout } = memoryIo([["spec.json", { swagger: "2.0", info: {}, paths: {} }]]);
    await checkCommand(
      { spec: "spec.json", overlays: [], findings: "conformance", options: textOpts },
      io,
    );
    expect(stdout.value).not.toMatch(/^\w+\s+conformance\s/m);
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
      { spec: "spec.json", overlays: [], findings: "schema", format: "json", options: textOpts },
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
      { spec: "spec.json", overlays: [], findings: "schema", format: "json", options: textOpts },
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

  it("check prints findings collected before an exit-2 abort", async () => {
    // #716, the same principle as #515 applied to the router abort:
    // running fewer checks should not report more. These templates
    // collide once the malformed escape is taken literally, so
    // createRouter throws; the finding naming the escape is what says
    // why, and used to go out with it.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/bad%zz": { get: { responses: { "200": { description: "ok" } } } },
        "/bad%25zz": { get: { responses: { "200": { description: "ok" } } } },
      },
    };
    const { io, stderr, stdout } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "text", options: textOpts },
      io,
    );
    // The abort still decides the exit code: nothing was fully graded.
    expect(result.exitCode).toBe(2);
    expect(stderr.value).toContain("both declare GET on the same path structure");
    expect(stderr.value).toContain("1 finding(s) produced before the check was aborted");
    expect(stderr.value).toContain("path-template-malformed");
    // Partial findings never reach the report sink, so a consumer
    // reading stdout cannot mistake them for a complete report.
    expect(stdout.value).toBe("");
  });

  it("check keeps stdout empty on an aborted --format json run", async () => {
    // The partial block stays text on stderr whatever --format says, so
    // a json consumer never parses a half report.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/bad%zz": { get: { responses: { "200": { description: "ok" } } } },
        "/bad%25zz": { get: { responses: { "200": { description: "ok" } } } },
      },
    };
    const { io, stderr, stdout } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], format: "json", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("path-template-malformed");
  });

  it("check honours --skip for findings carried out of an abort", async () => {
    // A code suppressed in CI stays suppressed, or the abort path would
    // report what a clean run does not.
    const spec = {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/bad%zz": { get: { responses: { "200": { description: "ok" } } } },
        "/bad%25zz": { get: { responses: { "200": { description: "ok" } } } },
      },
    };
    const { io, stderr } = memoryIo([["spec.json", spec]]);
    const result = await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        format: "text",
        findings: "-path-template-malformed",
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(2);
    expect(stderr.value).not.toContain("path-template-malformed");
    expect(stderr.value).not.toContain("produced before the check was aborted");
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
      { spec: "spec.json", overlays: [], findings: "schema", format: "json", options: textOpts },
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
      { spec: "spec.json", overlays: [], findings: "schema", format: "json", options: textOpts },
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

  it("refuses to take both the spec and the payload from stdin (#602)", async () => {
    // One stream, two consumers. Whichever read first would win and the
    // other would fail on an empty document, so say what is wrong
    // instead. Checked before anything is read, so no input is consumed.
    const { io, stderr } = memoryIo([["spec.json", specWithRequiredBody()]], []);
    const result = await validateCommand(
      {
        spec: "-",
        overlays: [],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "-" },
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(3);
    expect(stderr.value).toContain("only one of them can read it");
  });

  it("allows a spec on stdin alongside a payload from a file", async () => {
    const { io } = memoryIo([["-", specWithRequiredBody()]], [["body.json", '{"name":"a"}']]);
    const result = await validateCommand(
      {
        spec: "-",
        overlays: [],
        mode: { kind: "bodyForPath", method: "POST", path: "/pets", body: "body.json" },
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(0);
  });

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

describe("compile-schema input guards", () => {
  it("refuses an OpenAPI document with a pointer at compile-spec", async () => {
    // Fed a spec, every top-level key is an unknown JSON Schema keyword,
    // so the emitted validate() would accept everything, silently.
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
    });
    const mem = memoryIo([], [["spec.json", doc]]);
    const res = await compileSchemaCommand({ schema: "spec.json" }, mem.io);
    expect(res.exitCode).toBe(2);
    expect(mem.stderr.value).toContain("Use compile-spec");
    expect(mem.stderr.value).toContain('"openapi" field');
  });

  it("refuses an unknown format by default, naming the escape hatch", async () => {
    const schema = JSON.stringify({ type: "string", format: "iban" });
    const mem = memoryIo([], [["s.json", schema]]);
    const res = await compileSchemaCommand({ schema: "s.json" }, mem.io);
    expect(res.exitCode).toBe(3);
    expect(mem.stderr.value).toContain('"iban"');
    expect(mem.stderr.value).toContain("--unknown-formats ignore");
  });
});

describe("the default gate (#549)", () => {
  // A conformance violation: error severity out of the box.
  const violating = {
    openapi: "3.1.0",
    info: { title: "X", version: "1.0.0" },
    paths: { "/t": { get: { responses: { "202": { description: null } } } } },
  };
  // Hygiene-warning-only: an unused tag.
  const warningsOnly = {
    openapi: "3.1.0",
    info: { title: "X", version: "1.0.0" },
    tags: [{ name: "unused" }],
    paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
  };

  it("--fail-on none restores the advisory exit 0", async () => {
    const { io } = memoryIo([["spec.json", violating]]);
    const result = await checkCommand(
      { spec: "spec.json", overlays: [], failOn: "none", options: textOpts },
      io,
    );
    expect(result.exitCode).toBe(0);
  });

  it("warnings alone do not trip the default gate", async () => {
    const { io, stdout } = memoryIo([["spec.json", warningsOnly]]);
    const result = await checkCommand({ spec: "spec.json", overlays: [], options: textOpts }, io);
    expect(stdout.value).toContain("unused-tag");
    expect(result.exitCode).toBe(0);
  });

  it("a --severity promotion moves the exit code under the default", async () => {
    // The interaction the migration note calls out: regrading is
    // gate-affecting by default now.
    const { io } = memoryIo([["spec.json", warningsOnly]]);
    const result = await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        severity: ["unused-tag=error"],
        options: textOpts,
      },
      io,
    );
    expect(result.exitCode).toBe(1);
  });
});
