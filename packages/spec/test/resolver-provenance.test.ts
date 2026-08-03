import { describe, expect, it } from "vitest";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { sourceOf, type SpecRegion } from "../src/provenance.js";

/**
 * What `resolveSpec` records about where the resolved document came
 * from, case by case. The pure lookup rules are pinned in
 * `provenance.test.ts`; these tests pin what the walk emits, which is
 * the half that can silently drift as the resolver changes.
 *
 * Every case runs through both resolvers, because the sync mirror is
 * hand-written and the parity suite only compares documents.
 */

/** Async + sync readers over the same fixture, cloning per read. */
function readers(docs: Record<string, unknown>): {
  reader: DocumentReader;
  syncReader: SyncDocumentReader;
} {
  const get = (uri: string): unknown => {
    if (!Object.hasOwn(docs, uri)) throw new Error(`no entry for ${uri}`);
    return structuredClone(docs[uri]);
  };
  return {
    reader: { canRead: (uri) => Object.hasOwn(docs, uri), read: async (uri) => get(uri) },
    syncReader: { canRead: (uri) => Object.hasOwn(docs, uri), read: get },
  };
}

function both(docs: Record<string, unknown>, entry: string): readonly SpecRegion[] {
  const { syncReader } = readers(docs);
  const sync = resolveSpecSync({ reader: syncReader, entry, provenance: true });
  return sync.regions as readonly SpecRegion[];
}

async function asyncRegions(
  docs: Record<string, unknown>,
  entry: string,
): Promise<readonly SpecRegion[]> {
  const { regions } = await resolveSpec({ reader: readers(docs).reader, entry, provenance: true });
  return regions as readonly SpecRegion[];
}

/** Run a case through both resolvers and assert they agree exactly. */
async function regionsOf(
  docs: Record<string, unknown>,
  entry: string,
): Promise<readonly SpecRegion[]> {
  const async = await asyncRegions(docs, entry);
  expect(both(docs, entry)).toEqual(async);
  return async;
}

const openapi = { openapi: "3.1.0", info: { title: "X", version: "1" } };
const ok = { responses: { "200": { description: "ok" } } };

describe("provenance is off unless asked for", () => {
  const docs = { "entry.json": { ...openapi, paths: {} } };

  it("records nothing by default", async () => {
    const resolved = await resolveSpec({ reader: readers(docs).reader, entry: "entry.json" });
    expect(resolved.regions).toBeUndefined();
    expect(
      resolveSpecSync({ reader: readers(docs).syncReader, entry: "entry.json" }).regions,
    ).toBeUndefined();
  });

  it("leaves the resolved document byte-identical when asked for", async () => {
    const off = await resolveSpec({ reader: readers(docs).reader, entry: "entry.json" });
    const on = await resolveSpec({
      reader: readers(docs).reader,
      entry: "entry.json",
      provenance: true,
    });
    expect(on.document).toEqual(off.document);
    expect(on.sources).toEqual(off.sources);
  });
});

describe("single-file specs", () => {
  it("mount the entry document at the root and answer for every node", async () => {
    const regions = await regionsOf(
      { "entry.json": { ...openapi, paths: { "/a": { get: ok } } } },
      "entry.json",
    );
    expect(regions).toEqual([{ kind: "mounted", at: "", uri: "entry.json", pointer: "", via: [] }]);
    expect(sourceOf(regions, "/paths/~1a/get/responses/200/description")).toEqual({
      uri: "entry.json",
      pointer: "/paths/~1a/get/responses/200/description",
      via: [],
    });
  });
});

