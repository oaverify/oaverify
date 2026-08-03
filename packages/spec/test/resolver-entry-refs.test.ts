import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileReader, createMemoryReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";

/**
 * References whose target is the entry document (#612).
 *
 * A `$ref` naming a file is not automatically external: if it resolves
 * to the entry, the target already has an address in the resolved
 * document. Hoisting one anyway stored the schema twice and left the
 * author's own component unreferenced, which `unused-component` then
 * reported.
 *
 * The identity test is string equality of the resolved reader key, so
 * these cases fix both what it answers and what it declines to answer.
 */

const schemas = (document: unknown): string[] =>
  Object.keys(
    (document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {},
  );

const at = (document: unknown, pointer: string): unknown =>
  pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/")],
      document,
    );

function entryOnly(ref: string): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "main.json",
      {
        openapi: "3.1.0",
        info: { title: "X", version: "1" },
        paths: {
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: { $ref: ref } } },
                },
              },
            },
          },
        },
        components: { schemas: { Pet: { type: "object" } } },
      },
    ],
  ]);
}

const PET_POINTER = "/paths/~1pets/get/responses/200/content/application~1json/schema" as const;

describe("a schema ref whose target is the entry document", () => {
  it("keeps the author's component instead of hoisting a second copy", async () => {
    const reader = createMemoryReader(entryOnly("./main.json#/components/schemas/Pet"));
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    expect(schemas(document)).toEqual(["Pet"]);
    expect(at(document, PET_POINTER)).toEqual({ $ref: "#/components/schemas/Pet" });
  });

  it("answers the same for the bare and ./-prefixed spellings of the entry", async () => {
    const sources = entryOnly("./main.json#/components/schemas/Pet");
    sources.set("./main.json", sources.get("main.json"));
    for (const entry of ["main.json", "./main.json"]) {
      const { document } = await resolveSpec({ reader: createMemoryReader(sources), entry });
      expect(schemas(document), entry).toEqual(["Pet"]);
    }
  });

  it("reaches back into the entry from another document without duplicating", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/pets": { $ref: "./paths/pets.json" } },
            components: { schemas: { Pet: { type: "object" } } },
          },
        ],
        [
          "paths/pets.json",
          {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "../main.json#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    expect(schemas(document)).toEqual(["Pet"]);
    expect(at(document, PET_POINTER)).toEqual({ $ref: "#/components/schemas/Pet" });
  });

  it("stops the duplication cascading through the component graph", async () => {
    // Three components in, three out. The hoisted copy of `Pet` used to
    // be walked as if it belonged to an external document, so its own
    // internal refs re-rooted there and duplicated `Cat` and `Dog` in
    // turn. Asserting the count is what proves the fix sits at the top
    // of the cascade rather than downstream of it.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/pets": { $ref: "./paths/pets.json" } },
            components: {
              schemas: {
                Pet: {
                  oneOf: [
                    { $ref: "#/components/schemas/Cat" },
                    { $ref: "#/components/schemas/Dog" },
                  ],
                  discriminator: {
                    propertyName: "kind",
                    mapping: {
                      cat: "#/components/schemas/Cat",
                      dog: "#/components/schemas/Dog",
                    },
                  },
                },
                Cat: { type: "object", required: ["meow"] },
                Dog: { type: "object", required: ["bark"] },
              },
            },
          },
        ],
        [
          "paths/pets.json",
          {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "../main.json#/components/schemas/Pet" },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    expect(schemas(document)).toEqual(["Pet", "Cat", "Dog"]);
    expect(at(document, "/components/schemas/Pet/discriminator/mapping")).toEqual({
      cat: "#/components/schemas/Cat",
      dog: "#/components/schemas/Dog",
    });
  });

  it("does not duplicate a schema reached through an inlined entry component", async () => {
    // The non-schema half of the same defect. `PageSize` is inlined at
    // the use site by design, and the walk continues into it carrying
    // the entry as its source document, so its plain internal `$ref`
    // took the same hoisting path.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/pets": { $ref: "./paths/pets.json" } },
            components: {
              parameters: {
                PageSize: {
                  name: "pageSize",
                  in: "query",
                  schema: { $ref: "#/components/schemas/Size" },
                },
              },
              schemas: { Size: { type: "integer" } },
            },
          },
        ],
        [
          "paths/pets.json",
          {
            get: {
              parameters: [{ $ref: "../main.json#/components/parameters/PageSize" }],
              responses: { "200": { description: "ok" } },
            },
          },
        ],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    expect(schemas(document)).toEqual(["Size"]);
    expect(at(document, "/paths/~1pets/get/parameters/0")).toEqual({
      name: "pageSize",
      in: "query",
      schema: { $ref: "#/components/schemas/Size" },
    });
  });
});

