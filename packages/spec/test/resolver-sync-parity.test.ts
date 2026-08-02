import { describe, expect, it } from "vitest";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { loadSpec, loadSpecSync } from "../src/load.js";
import type { SpecOverlay } from "../src/overlay.js";

// Parity suite: resolveSpecSync is a hand-mirrored copy of resolveSpec's
// read-interleaving walk (the async path is the production-critical edge
// surface and isn't rewritten to serve the sync loader). These tests are
// what make two copies safe: for every fixture they assert the sync and
// async paths (a) produce identical output + source list, (b) read
// documents in the identical order, and (c) throw equivalently with the
// identical read order up to the throw. A change to one walk that isn't
// mirrored in the other breaks this suite.

interface Recorders {
  asyncReader: DocumentReader;
  syncReader: SyncDocumentReader;
  asyncReads: string[];
  syncReads: string[];
}

/**
 * Build an async + a sync reader over the same source map, each
 * recording its ordered `read(uri)` calls. Documents are deep-cloned
 * per read so the two runs never share mutable state and a missing URI
 * throws the same message on both sides.
 */
function recorders(sources: Map<string, unknown>): Recorders {
  const asyncReads: string[] = [];
  const syncReads: string[] = [];
  const get = (uri: string): unknown => {
    if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
    return structuredClone(sources.get(uri));
  };
  return {
    asyncReads,
    syncReads,
    asyncReader: {
      canRead: (uri) => sources.has(uri),
      read: async (uri) => {
        asyncReads.push(uri);
        return get(uri);
      },
    },
    syncReader: {
      canRead: (uri) => sources.has(uri),
      read: (uri) => {
        syncReads.push(uri);
        return get(uri);
      },
    },
  };
}

const map = (entries: [string, unknown][]): Map<string, unknown> => new Map(entries);

// Fixtures exercise every resolver branch: no-ref, plain inlining,
// two-way and three-way cycles, the non-circular-vs-circular split,
// pre-existing $defs, and the #38 internal-ref-rewriting cases.
const fixtures: { name: string; entry: string; sources: Map<string, unknown> }[] = [
  {
    name: "no external refs",
    entry: "main.json",
    sources: map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
        },
      ],
    ]),
  },
  {
    name: "plain multi-file inlining",
    entry: "main.json",
    sources: map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/p": { get: { responses: { "200": { $ref: "responses.json#/Ok" } } } } },
        },
      ],
      [
        "responses.json",
        {
          Ok: {
            description: "ok",
            content: { "application/json": { schema: { $ref: "schemas/pet.json" } } },
          },
        },
      ],
      ["schemas/pet.json", { type: "object", properties: { name: { type: "string" } } }],
    ]),
  },
  {
    name: "two-way cycle",
    entry: "a.json",
    sources: map([
      [
        "a.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          components: { schemas: { A: { $ref: "b.json#/B" } } },
        },
      ],
      ["b.json", { B: { $ref: "a.json#/components/schemas/A" } }],
    ]),
  },
  {
    name: "three-way cycle",
    entry: "a.json",
    sources: map([
      [
        "a.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          components: { schemas: { A: { $ref: "b.json#/B" } } },
        },
      ],
      ["b.json", { B: { $ref: "c.json#/C" } }],
      ["c.json", { C: { $ref: "a.json#/components/schemas/A" } }],
    ]),
  },
  {
    name: "non-circular inlined, circular stitched",
    entry: "main.json",
    sources: map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          components: {
            schemas: { Plain: { $ref: "plain.json" }, Loop: { $ref: "loop.json#/Node" } },
          },
        },
      ],
      ["plain.json", { type: "object", properties: { n: { type: "integer" } } }],
      [
        "loop.json",
        { Node: { type: "object", properties: { next: { $ref: "loop.json#/Node" } } } },
      ],
    ]),
  },
  {
    name: "pre-existing $defs merge",
    entry: "a.json",
    sources: map([
      [
        "a.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          $defs: { Existing: { type: "string" } },
          components: { schemas: { A: { $ref: "b.json#/B" } } },
        },
      ],
      ["b.json", { B: { $ref: "a.json#/components/schemas/A" } }],
    ]),
  },
  {
    name: "internal refs inside inlined external subtree (#38)",
    entry: "root.json",
    sources: map([
      [
        "root.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/things": {
              post: {
                requestBody: { $ref: "ext.json#/components/requestBodies/CreateThing" },
                responses: { "201": { description: "ok" } },
              },
            },
          },
        },
      ],
      [
        "ext.json",
        {
          components: {
            requestBodies: {
              CreateThing: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
              },
            },
            schemas: {
              Thing: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
            },
          },
        },
      ],
    ]),
  },
  {
    name: "nested external refs with local siblings",
    entry: "root.json",
    sources: map([
      [
        "root.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/x": {
              post: {
                requestBody: { $ref: "ext1.json#/components/requestBodies/A" },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      ],
      [
        "ext1.json",
        {
          components: {
            requestBodies: {
              A: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/InExt1" } },
                },
              },
            },
            schemas: {
              InExt1: {
                type: "object",
                properties: { nested: { $ref: "ext2.json#/components/schemas/Leaf" } },
              },
            },
          },
        },
      ],
      [
        "ext2.json",
        {
          components: {
            schemas: {
              Leaf: {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  self: { $ref: "#/components/schemas/SelfInExt2" },
                },
              },
              SelfInExt2: { type: "string" },
            },
          },
        },
      ],
    ]),
  },
  {
    // Positions OpenAPI does not type as `X | Reference` hold author
    // data. Both walks must decline all of these identically, and the
    // read order proves it: only the entry document is ever read.
    name: "refs at illegal positions are left alone",
    entry: "main.json",
    sources: map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1", description: { $ref: "info.md" } },
          tags: [{ name: "T", description: { $ref: "flow.mdx" } }],
          "x-vendor": { $ref: "vendor.json" },
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
                        example: { $ref: "payload.json" },
                      },
                    },
                  },
                },
              },
            },
          },
          components: { examples: { E: { value: { $ref: "value.json" } } } },
        },
      ],
    ]),
  },
];