describe("hoisted schema targets", () => {
  const docs = {
    "entry.json": {
      ...openapi,
      paths: {
        "/a": {
          post: {
            ...ok,
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "./order.json#/components/schemas/Order" } },
              },
            },
          },
        },
      },
    },
    "order.json": {
      components: {
        schemas: { Order: { type: "object", required: ["id", "nope"] } },
      },
    },
  };

  it("mount the target where it lands, addressed where it was written", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(sourceOf(regions, "/components/schemas/Order/required/1")).toEqual({
      uri: "order.json",
      pointer: "/components/schemas/Order/required/1",
      via: [
        {
          uri: "entry.json",
          pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        },
      ],
    });
  });

  it("keep the referring document's `$ref` node attributed to the referrer", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(
      sourceOf(regions, "/paths/~1a/post/requestBody/content/application~1json/schema/$ref"),
    ).toEqual({
      uri: "entry.json",
      pointer: "/paths/~1a/post/requestBody/content/application~1json/schema/$ref",
      via: [],
    });
  });

  it("mark the components container the resolver invented, and not what it holds", async () => {
    const regions = await regionsOf(docs, "entry.json");
    // The entry document declares no `components`, so the container is
    // the resolver's; the hoisted schema inside it is not.
    expect(regions).toContainEqual({ kind: "synthetic", at: "/components" });
    expect(sourceOf(regions, "/components")).toBeUndefined();
    expect(sourceOf(regions, "/components/schemas")).toBeUndefined();
    expect(sourceOf(regions, "/components/schemas/Order")?.uri).toBe("order.json");
  });

  it("leave an author-written components container alone", async () => {
    const withComponents = structuredClone(docs) as Record<string, Record<string, unknown>>;
    const entryDoc = withComponents["entry.json"] as Record<string, unknown>;
    entryDoc["components"] = { schemas: { Mine: { type: "string" } } };
    const regions = await regionsOf(withComponents, "entry.json");
    expect(regions.filter((r) => r.kind === "synthetic")).toEqual([]);
    expect(sourceOf(regions, "/components/schemas/Mine/type")).toEqual({
      uri: "entry.json",
      pointer: "/components/schemas/Mine/type",
      via: [],
    });
  });

  it("mark only the schemas map when the author wrote components without it", async () => {
    const withComponents = structuredClone(docs) as Record<string, Record<string, unknown>>;
    const entryDoc = withComponents["entry.json"] as Record<string, unknown>;
    entryDoc["components"] = { responses: {} };
    const regions = await regionsOf(withComponents, "entry.json");
    expect(regions).toContainEqual({ kind: "synthetic", at: "/components/schemas" });
    expect(sourceOf(regions, "/components/responses")?.uri).toBe("entry.json");
  });

  it("relocate under a derived name without claiming the name is the author's", async () => {
    // Fragment-less external target: the component name comes from the
    // file's basename, and the source pointer is the document root.
    const regions = await regionsOf(
      {
        "entry.json": {
          ...openapi,
          paths: {
            "/a": {
              post: {
                ...ok,
                requestBody: {
                  content: { "application/json": { schema: { $ref: "./pet.json" } } },
                },
              },
            },
          },
        },
        "pet.json": { type: "object", properties: { name: { type: "string" } } },
      },
      "entry.json",
    );
    expect(sourceOf(regions, "/components/schemas/pet/properties/name/type")).toEqual({
      uri: "pet.json",
      pointer: "/properties/name/type",
      via: [
        {
          uri: "entry.json",
          pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        },
      ],
    });
  });

  it("give a target reached from two operations one mount and the first chain", async () => {
    const shared = {
      ...openapi,
      paths: {
        "/a": {
          post: {
            ...ok,
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "./order.json#/components/schemas/Order" } },
              },
            },
          },
        },
        "/b": {
          post: {
            ...ok,
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "./order.json#/components/schemas/Order" } },
              },
            },
          },
        },
      },
    };
    const regions = await regionsOf({ ...docs, "entry.json": shared }, "entry.json");
    const mounts = regions.filter((r) => r.kind === "mounted" && r.uri === "order.json");
    expect(mounts).toHaveLength(1);
    // `via` is how the resolver first reached the document, not the
    // route either operation took to the finding.
    expect(sourceOf(regions, "/components/schemas/Order")?.via).toEqual([
      {
        uri: "entry.json",
        pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
      },
    ]);
  });

  it("grow the chain through a nested external reference", async () => {
    const regions = await regionsOf(
      {
        "entry.json": {
          ...openapi,
          paths: {
            "/a": {
              post: {
                ...ok,
                requestBody: {
                  content: { "application/json": { schema: { $ref: "./order.json" } } },
                },
              },
            },
          },
        },
        "order.json": { type: "object", properties: { line: { $ref: "./line.json" } } },
        "line.json": { type: "object", properties: { sku: { type: "string" } } },
      },
      "entry.json",
    );
    expect(sourceOf(regions, "/components/schemas/line/properties/sku")?.via).toEqual([
      {
        uri: "entry.json",
        pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
      },
      { uri: "order.json", pointer: "/properties/line" },
    ]);
  });
});