describe("an internal ref inside content inlined from the entry", () => {
  const docs = () =>
    new Map<string, unknown>([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info: { title: "X", version: "1" },
          paths: { "/pets": { $ref: "./paths/pets.json" } },
          components: {
            headers: { H: { description: "h", schema: { type: "string" } } },
            responses: {
              Ok: { description: "ok", headers: { X: { $ref: "#/components/headers/H" } } },
            },
          },
        },
      ],
      [
        "paths/pets.json",
        { get: { responses: { "200": { $ref: "../main.json#/components/responses/Ok" } } } },
      ],
    ]);

  it("keeps the ref as written rather than stitching a copy of the entry", async () => {
    const { document } = await resolveSpec({
      reader: createMemoryReader(docs()),
      entry: "main.json",
    });
    expect(Object.keys(document as unknown as Record<string, unknown>)).not.toContain(
      "x-oaverify-externals",
    );
    expect(at(document, "/paths/~1pets/get/responses/200/headers/X")).toEqual({
      $ref: "#/components/headers/H",
    });
  });
});

describe("what the entry-identity test declines to answer", () => {
  it("still hoists a different document with the same file name", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "a/main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/pets": {
                get: {
                  responses: {
                    "200": {
                      description: "ok",
                      content: {
                        "application/json": {
                          schema: { $ref: "../b/main.json#/components/schemas/Pet" },
                        },
                      },
                    },
                  },
                },
              },
            },
            components: { schemas: { Pet: { type: "object", title: "mine" } } },
          },
        ],
        ["b/main.json", { components: { schemas: { Pet: { type: "object", title: "theirs" } } } }],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "a/main.json" });
    expect(schemas(document)).toHaveLength(2);
    const hoisted = schemas(document).find((name) => name !== "Pet");
    expect(at(document, `/components/schemas/${hoisted}`)).toMatchObject({ title: "theirs" });
    expect(at(document, "/components/schemas/Pet")).toMatchObject({ title: "mine" });
  });

  it("still hoists a ref to the entry with no fragment", async () => {
    // The target is the whole OpenAPI document rather than a Schema
    // Object with an address, so it keeps a name of its own. Excluded
    // deliberately: `$ref: "#"` in a schema position is a claim about
    // root self-reference that this fix does not make.
    const reader = createMemoryReader(entryOnly("./main.json"));
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    expect(schemas(document)).toEqual(["Pet", "main"]);
    expect(at(document, PET_POINTER)).toEqual({ $ref: "#/components/schemas/main" });
  });

  it("still rejects a ref to the entry by a non-pointer fragment", async () => {
    // `#Pet` is an `$anchor` lookup, and the hoisting path resolves
    // fragments as JSON pointers. Unchanged: an anchor was an error
    // before this and stays one, rather than quietly becoming an
    // internal ref to an address that does not exist.
    const reader = createMemoryReader(entryOnly("./main.json#Pet"));
    await expect(resolveSpec({ reader, entry: "main.json" })).rejects.toThrow(
      "invalid JSON pointer: Pet",
    );
  });

  it("still stitches a cycle between two documents that are not the entry", async () => {
    // Path Item -> Operation -> Callback -> Path Item, none of them the
    // entry. An entry-identity test that generalised to "any document
    // seen already" would collapse this.
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/a": { $ref: "path-item.json" } },
          },
        ],
        [
          "path-item.json",
          {
            get: {
              operationId: "a",
              responses: { "200": { description: "ok" } },
              callbacks: { onEvent: { $ref: "callback.json" } },
            },
          },
        ],
        ["callback.json", { "{$request.body#/url}": { $ref: "path-item.json" } }],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });
    const bucket = (document as unknown as Record<string, unknown>)["x-oaverify-externals"];
    expect(Object.keys(bucket as Record<string, unknown>)).toContain("path-item.json");
  });
});

describe("entry spellings that reach the filesystem", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-entry-"));
    mkdirSync(join(dir, "paths"));
    writeFileSync(
      join(dir, "main.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "X", version: "1" },
        paths: { "/pets": { $ref: "./paths/pets.json" } },
        components: { schemas: { Pet: { type: "object" } } },
      }),
    );
    writeFileSync(
      join(dir, "paths", "pets.json"),
      JSON.stringify({
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "../main.json#/components/schemas/Pet" } },
              },
            },
          },
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("agrees across bare, absolute and file:// entries", async () => {
    const entries = [
      { reader: createFileReader(dir), entry: "main.json" },
      { reader: createFileReader(dir), entry: join(dir, "main.json") },
      { reader: createFileReader(dir), entry: `file://${join(dir, "main.json")}` },
    ];
    for (const { reader, entry } of entries) {
      const { document } = await resolveSpec({ reader, entry });
      expect(schemas(document), entry).toEqual(["Pet"]);
      expect(at(document, PET_POINTER), entry).toEqual({ $ref: "#/components/schemas/Pet" });
    }
  });
});
