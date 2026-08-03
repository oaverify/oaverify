import { describe, expect, it } from "vitest";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { loadSpec, loadSpecSync } from "../src/load.js";
import type { SpecOverlay } from "../src/overlay.js";
import { sourceOf, type SpecRegion } from "../src/provenance.js";

/**
 * What survives an overlay pass. Overlays run after resolution, so a
 * node they touched no longer says what its source file says and a node
 * they added was never in one; both have to come back absent.
 */

const docs: Record<string, unknown> = {
  "entry.json": {
    openapi: "3.1.0",
    info: { title: "X", version: "1" },
    tags: [{ name: "one" }, { name: "two" }],
    "x-keep": "removed by one of the overlays below",
    paths: { "/a": { $ref: "./path.json" }, "/gone": { get: { responses: {} } } },
  },
  "path.json": {
    get: {
      operationId: "listA",
      summary: "as written in path.json",
      responses: { "200": { description: "ok" } },
    },
  },
};

function readers(): { reader: DocumentReader; syncReader: SyncDocumentReader } {
  const get = (uri: string): unknown => {
    if (!Object.hasOwn(docs, uri)) throw new Error(`no entry for ${uri}`);
    return structuredClone(docs[uri]);
  };
  return {
    reader: { canRead: (uri) => Object.hasOwn(docs, uri), read: async (uri) => get(uri) },
    syncReader: { canRead: (uri) => Object.hasOwn(docs, uri), read: get },
  };
}

/** Load through both loaders, assert they agree, and hand back regions. */
async function regionsWith(overlays: readonly SpecOverlay[]): Promise<readonly SpecRegion[]> {
  const async = await loadSpec({
    reader: readers().reader,
    entry: "entry.json",
    overlays,
    provenance: true,
  });
  const sync = loadSpecSync({
    reader: readers().syncReader,
    entry: "entry.json",
    overlays,
    provenance: true,
  });
  expect(sync.regions).toEqual(async.regions);
  return async.regions as readonly SpecRegion[];
}

describe("loadSpec provenance", () => {
  it("passes regions through when there are no overlays", async () => {
    const regions = await regionsWith([]);
    expect(sourceOf(regions, "/paths/~1a/get/operationId")).toEqual({
      uri: "path.json",
      pointer: "/get/operationId",
      via: [{ uri: "entry.json", pointer: "/paths/~1a" }],
    });
  });

  it("is off by default", async () => {
    const loaded = await loadSpec({ reader: readers().reader, entry: "entry.json" });
    expect(loaded.regions).toBeUndefined();
    expect(
      loadSpecSync({ reader: readers().syncReader, entry: "entry.json" }).regions,
    ).toBeUndefined();
  });

  it("drops the address of a value an overlay rewrote", async () => {
    const regions = await regionsWith([
      {
        overrides: {
          "/a": {
            operations: {
              get: { patchResponses: { "200": { description: "rewritten by the overlay" } } },
            },
          },
        },
      },
    ]);
    expect(sourceOf(regions, "/paths/~1a/get/responses/200/description")).toBeUndefined();
    // Its neighbours in the same file are untouched and still addressed.
    expect(sourceOf(regions, "/paths/~1a/get/operationId")?.uri).toBe("path.json");
  });

  it("gives an added node no address", async () => {
    const regions = await regionsWith([
      { overrides: { "/a": { operations: { get: { addTags: ["added"] } } } } },
    ]);
    expect(sourceOf(regions, "/paths/~1a/get/tags")).toBeUndefined();
    expect(sourceOf(regions, "/paths/~1a/get/summary")?.uri).toBe("path.json");
  });

  it("marks an array whole when its length changed, because indices shift", async () => {
    const regions = await regionsWith([
      { tags: [{ name: "two" }, { name: "three" }, { name: "four" }] },
    ]);
    expect(sourceOf(regions, "/tags")).toBeUndefined();
    expect(sourceOf(regions, "/tags/0/name")).toBeUndefined();
    expect(sourceOf(regions, "/info/title")?.uri).toBe("entry.json");
  });

  it("stays element-wise when an array kept its length", async () => {
    // Indices still line up, so only what changed loses its address.
    const regions = await regionsWith([{ tags: [{ name: "one" }, { name: "changed" }] }]);
    expect(sourceOf(regions, "/tags/0/name")).toEqual({
      uri: "entry.json",
      pointer: "/tags/0/name",
      via: [],
    });
    expect(sourceOf(regions, "/tags/1/name")).toBeUndefined();
  });

  it("suppresses a mount underneath a subtree the overlay replaced", async () => {
    // `/paths/~1a` is mounted from path.json. Replacing the operation
    // wholesale has to invalidate what is under it, which longest-prefix
    // alone would not do.
    const regions = await regionsWith([
      {
        overrides: {
          "/a": {
            operations: {
              get: {
                replace: {
                  operationId: "replaced",
                  responses: { "200": { description: "replaced" } },
                },
              },
            },
          },
        },
      },
    ]);
    expect(sourceOf(regions, "/paths/~1a/get/operationId")).toBeUndefined();
    expect(sourceOf(regions, "/paths/~1a/get/responses/200/description")).toBeUndefined();
  });

  it("gives an added root extension no address", async () => {
    const regions = await regionsWith([{ setExtensions: { "x-added": 1 } }]);
    expect(sourceOf(regions, "/x-added")).toBeUndefined();
    expect(sourceOf(regions, "/paths/~1a/get/operationId")?.uri).toBe("path.json");
  });

  describe("removals", () => {
    // A removed node has no address in the graded document, so there is
    // nothing to mark. What has to stay true is that every node that
    // survives still addresses the right place: a removal must not
    // shift what is left, or an address would become wrong rather than
    // missing, which is the failure this design exists to prevent.

    it("keeps the surviving paths addressed when one is removed", async () => {
      const regions = await regionsWith([{ removePaths: ["/gone"] }]);
      expect(sourceOf(regions, "/paths/~1a/get/operationId")).toEqual({
        uri: "path.json",
        pointer: "/get/operationId",
        via: [{ uri: "entry.json", pointer: "/paths/~1a" }],
      });
      // The removed path resolves to nothing in the graded document, so
      // no finding can carry this pointer in the first place.
      expect(sourceOf(regions, "/paths/~1gone")?.pointer).toBe("/paths/~1gone");
    });

    it("marks the tags array when one is removed, because indices shift", async () => {
      const regions = await regionsWith([{ removeTags: ["one"] }]);
      expect(sourceOf(regions, "/tags")).toBeUndefined();
      expect(sourceOf(regions, "/tags/0/name")).toBeUndefined();
    });

    it("keeps the rest of the document addressed when an extension is removed", async () => {
      const regions = await regionsWith([{ setExtensions: { "x-keep": undefined } }]);
      expect(sourceOf(regions, "/info/title")?.uri).toBe("entry.json");
      expect(sourceOf(regions, "/paths/~1a/get/operationId")?.uri).toBe("path.json");
    });
  });
});