describe("resolveSpecSync ⇔ resolveSpec parity", () => {
  for (const fx of fixtures) {
    it(`${fx.name}: identical output, sources, and read order`, async () => {
      const r = recorders(fx.sources);
      const asyncResult = await resolveSpec({ reader: r.asyncReader, entry: fx.entry });
      const syncResult = resolveSpecSync({ reader: r.syncReader, entry: fx.entry });

      expect(syncResult.document).toEqual(asyncResult.document);
      expect(syncResult.sources).toEqual(asyncResult.sources);
      // The drift surface deep-equal can't see: read set and read order.
      expect(r.syncReads).toEqual(r.asyncReads);
    });

    it(`${fx.name}: identical regions and read order with provenance`, async () => {
      const r = recorders(fx.sources);
      const asyncResult = await resolveSpec({
        reader: r.asyncReader,
        entry: fx.entry,
        provenance: true,
      });
      const syncResult = resolveSpecSync({
        reader: r.syncReader,
        entry: fx.entry,
        provenance: true,
      });
      // Regions are emitted in walk order, so this pins the order of the
      // walk itself and not only what it produced.
      expect(syncResult.regions).toEqual(asyncResult.regions);
      expect(syncResult.document).toEqual(asyncResult.document);
      expect(r.syncReads).toEqual(r.asyncReads);
    });

    it(`${fx.name}: recording provenance changes neither output nor read order`, async () => {
      const plain = recorders(fx.sources);
      const tracked = recorders(fx.sources);
      const off = await resolveSpec({ reader: plain.asyncReader, entry: fx.entry });
      const on = await resolveSpec({
        reader: tracked.asyncReader,
        entry: fx.entry,
        provenance: true,
      });
      expect(on.document).toEqual(off.document);
      expect(on.sources).toEqual(off.sources);
      expect(tracked.asyncReads).toEqual(plain.asyncReads);
    });

    it(`${fx.name}: identical output and read order with lint`, async () => {
      const r = recorders(fx.sources);
      const asyncResult = await resolveSpec({ reader: r.asyncReader, entry: fx.entry, lint: true });
      const syncResult = resolveSpecSync({ reader: r.syncReader, entry: fx.entry, lint: true });
      expect(syncResult.document).toEqual(asyncResult.document);
      expect(syncResult.specHygieneIssues).toEqual(asyncResult.specHygieneIssues);
      expect(r.syncReads).toEqual(r.asyncReads);
    });
  }

  it("throws equivalently, with identical read order up to the throw", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/p": { get: { responses: { "200": { $ref: "missing.json#/Ok" } } } } },
        },
      ],
    ]);
    const r = recorders(sources);

    let asyncErr: unknown;
    let syncErr: unknown;
    await resolveSpec({ reader: r.asyncReader, entry: "main.json" }).catch((e) => {
      asyncErr = e;
    });
    try {
      resolveSpecSync({ reader: r.syncReader, entry: "main.json" });
    } catch (e) {
      syncErr = e;
    }

    expect(asyncErr).toBeInstanceOf(Error);
    expect(syncErr).toBeInstanceOf(Error);
    expect((syncErr as Error).message).toBe((asyncErr as Error).message);
    expect(r.syncReads).toEqual(r.asyncReads);
  });
});

describe("loadSpecSync ⇔ loadSpec parity", () => {
  const baseSources = (): Map<string, unknown> =>
    map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "Base", version: "1" },
          paths: { "/p": { get: { responses: { "200": { $ref: "responses.json#/Ok" } } } } },
        },
      ],
      ["responses.json", { Ok: { description: "ok" } }],
    ]);

  it("applies overlays identically (deferred lint, same result shape)", async () => {
    const overlays: SpecOverlay[] = [{ info: { title: "Overlaid" } }];
    const r = recorders(baseSources());
    const asyncResult = await loadSpec({ reader: r.asyncReader, entry: "main.json", overlays });
    const syncResult = loadSpecSync({ reader: r.syncReader, entry: "main.json", overlays });

    expect(syncResult.document).toEqual(asyncResult.document);
    expect(syncResult.document.info.title).toBe("Overlaid");
    expect(syncResult.sources).toEqual(asyncResult.sources);
    expect(r.syncReads).toEqual(r.asyncReads);
  });

  it("produces identical hygiene findings with lint", async () => {
    const r = recorders(baseSources());
    const asyncResult = await loadSpec({ reader: r.asyncReader, entry: "main.json", lint: true });
    const syncResult = loadSpecSync({ reader: r.syncReader, entry: "main.json", lint: true });
    expect(syncResult.specHygieneIssues).toEqual(asyncResult.specHygieneIssues);
    expect(syncResult.document).toEqual(asyncResult.document);
  });
});