describe("non-schema inlining and the sibling merge", () => {
  const docs = {
    "entry.json": {
      ...openapi,
      paths: {
        "/a": {
          $ref: "./path.json",
          summary: "written in the entry file",
        },
      },
    },
    "path.json": {
      summary: "written in the referenced file",
      get: { operationId: "listA", ...ok },
    },
  };

  it("attribute the inlined side to the target", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(sourceOf(regions, "/paths/~1a/get/operationId")).toEqual({
      uri: "path.json",
      pointer: "/get/operationId",
      via: [{ uri: "entry.json", pointer: "/paths/~1a" }],
    });
  });

  it("attribute a sibling key to the referring document, overriding the target's", async () => {
    const regions = await regionsOf(docs, "entry.json");
    // `summary` exists in both files and the entry file's wins the
    // merge, so provenance has to follow the value that survived.
    expect(sourceOf(regions, "/paths/~1a/summary")).toEqual({
      uri: "entry.json",
      pointer: "/paths/~1a/summary",
      via: [],
    });
  });

  it("attribute the merged node itself to the target", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(sourceOf(regions, "/paths/~1a")).toEqual({
      uri: "path.json",
      pointer: "",
      via: [{ uri: "entry.json", pointer: "/paths/~1a" }],
    });
  });

  it("record no shadow when the reference has no siblings", async () => {
    const regions = await regionsOf(
      {
        "entry.json": { ...openapi, paths: { "/a": { $ref: "./path.json" } } },
        "path.json": { get: { operationId: "listA", ...ok } },
      },
      "entry.json",
    );
    expect(regions).toHaveLength(2);
    expect(sourceOf(regions, "/paths/~1a/get")?.uri).toBe("path.json");
  });

  it("address a fragment target relative to that fragment", async () => {
    const regions = await regionsOf(
      {
        "entry.json": {
          ...openapi,
          paths: { "/a": { get: { responses: { "200": { $ref: "./r.json#/shared/ok" } } } } },
        },
        "r.json": { shared: { ok: { description: "ok" } } },
      },
      "entry.json",
    );
    expect(sourceOf(regions, "/paths/~1a/get/responses/200/description")).toEqual({
      uri: "r.json",
      pointer: "/shared/ok/description",
      via: [{ uri: "entry.json", pointer: "/paths/~1a/get/responses/200" }],
    });
  });
});

describe("stitched non-schema cycles", () => {
  // A Response Object cycle: p.json's 200 refs q.json#/r, which refs
  // that same response back. The walk cuts it by stitching q.json under
  // the root extension.
  const docs = {
    "entry.json": {
      ...openapi,
      paths: { "/a": { $ref: "./p.json" } },
    },
    "p.json": {
      get: { responses: { "200": { $ref: "./q.json#/r" } } },
    },
    "q.json": { r: { $ref: "./p.json#/get/responses/200" } },
  };

  it("mark the root extension and mount each stitched document under it", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(regions).toContainEqual({ kind: "synthetic", at: "/x-oaverify-externals" });
    expect(sourceOf(regions, "/x-oaverify-externals")).toBeUndefined();
    const stitched = regions.filter(
      (r) => r.kind === "mounted" && r.at.startsWith("/x-oaverify-externals/"),
    );
    expect(stitched.length).toBeGreaterThan(0);
    for (const region of stitched) {
      expect(region).toMatchObject({ pointer: "" });
    }
  });

  it("address a node inside a stitched document against that document's root", async () => {
    const regions = await regionsOf(docs, "entry.json");
    expect(sourceOf(regions, "/x-oaverify-externals/q.json/r")).toMatchObject({
      uri: "q.json",
      pointer: "/r",
    });
  });

  it("address the generated stitch reference to the node it replaced", async () => {
    const regions = await regionsOf(docs, "entry.json");
    // The node here is `$ref: "#/x-oaverify-externals/q.json/r"`, which
    // the resolver wrote. Two documents were inlined at this position
    // in turn, and the innermost is the one whose node was replaced.
    expect(sourceOf(regions, "/paths/~1a/get/responses/200")).toMatchObject({
      uri: "p.json",
      pointer: "/get/responses/200",
    });
  });
});

