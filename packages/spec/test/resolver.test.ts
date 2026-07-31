import { describe, expect, it } from "vitest";
import { composeReaders, createMemoryReader } from "../src/reader.js";
import { pointerFromFragment, resolveJsonPointer, resolveSpec } from "../src/resolver.js";

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

  it("terminates on three-way cycles (a → b → c → a), with every ref resolvable", async () => {
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
    // Schema targets are hoisted into `components.schemas`, so a cycle
    // resolves to a named component rather than a root `$defs` bucket
    // OpenAPI does not allow (#556).
    expect((document as unknown as { $defs?: unknown }).$defs).toBeUndefined();
    const schemas = (document as unknown as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    for (const ref of collectInternalRefs(document)) {
      const target = resolveJsonPointer(document, ref.slice(1));
      expect(target).toBeDefined();
    }
  });

  it("hoists external schemas into the component slot that named them", async () => {
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
    // A component whose value was nothing but an external `$ref` keeps
    // its own name and receives the content, rather than becoming a
    // pointer at a second component invented by the resolver.
    expect(schemas.Plain?.type).toBe("object");
    expect(schemas.Plain?.$ref).toBeUndefined();
    // The recursive one gets a legal internal address under its author's
    // name, and its self-reference points there.
    expect(schemas.Loop?.type).toBe("object");
    const loopProps = schemas.Loop?.properties as Record<string, Record<string, unknown>>;
    expect(loopProps.next?.$ref).toBe("#/components/schemas/Loop");
    expect((document as unknown as { $defs?: unknown }).$defs).toBeUndefined();
    for (const ref of collectInternalRefs(document)) {
      const target = resolveJsonPointer(document, ref.slice(1));
      expect(target).toBeDefined();
    }
  });

  it("resolves refs whose fragments percent-encode reserved chars (e.g. {})", async () => {
    // Real-world case: DigitalOcean's spec uses fragments like
    // #/paths/~1v2~1apps~1%7Bapp_id%7D/get/parameters/0 because { and }
    // are reserved in URI fragments per RFC 3986 §3.5. Per RFC 6901 §6,
    // percent-decoding happens before ~0/~1 decoding, and it happens in
    // `pointerFromFragment`: what arrives from a `$ref` is a fragment,
    // and `resolveJsonPointer` evaluates pointers.
    const doc = {
      paths: {
        "/v2/apps/{app_id}": {
          get: { parameters: [{ name: "app_id", in: "path" }] },
        },
      },
    };
    const fragment = "/paths/~1v2~1apps~1%7Bapp_id%7D/get/parameters/0";
    const p = resolveJsonPointer(doc, pointerFromFragment(fragment));
    expect(p).toEqual({ name: "app_id", in: "path" });
  });

  it("preserves stray % chars in keys (only well-formed %XX sequences decode)", async () => {
    const doc = { "50%": { value: 1 } };
    const p = resolveJsonPointer(doc, "/50%");
    expect(p).toEqual({ value: 1 });
  });

  it("leaves a pre-existing root $defs on the entry document alone", async () => {
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
    // The author's own `$defs` survives untouched; the resolver no
    // longer adds an `__ext__` bucket beside it.
    expect((defs.Existing as Record<string, unknown>).type).toBe("string");
    expect(defs.__ext__).toBeUndefined();
    const schemas = (document as unknown as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  describe("internal refs inside inlined external subtrees (#38)", () => {
    it("hoists a local #/... ref from an inlined subtree to a component of its own", async () => {
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
      // The request body is a non-schema position, so it still inlines.
      // The `schema` inside it is a schema position, so its local ref
      // into ext.json becomes a hoisted component in the root document.
      // The ref reads the same as before, but now it resolves, and to
      // ext.json's schema rather than to a root component that did not
      // exist.
      expect(refs).toContain("#/components/schemas/Thing");
      expect(resolveJsonPointer(document, "/components/schemas/Thing")).toEqual({
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      });
      expect((document as unknown as { $defs?: unknown }).$defs).toBeUndefined();
    });

    it("does not let a hoisted name shadow a component the author wrote", async () => {
      // Same fragment name on both sides: the entry document's `Thing`
      // must survive, and the external one gets a distinct name derived
      // from its canonical target rather than from encounter order.
      const reader = createMemoryReader(
        new Map<string, unknown>([
          [
            "root.json",
            {
              openapi: "3.1.0",
              info: { title: "X", version: "1" },
              components: {
                schemas: { Thing: { type: "string", description: "the author's Thing" } },
              },
              paths: {
                "/things": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: { $ref: "ext.json#/components/schemas/Thing" },
                        },
                      },
                    },
                    responses: { "201": { description: "ok" } },
                  },
                },
              },
            },
          ],
          [
            "ext.json",
            { components: { schemas: { Thing: { type: "object", title: "the external Thing" } } } },
          ],
        ]),
      );
      const { document } = await resolveSpec({ reader, entry: "root.json" });
      const schemas = (
        document as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }
      ).components.schemas;

      expect(schemas.Thing?.description).toBe("the author's Thing");
      const hoistedName = Object.keys(schemas).find((n) => n !== "Thing");
      expect(hoistedName).toBeDefined();
      expect(schemas[hoistedName as string]?.title).toBe("the external Thing");
      for (const ref of collectInternalRefs(document)) {
        expect(resolveJsonPointer(document, ref.slice(1))).toBeDefined();
      }
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
      // Two levels of external file, each contributing schemas under a
      // name of its own. Every ref resolves against the resolved
      // document, which is the property that matters: a ref that
      // resolved against the wrong file was the #38 defect.
      for (const ref of collectInternalRefs(document)) {
        expect(resolveJsonPointer(document, ref.slice(1)), ref).toBeDefined();
      }
      const schemas = (document as unknown as { components: { schemas: Record<string, unknown> } })
        .components.schemas;
      expect(Object.keys(schemas)).toContain("InExt1");
      expect(Object.keys(schemas)).toContain("SelfInExt2");
      expect((document as unknown as { $defs?: unknown }).$defs).toBeUndefined();
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

describe("non-schema cycles land somewhere legal (#559)", () => {
  // Schema cycles hoist into `components.schemas`. A cycle among
  // non-schema objects has no components section to go to, so it is
  // materialised under an `x-` extension: OpenAPI allows those on the
  // root and allows nothing else there, and the previous home (a root
  // `$defs`) made `check` report the resolver's own output as
  // non-conformant.
  const cyclic = () =>
    createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/a": {
                get: { operationId: "a", responses: { "200": { $ref: "resp.json" } } },
              },
            },
          },
        ],
        ["resp.json", { description: "a", headers: { "X-B": { $ref: "header.json" } } }],
        [
          "header.json",
          {
            description: "b",
            schema: { type: "string" },
            "x-loop": { $ref: "resp.json" },
          },
        ],
      ]),
    );

  it("uses an x- extension rather than a root $defs", async () => {
    const { document } = await resolveSpec({ reader: cyclic(), entry: "main.json" });
    expect((document as unknown as { $defs?: unknown }).$defs).toBeUndefined();
    const bucket = (document as unknown as Record<string, unknown>)["x-oaverify-externals"];
    expect(bucket).toBeDefined();
    expect(Object.keys(bucket as Record<string, unknown>)).toContain("resp.json");
  });

  it("leaves every ref into the bucket resolvable", async () => {
    const { document } = await resolveSpec({ reader: cyclic(), entry: "main.json" });
    const refs = collectInternalRefs(document);
    expect(refs.some((r) => r.startsWith("#/x-oaverify-externals/"))).toBe(true);
    for (const ref of refs) {
      expect(resolveJsonPointer(document, ref.slice(1)), ref).toBeDefined();
    }
  });
});

