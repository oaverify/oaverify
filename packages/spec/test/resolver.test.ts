import { describe, expect, it } from "vitest";
import { composeReaders, createMemoryReader } from "../src/reader.js";
import { resolveJsonPointer, resolveSpec } from "../src/resolver.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";

function collectInternalRefs(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectInternalRefs(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#")) out.push(ref);
  for (const key of Object.keys(obj)) {
    if (key === "$ref") continue;
    collectInternalRefs(obj[key], out);
  }
  return out;
}

describe("resolveSpec", () => {
  it("returns the document unchanged when there are no external refs", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
          },
        ],
      ]),
    );
    const { document, sources } = await resolveSpec({ reader, entry: "main.json" });
    expect(document.info.title).toBe("X");
    expect(sources).toEqual(["main.json"]);
  });

  it("inlines external refs, loading each file exactly once", async () => {
    const reader = composeReaders([
      createMemoryReader(
        new Map<string, unknown>([
          [
            "main.json",
            {
              openapi: "3.1.0",
              info: { title: "X", version: "1" },
              paths: {
                "/p": {
                  get: { responses: { "200": { $ref: "responses.json#/Ok" } } },
                },
              },
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
      ),
    ]);
    const { document, sources } = await resolveSpec({ reader, entry: "main.json" });
    const resp = (document.paths?.["/p"]?.get?.responses ?? {})["200"];
    expect(resp?.description).toBe("ok");
    expect(sources).toContain("responses.json");
    expect(sources).toContain("schemas/pet.json");
  });

  it("detects and short-circuits circular refs without infinite recursion", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
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
    );
    const { document } = await resolveSpec({ reader, entry: "a.json" });
    const refs = collectInternalRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/")).toBe(true);
      const target = resolveJsonPointer(document, ref.slice(1));
      expect(target).toBeDefined();
    }
  });

  it("stitches three-way cycles (a → b → c → a) under $defs.__ext__", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
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
    );
    const { document } = await resolveSpec({ reader, entry: "a.json" });
    const defs = (document as unknown as { $defs: Record<string, unknown> }).$defs;
    const ext = defs.__ext__ as Record<string, unknown>;
    expect(Object.keys(ext).length).toBeGreaterThan(0);
    for (const ref of collectInternalRefs(document)) {
      const target = resolveJsonPointer(document, ref.slice(1));
      expect(target).toBeDefined();
    }
  });

  it("only stitches circular externals; non-circular refs are inlined", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            components: {
              schemas: {
                Plain: { $ref: "plain.json" },
                Loop: { $ref: "loop.json#/Node" },
              },
            },
          },
        ],
        ["plain.json", { type: "object", properties: { n: { type: "integer" } } }],
        [
          "loop.json",
          {
            Node: {
              type: "object",
              properties: { next: { $ref: "loop.json#/Node" } },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const schemas = (
      document as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }
    ).components.schemas;
    expect(schemas.Plain?.type).toBe("object");
    expect(schemas.Plain?.$ref).toBeUndefined();
    const docRecord = document as unknown as SchemaOrBoolean;
    const ext = (docRecord as unknown as { $defs: Record<string, unknown> }).$defs
      .__ext__ as Record<string, unknown>;
    expect(ext).toBeDefined();
    expect(Object.keys(ext)).toContain("loop.json");
    expect(Object.keys(ext)).not.toContain("plain.json");
    for (const ref of collectInternalRefs(document)) {
      const target = resolveJsonPointer(document, ref.slice(1));
      expect(target).toBeDefined();
    }
  });

  it("resolves refs whose fragments percent-encode reserved chars (e.g. {})", async () => {
    // Real-world case: DigitalOcean's spec uses fragments like
    // #/paths/~1v2~1apps~1%7Bapp_id%7D/get/parameters/0 because { and }
    // are reserved in URI fragments per RFC 3986 §3.5. Per RFC 6901 §6,
    // percent-decoding must happen before ~0/~1 decoding.
    const doc = {
      paths: {
        "/v2/apps/{app_id}": {
          get: { parameters: [{ name: "app_id", in: "path" }] },
        },
      },
    };
    const p = resolveJsonPointer(doc, "/paths/~1v2~1apps~1%7Bapp_id%7D/get/parameters/0");
    expect(p).toEqual({ name: "app_id", in: "path" });
  });

  it("preserves stray % chars in keys (only well-formed %XX sequences decode)", async () => {
    const doc = { "50%": { value: 1 } };
    const p = resolveJsonPointer(doc, "/50%");
    expect(p).toEqual({ value: 1 });
  });

  it("merges $defs.__ext__ with pre-existing $defs on the entry doc", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
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
    );
    const { document } = await resolveSpec({ reader, entry: "a.json" });
    const defs = (document as unknown as { $defs: Record<string, unknown> }).$defs;
    expect((defs.Existing as Record<string, unknown>).type).toBe("string");
    expect(defs.__ext__).toBeDefined();
  });

  describe("internal refs inside inlined external subtrees (#38)", () => {
    it("rewrites local #/... refs in an inlined subtree to point at the stitched external", async () => {
      // The failing pattern: root.yaml $refs a fragment in ext.yaml,
      // and that fragment contains a local `#/components/schemas/...`
      // ref pointing at a sibling inside ext.yaml. The inlined subtree's
      // internal ref must be rewritten so it resolves against ext.yaml,
      // not the root.
      const reader = createMemoryReader(
        new Map<string, unknown>([
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
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/Thing" },
                      },
                    },
                  },
                },
                schemas: {
                  Thing: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
          ],
        ]),
      );
      const { document } = await resolveSpec({ reader, entry: "root.json" });
      const refs = collectInternalRefs(document);
      // The local #/components/schemas/Thing ref must have been
      // rewritten to point at the stitched external location, NOT left
      // pointing at the root document.
      expect(refs).not.toContain("#/components/schemas/Thing");
      expect(refs.some((r) => r.startsWith("#/$defs/__ext__/ext.json"))).toBe(true);
      // And $defs.__ext__.ext.json.components.schemas.Thing resolves.
      const target = resolveJsonPointer(
        document,
        "/$defs/__ext__/ext.json/components/schemas/Thing",
      );
      expect(target).toEqual({
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      });
    });

    it("handles nested external refs with their own local siblings", async () => {
      // Two levels deep: root → ext1 → ext2, where ext1's inlined
      // fragment contains a local ref and ext2 also has its own local
      // ref. Each local ref should resolve against the file it came from.
      const reader = createMemoryReader(
        new Map<string, unknown>([
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
                      "application/json": {
                        schema: { $ref: "#/components/schemas/InExt1" },
                      },
                    },
                  },
                },
                schemas: {
                  InExt1: {
                    type: "object",
                    properties: {
                      nested: { $ref: "ext2.json#/components/schemas/Leaf" },
                    },
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
      );
      const { document } = await resolveSpec({ reader, entry: "root.json" });
      const refs = collectInternalRefs(document);
      // No raw root-level #/components/... refs should survive;
      // everything got rewritten into the external namespace.
      expect(refs.filter((r) => r.startsWith("#/components/"))).toEqual([]);
      // Both external files got stitched.
      expect(
        resolveJsonPointer(document, "/$defs/__ext__/ext1.json/components/schemas/InExt1"),
      ).toBeDefined();
      expect(
        resolveJsonPointer(document, "/$defs/__ext__/ext2.json/components/schemas/Leaf"),
      ).toBeDefined();
    });

    it("leaves internal refs in the entry document alone", async () => {
      // Regression guard: we only rewrite when we're inside an inlined
      // external subtree. Internal refs in root.yaml point at root.yaml
      // and must not be touched.
      const reader = createMemoryReader(
        new Map<string, unknown>([
          [
            "root.json",
            {
              openapi: "3.1.0",
              info: { title: "X", version: "1" },
              components: {
                schemas: { RootThing: { type: "string" } },
              },
              paths: {
                "/x": {
                  get: {
                    responses: {
                      "200": {
                        description: "ok",
                        content: {
                          "application/json": {
                            schema: { $ref: "#/components/schemas/RootThing" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        ]),
      );
      const { document } = await resolveSpec({ reader, entry: "root.json" });
      expect(collectInternalRefs(document)).toEqual(["#/components/schemas/RootThing"]);
    });
  });
});