describe("references nested at one position", () => {
  it("resolve to the innermost document, which is what landed there", async () => {
    const regions = await regionsOf(
      {
        "entry.json": { ...openapi, paths: { "/a": { $ref: "./b.json" } } },
        "b.json": { $ref: "./c.json#/item" },
        "c.json": { item: { get: { operationId: "fromC", ...ok } } },
      },
      "entry.json",
    );
    expect(sourceOf(regions, "/paths/~1a/get/operationId")).toEqual({
      uri: "c.json",
      pointer: "/item/get/operationId",
      via: [
        { uri: "entry.json", pointer: "/paths/~1a" },
        { uri: "b.json", pointer: "" },
      ],
    });
  });
});

describe("the path stack stays balanced", () => {
  it("addresses nodes after an external reference, not before it", async () => {
    // A ref part-way through a document: if push/pop got out of balance
    // across the read, every pointer after it would be shifted, which
    // reads as plausible and resolves to the wrong node.
    const regions = await regionsOf(
      {
        "entry.json": {
          ...openapi,
          paths: {
            "/a": { $ref: "./p.json" },
            "/b": { get: { operationId: "afterTheRef", ...ok } },
          },
          tags: [{ name: "one" }, { name: "two" }],
        },
        "p.json": { get: { operationId: "inTheRef", ...ok } },
      },
      "entry.json",
    );
    expect(sourceOf(regions, "/paths/~1b/get/operationId")).toEqual({
      uri: "entry.json",
      pointer: "/paths/~1b/get/operationId",
      via: [],
    });
    expect(sourceOf(regions, "/tags/1/name")).toEqual({
      uri: "entry.json",
      pointer: "/tags/1/name",
      via: [],
    });
  });
});

describe("discriminator mappings", () => {
  it("keep the address of a rewritten mapping value", async () => {
    // `fixUpDiscriminatorMappings` rewrites the value after the walk.
    // The address is unchanged, which is what `source` claims; the
    // value is not, which is what it does not claim.
    const regions = await regionsOf(
      {
        "entry.json": {
          ...openapi,
          paths: {
            "/a": {
              post: {
                ...ok,
                requestBody: {
                  content: { "application/json": { schema: { $ref: "./pets.json#/Pet" } } },
                },
              },
            },
          },
        },
        "pets.json": {
          Pet: {
            oneOf: [{ $ref: "#/Cat" }],
            discriminator: { propertyName: "kind", mapping: { cat: "#/Cat" } },
          },
          Cat: { type: "object" },
        },
      },
      "entry.json",
    );
    // `pets_Pet` is the derived component name; the source pointer is
    // where the author actually wrote it.
    expect(sourceOf(regions, "/components/schemas/pets_Pet/discriminator/mapping/cat")).toEqual({
      uri: "pets.json",
      pointer: "/Pet/discriminator/mapping/cat",
      via: [
        {
          uri: "entry.json",
          pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        },
      ],
    });
  });

  it("reports each document in the form the entry was given in", async () => {
    // A source URI is resolved against the entry, so it comes back in
    // whatever form the entry was passed in: a caller that handed over
    // a relative path gets relative URIs back and resolves them the
    // same way it resolved the entry. Pinned because a consumer has to
    // turn a URI into something it can open.
    const docs = (prefix: string): Record<string, unknown> => ({
      [`${prefix}entry.json`]: {
        openapi: "3.1.0",
        info: { title: "X", version: "1" },
        paths: {
          "/a": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "./nested/one.json#/schema" } } },
              },
              responses: {},
            },
          },
        },
      },
      [`${prefix}nested/one.json`]: { schema: { type: "object" } },
    });

    const relative = await regionsOf(docs(""), "entry.json");
    expect(sourceOf(relative, "/components/schemas/one_schema")).toEqual({
      uri: "nested/one.json",
      pointer: "/schema",
      via: [
        {
          uri: "entry.json",
          pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        },
      ],
    });

    const absolute = await regionsOf(docs("/specs/"), "/specs/entry.json");
    expect(sourceOf(absolute, "/components/schemas/one_schema")).toEqual({
      uri: "/specs/nested/one.json",
      pointer: "/schema",
      via: [
        {
          uri: "/specs/entry.json",
          pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        },
      ],
    });
  });
});