describe("hoisting external schemas (#553, #556)", () => {
  const petSpec = (extra: Record<string, unknown> = {}) =>
    new Map<string, unknown>([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: {
            "/a": {
              post: {
                requestBody: {
                  content: { "application/json": { schema: { $ref: "pet.json" } } },
                },
                responses: { "200": { description: "ok" } },
              },
            },
            "/b": {
              post: {
                requestBody: {
                  content: { "application/json": { schema: { $ref: "pet.json" } } },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
          ...extra,
        },
      ],
      ["pet.json", { type: "object", properties: { name: { type: "string" } } }],
    ]);

  it("stores a schema once however many sites reference it", async () => {
    const { document } = await resolveSpec({
      reader: createMemoryReader(petSpec()),
      entry: "main.json",
    });
    const schemas = (document as unknown as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    expect(Object.keys(schemas)).toEqual(["pet"]);
    const refs = collectInternalRefs(document);
    expect(refs.filter((r) => r === "#/components/schemas/pet")).toHaveLength(2);
  });

  it("is idempotent: resolving the output again changes nothing", async () => {
    const reader = createMemoryReader(petSpec());
    const first = (await resolveSpec({ reader, entry: "main.json" })).document;
    const second = (
      await resolveSpec({
        reader: createMemoryReader(new Map<string, unknown>([["resolved.json", first]])),
        entry: "resolved.json",
      })
    ).document;
    expect(second).toEqual(first);
  });

  it("keeps discriminator mapping values pointing at their branches", async () => {
    // The #553 shape: branches and mapping both name external files, and
    // the compiler matches one against the other by `$ref`.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/actions": {
                post: {
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: {
                          anyOf: [{ $ref: "models/attach.json" }, { $ref: "models/detach.json" }],
                          discriminator: {
                            propertyName: "type",
                            mapping: {
                              attach: "models/attach.json",
                              detach: "models/detach.json",
                            },
                          },
                        },
                      },
                    },
                  },
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          },
        ],
        ["models/attach.json", { type: "object", properties: { type: { const: "attach" } } }],
        ["models/detach.json", { type: "object", properties: { type: { const: "detach" } } }],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const paths = (
      document as unknown as {
        paths: Record<
          string,
          {
            post: {
              requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
            };
          }
        >;
      }
    ).paths;
    const schema = paths["/actions"]?.post.requestBody.content["application/json"]
      ?.schema as Record<string, unknown>;

    const branches = (schema.anyOf as Array<{ $ref: string }>).map((b) => b.$ref);
    const mapping = (schema.discriminator as { mapping: Record<string, string> }).mapping;
    // The property the compiler depends on: every mapping value is one of
    // the branch refs.
    expect(Object.values(mapping).sort()).toEqual([...branches].sort());
    for (const ref of collectInternalRefs(document)) {
      expect(resolveJsonPointer(document, ref.slice(1)), ref).toBeDefined();
    }
  });

  it("follows a mapping that is local to the external document it came from", async () => {
    // A `#/components/schemas/Cat` mapping inside ext.json names ext's
    // Cat, exactly like the branch `$ref` beside it. Leaving it alone
    // pointed it at a same-named component in the *entry* document,
    // which either fails to match or routes through the wrong schema.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            components: { schemas: { Cat: { type: "string", description: "an unrelated Cat" } } },
            paths: {
              "/pets": {
                post: {
                  requestBody: {
                    content: {
                      "application/json": { schema: { $ref: "ext.json#/components/schemas/Pet" } },
                    },
                  },
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          },
        ],
        [
          "ext.json",
          {
            components: {
              schemas: {
                Pet: {
                  oneOf: [
                    { $ref: "#/components/schemas/Cat" },
                    { $ref: "#/components/schemas/Dog" },
                  ],
                  discriminator: {
                    propertyName: "type",
                    mapping: {
                      cat: "#/components/schemas/Cat",
                      dog: "#/components/schemas/Dog",
                    },
                  },
                },
                Cat: { type: "object", properties: { type: { const: "cat" } } },
                Dog: { type: "object", properties: { type: { const: "dog" } } },
              },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const schemas = (
      document as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }
    ).components.schemas;

    // The entry document's Cat is untouched.
    expect(schemas.Cat?.description).toBe("an unrelated Cat");

    const pet = schemas.Pet as {
      oneOf: Array<{ $ref: string }>;
      discriminator: { mapping: Record<string, string> };
    };
    const branches = pet.oneOf.map((b) => b.$ref);
    // The property the compiler matches on: every mapping value is one
    // of the branch refs, and none of them is the entry's Cat.
    expect(Object.values(pet.discriminator.mapping).sort()).toEqual([...branches].sort());
    expect(Object.values(pet.discriminator.mapping)).not.toContain("#/components/schemas/Cat");
    for (const ref of collectInternalRefs(document)) {
      expect(resolveJsonPointer(document, ref.slice(1)), ref).toBeDefined();
    }
  });

  it("follows an extensionless relative mapping value", async () => {
    // `$ref: "Cat"` is a legal same-directory file with no extension. A
    // "does it contain a slash or a dot" test read that as a bare
    // component name and left the mapping pointing at the entry
    // document's Cat while the branch was hoisted elsewhere.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            components: { schemas: { Cat: { type: "string", description: "an unrelated Cat" } } },
            paths: {
              "/pets": {
                post: {
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: {
                          oneOf: [{ $ref: "Cat" }],
                          discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
                        },
                      },
                    },
                  },
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          },
        ],
        ["Cat", { type: "object", properties: { type: { const: "cat" } } }],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const schema = (
      document as unknown as {
        paths: Record<
          string,
          {
            post: { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } };
          }
        >;
      }
    ).paths["/pets"]?.post.requestBody.content["application/json"]?.schema as Record<
      string,
      unknown
    >;

    const branches = (schema.oneOf as Array<{ $ref: string }>).map((b) => b.$ref);
    const mapping = (schema.discriminator as { mapping: Record<string, string> }).mapping;
    expect(mapping.cat).toBe(branches[0]);
    expect(mapping.cat).not.toBe("Cat");
  });

  it("leaves a mapping value alone when it matches no hoisted branch", async () => {
    // apis.guru serves pre-bundled specs whose discriminator mappings
    // still name the `models/*.yml` files the bundle absorbed, so the
    // paths resolve to nothing. Reading them would turn a spec oddity
    // that had always been inert into a fatal load error.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            components: {
              schemas: {
                Thing: {
                  anyOf: [{ type: "object", properties: { type: { const: "a" } } }],
                  discriminator: { propertyName: "type", mapping: { a: "models/gone.yml" } },
                },
              },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const disc = (
      document as unknown as {
        components: { schemas: { Thing: { discriminator: { mapping: Record<string, string> } } } };
      }
    ).components.schemas.Thing.discriminator;
    expect(disc.mapping.a).toBe("models/gone.yml");
  });
});
