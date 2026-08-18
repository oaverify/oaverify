import { describe, expect, it } from "vitest";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { loadSpec } from "../src/load.js";

// `onUnresolved: "record"`: a reference whose target will not read
// leaves a hole instead of ending the resolution. These tests pin what
// each hole looks like in the document, because the shape is what
// decides whether the existing check passes report it: a schema
// position leaves a dangling internal reference the compiler already
// reports with a pointer, and a non-schema position leaves the `$ref`
// as the author wrote it.

interface Readers {
  async: DocumentReader;
  sync: SyncDocumentReader;
  reads: string[];
}

/**
 * A reader over a source map that records its reads. A URI mapped to an
 * `Error` throws it, which is how an unreadable and an unparseable file
 * are both expressed here.
 */
function readers(sources: Map<string, unknown>): Readers {
  const reads: string[] = [];
  const get = (uri: string): unknown => {
    reads.push(uri);
    if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
    const value = sources.get(uri);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  return {
    reads,
    async: { canRead: (uri) => sources.has(uri), read: async (uri) => get(uri) },
    sync: { canRead: (uri) => sources.has(uri), read: (uri) => get(uri) },
  };
}

const map = (entries: [string, unknown][]): Map<string, unknown> => new Map(entries);

const info = { title: "X", version: "1" };
const okResponse = { description: "ok" };

/** A one-operation document whose 200 response body is `schema`. */
function withBodySchema(schema: unknown): unknown {
  return {
    openapi: "3.1.0",
    info,
    paths: {
      "/p": {
        get: {
          responses: {
            "200": { ...okResponse, content: { "application/json": { schema } } },
          },
        },
      },
    },
  };
}

describe("resolveSpec with onUnresolved: record", () => {
  it("leaves a schema-position hole as a dangling internal ref and records it", async () => {
    const sources = map([["main.json", withBodySchema({ $ref: "missing.json#/Order" })]]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      provenance: true,
      onUnresolved: "record",
    });

    const doc = result.document as unknown as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }>;
          };
        }
      >;
      components?: { schemas?: Record<string, unknown> };
    };
    const schema = doc.paths["/p"]!.get.responses["200"]!.content["application/json"]!.schema;

    // The use site was rewritten before the target was read, so what is
    // left is a reference to a component that is not there.
    expect(schema.$ref.startsWith("#/components/schemas/")).toBe(true);
    const name = schema.$ref.slice("#/components/schemas/".length);
    expect(doc.components?.schemas?.[name]).toBeUndefined();

    expect(result.unresolved).toHaveLength(1);
    const hole = result.unresolved![0]!;
    expect(hole.uri).toBe("missing.json");
    expect(hole.referrer).toBe("main.json");
    expect(hole.message).toContain("failed to read missing.json");
    // Located: the last hop addresses the `$ref` node in the file that
    // holds it, which is what a span resolver takes.
    expect(hole.via.at(-1)).toEqual({
      uri: "main.json",
      pointer: "/paths/~1p/get/responses/200/content/application~1json/schema",
    });
  });

  it("leaves a non-schema-position hole as the reference the author wrote", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: { "/p": { get: { responses: { "200": { $ref: "missing.json#/Ok" } } } } },
        },
      ],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      provenance: true,
      onUnresolved: "record",
    });

    const response = (
      result.document as unknown as {
        paths: Record<string, { get: { responses: Record<string, unknown> } }>;
      }
    ).paths["/p"]!.get.responses["200"];
    expect(response).toEqual({ $ref: "missing.json#/Ok" });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved![0]!.via.at(-1)).toEqual({
      uri: "main.json",
      pointer: "/paths/~1p/get/responses/200",
    });
  });

  it("keeps siblings of an unfollowed reference, which belong to this document", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": { $ref: "missing.json#/Ok", description: "written here" },
                },
              },
            },
          },
        },
      ],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    const response = (
      result.document as unknown as {
        paths: Record<string, { get: { responses: Record<string, unknown> } }>;
      }
    ).paths["/p"]!.get.responses["200"];
    expect(response).toEqual({ $ref: "missing.json#/Ok", description: "written here" });
  });

  it("resolves everything the hole does not cover", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/gone": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "missing.json#/Order" } } },
                  },
                },
              },
            },
            "/here": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "there.json#/Item" } } },
                  },
                },
              },
            },
          },
        },
      ],
      ["there.json", { Item: { type: "string" } }],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });

    const schemas = (
      result.document as unknown as {
        components: { schemas: Record<string, unknown> };
      }
    ).components.schemas;
    // The readable target is hoisted as usual; only the unreadable one
    // is missing.
    expect(Object.values(schemas)).toContainEqual({ type: "string" });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved![0]!.uri).toBe("missing.json");
  });

  it("reads a missing target once however many references name it", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/a": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "missing.json#/A" } } },
                  },
                },
              },
            },
            "/b": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "missing.json#/B" } } },
                  },
                },
              },
            },
          },
        },
      ],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });

    expect(result.unresolved).toHaveLength(1);
    expect(r.reads.filter((uri) => uri === "missing.json")).toHaveLength(1);
  });

  it("records each missing target separately", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/a": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "one.json#/A" } } },
                  },
                },
              },
            },
            "/b": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "two.json#/B" } } },
                  },
                },
              },
            },
          },
        },
      ],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    expect(result.unresolved?.map((u) => u.uri)).toEqual(["one.json", "two.json"]);
  });

  it("records a file that reads but does not parse, keeping the reader's error", async () => {
    const parseError = new SyntaxError("Unexpected token } in JSON at position 12");
    const sources = map([
      ["main.json", withBodySchema({ $ref: "broken.json#/Order" })],
      ["broken.json", parseError],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    expect(result.unresolved).toHaveLength(1);
    // The reader's own error, not a string of it: a caller that knows
    // what its reader throws can read a position back off this.
    expect(result.unresolved![0]!.cause).toBe(parseError);
    expect(result.unresolved![0]!.message).toContain("Unexpected token");
  });

  it("names the referring file even without provenance, and leaves via empty", async () => {
    const sources = map([["main.json", withBodySchema({ $ref: "missing.json#/Order" })]]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    expect(result.unresolved![0]!.referrer).toBe("main.json");
    expect(result.unresolved![0]!.via).toEqual([]);
  });

  it("still throws on an unreadable entry, which leaves no document at all", async () => {
    const r = readers(map([]));
    await expect(
      resolveSpec({ reader: r.async, entry: "main.json", onUnresolved: "record" }),
    ).rejects.toThrow(/failed to read main\.json/);
  });

  it("distinguishes not asked from asked and complete", async () => {
    const sources = map([["main.json", withBodySchema({ type: "string" })]]);
    const notAsked = await resolveSpec({ reader: readers(sources).async, entry: "main.json" });
    expect(notAsked.unresolved).toBeUndefined();
    const asked = await resolveSpec({
      reader: readers(sources).async,
      entry: "main.json",
      onUnresolved: "record",
    });
    expect(asked.unresolved).toEqual([]);
  });

  it("throws by default, unchanged", async () => {
    const sources = map([["main.json", withBodySchema({ $ref: "missing.json#/Order" })]]);
    const r = readers(sources);
    await expect(resolveSpec({ reader: r.async, entry: "main.json" })).rejects.toThrow(
      /failed to read missing\.json \(referenced from main\.json\)/,
    );
  });

  it("removes a component slot the author bound to a target that will not read", async () => {
    // `components.schemas.Order` is nothing but an external `$ref`, so
    // the walk binds the hoist to that slot and rewrites the slot to
    // point at the name it is about to fill. With the target missing,
    // leaving the slot behind leaves it pointing at itself, which
    // compiles and grades clean.
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: {
                      "application/json": { schema: { $ref: "#/components/schemas/Order" } },
                    },
                  },
                },
              },
            },
          },
          components: { schemas: { Order: { $ref: "missing.json" } } },
        },
      ],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    const schemas = (
      result.document as unknown as {
        components?: { schemas?: Record<string, unknown> };
      }
    ).components?.schemas;
    expect(schemas?.Order).toBeUndefined();
    expect(result.unresolved).toHaveLength(1);
  });

  it("writes an unfollowed reference as the target it derived, not as it was spelled", async () => {
    // The reference is authored in `sub/a.json`, so `gone.json` beside
    // it is `sub/gone.json`. Keeping the spelling would land a
    // reference to `sub/gone.json` in a document whose base is the
    // entry, where it names a different file that happens to exist.
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: { "/p": { get: { responses: { "200": { $ref: "sub/a.json#/Ok" } } } } },
        },
      ],
      ["sub/a.json", { Ok: { description: "d", headers: { H: { $ref: "gone.json#/H" } } } }],
      ["gone.json", { H: { schema: { type: "string" } } }],
    ]);
    const r = readers(sources);
    const result = await resolveSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
    });
    const headers = (
      result.document as unknown as {
        paths: Record<
          string,
          { get: { responses: Record<string, { headers: Record<string, unknown> }> } }
        >;
      }
    ).paths["/p"]!.get.responses["200"]!.headers;
    expect(headers.H).toEqual({ $ref: "sub/gone.json#/H" });
    // The document and the record name the same file.
    expect(result.unresolved![0]!.uri).toBe("sub/gone.json");
  });

  it("carries the record through loadSpec, overlays included", async () => {
    const sources = map([["main.json", withBodySchema({ $ref: "missing.json#/Order" })]]);
    const r = readers(sources);
    const result = await loadSpec({
      reader: r.async,
      entry: "main.json",
      onUnresolved: "record",
      overlays: [{ info: { title: "overlaid" } }],
    });
    expect((result.document as unknown as { info: { title: string } }).info.title).toBe("overlaid");
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("resolveSpecSync parity under onUnresolved: record", () => {
  const cases: Array<[string, Map<string, unknown>]> = [
    ["schema position", map([["main.json", withBodySchema({ $ref: "missing.json#/Order" })]])],
    [
      "non-schema position",
      map([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info,
            paths: { "/p": { get: { responses: { "200": { $ref: "missing.json#/Ok" } } } } },
          },
        ],
      ]),
    ],
    [
      "path item position",
      map([
        ["main.json", { openapi: "3.1.0", info, paths: { "/p": { $ref: "missing.json#/p" } } }],
      ]),
    ],
    [
      "one missing among several readable",
      map([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info,
            paths: {
              "/a": {
                get: {
                  responses: {
                    "200": {
                      ...okResponse,
                      content: { "application/json": { schema: { $ref: "there.json#/Item" } } },
                    },
                  },
                },
              },
              "/b": {
                get: {
                  responses: {
                    "200": {
                      ...okResponse,
                      content: { "application/json": { schema: { $ref: "missing.json#/Order" } } },
                    },
                  },
                },
              },
            },
          },
        ],
        ["there.json", { Item: { type: "string" } }],
      ]),
    ],
  ];

  for (const [name, sources] of cases) {
    it(`${name}: identical document, record, and read order`, async () => {
      const a = readers(sources);
      const s = readers(sources);
      const asyncResult = await resolveSpec({
        reader: a.async,
        entry: "main.json",
        provenance: true,
        onUnresolved: "record",
      });
      const syncResult = resolveSpecSync({
        reader: s.sync,
        entry: "main.json",
        provenance: true,
        onUnresolved: "record",
      });
      expect(syncResult.document).toEqual(asyncResult.document);
      expect(syncResult.unresolved).toEqual(asyncResult.unresolved);
      expect(syncResult.regions).toEqual(asyncResult.regions);
      expect(s.reads).toEqual(a.reads);
    });
  }
});
