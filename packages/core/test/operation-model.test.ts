import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "../src/index.js";
import {
  REF_CHAIN_MAX_HOPS,
  buildOperationModel,
  followReference,
} from "../src/operation-model.js";

const ok = { "200": { description: "ok" } };

function doc(version: string, body: Record<string, unknown>): OpenAPIDocument {
  return { openapi: version, info: { title: "t", version: "1" }, ...body } as OpenAPIDocument;
}

/** A `paths` entry whose chain crosses `edges` references before reaching a Path Item with GET. */
function chainOf(edges: number): OpenAPIDocument {
  const items: Record<string, unknown> = {};
  for (let i = 0; i < edges - 1; i++) items[`I${i}`] = { $ref: `#/x-items/I${i + 1}` };
  items[`I${edges - 1}`] = { get: { responses: ok } };
  return doc("3.1.0", { paths: { "/p": { $ref: "#/x-items/I0" } }, "x-items": items });
}

describe("buildOperationModel: containers", () => {
  it("lists operations under paths, webhooks, components.pathItems and callbacks", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/a": {
            get: {
              responses: ok,
              callbacks: { onEvent: { "{$request.body#/url}": { post: { responses: ok } } } },
            },
          },
          "/b": { get: { responses: ok } },
          "x-ext": { get: { responses: ok } },
        },
        webhooks: { newPet: { post: { responses: ok } } },
        components: {
          pathItems: { Shared: { put: { responses: ok } } },
          callbacks: { Ping: { "{$url}": { delete: { responses: ok } } } },
        },
      }),
    );
    expect(model.operations.map((op) => [op.pathItem.container, op.pointer])).toEqual([
      ["paths", "/paths/~1a/get"],
      ["callback", "/paths/~1a/get/callbacks/onEvent/{$request.body#~1url}/post"],
      ["paths", "/paths/~1b/get"],
      ["webhooks", "/webhooks/newPet/post"],
      ["components.pathItems", "/components/pathItems/Shared/put"],
      ["callback", "/components/callbacks/Ping/{$url}/delete"],
    ]);
    expect(model.operations[1]!.pathItem.callbackPointer).toBe("/paths/~1a/get/callbacks/onEvent");
    expect(model.operations[5]!.pathItem.callbackPointer).toBe("/components/callbacks/Ping");
    expect(model.operations[0]!.pathItem.callbackPointer).toBeUndefined();
  });

  it("lists positions the document's version does not define, because the engines read them", () => {
    const model = buildOperationModel(
      doc("3.0.3", {
        paths: {
          "/a": {
            query: { responses: ok },
            get: { responses: ok },
            additionalOperations: { PURGE: { responses: ok } },
          },
        },
        webhooks: {
          w: {
            post: {
              responses: ok,
              callbacks: { cb: { "{$url}": { put: { responses: ok } } } },
            },
          },
        },
        components: { pathItems: { P: { put: { responses: ok } } } },
      }),
    );
    expect(model.version).toBe("3.0");
    expect(model.operations.map((op) => [op.pointer, op.servedBy.runtime.served])).toEqual([
      ["/paths/~1a/get", true],
      ["/paths/~1a/query", true],
      ["/paths/~1a/additionalOperations/PURGE", false],
      ["/webhooks/w/post", false],
      ["/webhooks/w/post/callbacks/cb/{$url}/put", false],
      ["/components/pathItems/P/put", false],
    ]);
  });

  it("reads 3.2 query and additionalOperations", () => {
    const model = buildOperationModel(
      doc("3.2.0", {
        paths: {
          "/a": {
            query: { responses: ok },
            additionalOperations: { PURGE: { responses: ok }, "LOCK/X": { responses: ok } },
          },
        },
      }),
    );
    expect(model.operations.map((op) => [op.method, op.methodKind, op.pointer])).toEqual([
      ["query", "fixed", "/paths/~1a/query"],
      ["PURGE", "additional", "/paths/~1a/additionalOperations/PURGE"],
      ["LOCK/X", "additional", "/paths/~1a/additionalOperations/LOCK~1X"],
    ]);
    expect(model.operations[1]!.servedBy).toEqual({
      runtime: { served: false, reason: "additional-operation" },
      emitted: { served: false, reason: "additional-operation" },
    });
  });

  it("skips entries that are not objects", () => {
    const model = buildOperationModel(
      doc("3.1.0", { paths: { "/null": null, "/list": [], "/p": { get: null, put: "x" } } }),
    );
    expect(model.pathItems.map((item) => item.pointer)).toEqual(["/paths/~1p"]);
    expect(model.operations).toEqual([]);
  });
});

describe("buildOperationModel: Path Item reference chains", () => {
  const chained = doc("3.1.0", {
    paths: { "/p": { $ref: "#/x-items/Mid", get: { responses: ok, operationId: "entryGet" } } },
    "x-items": {
      Mid: {
        $ref: "#/x-items/Final",
        get: { operationId: "midGet", responses: ok },
        post: { responses: ok },
      },
      Final: { put: { responses: ok }, parameters: [{ name: "q", in: "query" }] },
    },
  });

  it("keeps every field along the chain, nearest declaration winning", () => {
    const model = buildOperationModel(chained);
    const item = model.pathItems[0]!;
    expect(item.chain.status).toBe("complete");
    expect(item.chain.hops.map((h) => h.pointer)).toEqual([
      "/paths/~1p",
      "/x-items/Mid",
      "/x-items/Final",
    ]);
    expect(model.operations.map((op) => [op.method, op.declaredIn, op.node.operationId])).toEqual([
      ["get", "/paths/~1p", "entryGet"],
      ["put", "/x-items/Final", undefined],
      ["post", "/x-items/Mid", undefined],
    ]);
    expect(item.origins.get("parameters")).toBe("/x-items/Final");
  });

  it("records that the router serves only the entry's own methods", () => {
    const model = buildOperationModel(chained);
    const by = Object.fromEntries(model.operations.map((op) => [op.method, op.servedBy]));
    expect(by["get"]).toEqual({ runtime: { served: true }, emitted: { served: true } });
    expect(by["put"]).toEqual({
      runtime: { served: false, reason: "behind-path-item-ref" },
      emitted: { served: true },
    });
  });

  it("decodes a percent-encoded fragment once, its leading slash included", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/space": { $ref: "#/x-items/My%20Item" },
          "/slash": { $ref: "#%2Fx-items%2FMy%20Item" },
        },
        "x-items": { "My Item": { get: { responses: ok } } },
      }),
    );
    expect(model.operations.map((op) => op.pointer)).toEqual([
      "/x-items/My Item/get",
      "/x-items/My Item/get",
    ]);
    expect(model.diagnostics).toEqual([]);
  });

  it("marks cycles, unresolved and external references, and still models the fields it saw", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/cycle": { $ref: "#/x-items/A" },
          "/missing": { $ref: "#/x-items/Nope", get: { responses: ok } },
          "/anchor": { $ref: "#Nope" },
          "/ext": { $ref: "other.yaml#/Item" },
        },
        "x-items": {
          A: { $ref: "#/x-items/B", get: { responses: ok } },
          B: { $ref: "#/x-items/A" },
        },
      }),
    );
    expect(model.diagnostics).toEqual([
      { status: "cycle", pointer: "/paths/~1cycle", ref: "#/x-items/A" },
      { status: "unresolved", pointer: "/paths/~1missing", ref: "#/x-items/Nope" },
      { status: "unresolved", pointer: "/paths/~1anchor", ref: "#Nope" },
      { status: "external", pointer: "/paths/~1ext", ref: "other.yaml#/Item" },
    ]);
    expect(model.operations.map((op) => op.pointer)).toEqual([
      "/x-items/A/get",
      "/paths/~1missing/get",
    ]);
  });

  it("records that the emitter builds nothing when one chain under paths does not complete", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/ok": { get: { responses: ok } },
          "/p": { $ref: "#/paths/~1p", get: { responses: ok } },
        },
      }),
    );
    expect(model.operations.map((op) => op.servedBy)).toEqual([
      { runtime: { served: true }, emitted: { served: false, reason: "emit-fails" } },
      { runtime: { served: true }, emitted: { served: false, reason: "emit-fails" } },
    ]);
    expect(model.pathItems.map((item) => item.impliedHead)).toEqual([
      { runtime: true, emitted: false },
      { runtime: true, emitted: false },
    ]);
  });

  it("records that the emitter skips an entry whose chain ends at null", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: { "/p": { $ref: "#/x-null", get: { responses: ok } } },
        "x-null": null,
      }),
    );
    expect(model.pathItems[0]!.chain.status).toBe("complete");
    expect(model.operations[0]!.servedBy).toEqual({
      runtime: { served: true },
      emitted: { served: false, reason: "null-target" },
    });
    expect(model.pathItems[0]!.impliedHead).toEqual({ runtime: true, emitted: false });
  });

  it("counts an extension key's broken reference against the emitter, as the emitter does", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: { "/ok": { get: { responses: ok } }, "x-bad": { $ref: "#/nope" } },
      }),
    );
    expect(model.pathItems.map((item) => item.pointer)).toEqual(["/paths/~1ok"]);
    expect(model.operations[0]!.servedBy.emitted).toEqual({ served: false, reason: "emit-fails" });
    expect(model.diagnostics).toEqual([]);
  });

  it("completes a chain of the most nodes allowed and truncates one node longer", () => {
    const longest = buildOperationModel(chainOf(REF_CHAIN_MAX_HOPS - 1));
    expect(longest.pathItems[0]!.chain.status).toBe("complete");
    expect(longest.pathItems[0]!.chain.hops).toHaveLength(REF_CHAIN_MAX_HOPS);
    expect(longest.operations[0]!.servedBy.emitted).toEqual({ served: true });

    const tooLong = buildOperationModel(chainOf(REF_CHAIN_MAX_HOPS));
    expect(tooLong.pathItems[0]!.chain.status).toBe("truncated");
    expect(tooLong.pathItems[0]!.chain.hops).toHaveLength(REF_CHAIN_MAX_HOPS);
    expect(tooLong.operations).toEqual([]);
    expect(tooLong.diagnostics.map((d) => d.status)).toEqual(["truncated"]);
  });

  it("follows a reference to the document root", () => {
    const chain = followReference(doc("3.1.0", {}), { $ref: "#" }, "/entry");
    expect(chain.status).toBe("complete");
    expect(chain.pointer).toBe("");
  });
});

describe("buildOperationModel: callbacks", () => {
  it("models a callback Path Item once, however many operations reference its Callback Object", () => {
    // Each level's operation references the next level twice, so walking
    // every route to the last level would visit it 2^levels times.
    const levels = 24;
    const callbacks: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) {
      const next = { $ref: `#/components/callbacks/C${i + 1}` };
      callbacks[`C${i}`] = {
        "{$url}": {
          post: { responses: ok, callbacks: i < levels - 1 ? { a: next, b: next } : {} },
        },
      };
    }
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/p": {
            post: { responses: ok, callbacks: { c: { $ref: "#/components/callbacks/C0" } } },
          },
        },
        components: { callbacks },
      }),
    );
    expect(model.operations).toHaveLength(levels + 1);
    expect(new Set(model.operations.map((op) => op.pointer)).size).toBe(levels + 1);
  });

  it("keeps a callback Path Item's own operations when it references the Path Item above it", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/p": {
            get: {
              responses: ok,
              callbacks: {
                again: { "{$url}": { $ref: "#/paths/~1p", post: { responses: ok } } },
              },
            },
          },
        },
      }),
    );
    expect(model.operations.map((op) => [op.pathItem.container, op.pointer])).toEqual([
      ["paths", "/paths/~1p/get"],
      ["callback", "/paths/~1p/get"],
      ["callback", "/paths/~1p/get/callbacks/again/{$url}/post"],
    ]);
  });

  it("ends at a callback that leads back to itself", () => {
    const item: Record<string, unknown> = {
      post: {
        responses: ok,
        callbacks: { again: { "{$url}": { $ref: "#/components/pathItems/Self" } } },
      },
    };
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: { "/p": { $ref: "#/components/pathItems/Self" } },
        components: { pathItems: { Self: item } },
      }),
    );
    expect(model.pathItems.map((p) => [p.container, p.pointer])).toEqual([
      ["paths", "/paths/~1p"],
      ["callback", "/components/pathItems/Self/post/callbacks/again/{$url}"],
      ["components.pathItems", "/components/pathItems/Self"],
    ]);
    expect(new Set(model.operations.map((op) => op.pointer))).toEqual(
      new Set(["/components/pathItems/Self/post"]),
    );
  });

  it("reports a callback reference it cannot follow", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/p": {
            post: { responses: ok, callbacks: { c: { $ref: "#/components/callbacks/Nope" } } },
          },
        },
      }),
    );
    expect(model.diagnostics).toEqual([
      {
        status: "unresolved",
        pointer: "/paths/~1p/post/callbacks/c",
        ref: "#/components/callbacks/Nope",
      },
    ]);
  });
});

describe("buildOperationModel: implied HEAD", () => {
  it("follows the router for the raw entry and the emitter for the effective item", () => {
    const model = buildOperationModel(
      doc("3.1.0", {
        paths: {
          "/raw": { get: { responses: ok } },
          "/viaRef": { $ref: "#/x-items/G" },
          "/withHead": { get: { responses: ok }, head: { responses: ok } },
          "/headBehindRef": { $ref: "#/x-items/H", get: { responses: ok } },
        },
        "x-items": { G: { get: { responses: ok } }, H: { head: { responses: ok } } },
      }),
    );
    expect(model.pathItems.map((p) => [p.key, p.impliedHead])).toEqual([
      ["/raw", { runtime: true, emitted: true }],
      ["/viaRef", { runtime: false, emitted: true }],
      ["/withHead", { runtime: false, emitted: false }],
      ["/headBehindRef", { runtime: true, emitted: false }],
    ]);
  });
});
