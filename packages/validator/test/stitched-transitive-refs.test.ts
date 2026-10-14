import { createMemoryReader, resolveSpec, sourceOf } from "@oaverify/internal-spec";
import { resolveSpecSync } from "@oaverify/internal-spec/internals";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "./fixtures.js";

/**
 * A non-schema reference into a full external OpenAPI document: the
 * stitched copy's own references must keep naming that document (#1101).
 */
const entry = {
  openapi: "3.1.0",
  info: { title: "entry", version: "1" },
  paths: {
    "/p": {
      get: { responses: { "200": { $ref: "b.json#/components/responses/Ok" } } },
    },
  },
  components: { schemas: { Cat: { type: "string", const: "entry" } } },
};
const b = {
  openapi: "3.1.0",
  info: { title: "b", version: "1" },
  paths: {},
  components: {
    responses: {
      Ok: { description: "ok", headers: { H: { $ref: "#/components/headers/H" } } },
    },
    headers: { H: { schema: { $ref: "#/components/schemas/Cat" } } },
    schemas: { Cat: { type: "string", const: "external" } },
  },
};

const files = (extra: Array<[string, unknown]> = []) =>
  new Map<string, unknown>([["entry.json", entry], ["b.json", b], ...extra]);

const resolvers = {
  async: (m: Map<string, unknown>) =>
    resolveSpec({ reader: createMemoryReader(m), entry: "entry.json" }),
  sync: async (m: Map<string, unknown>) =>
    resolveSpecSync({
      reader: {
        canRead: (uri: string) => m.has(uri),
        read: (uri: string) => structuredClone(m.get(uri)),
      },
      entry: "entry.json",
    }),
};

/** The value at `keys` under `value`, or undefined. */
function at(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function headerVerdict(document: OpenAPIDocument, value: string): boolean {
  const v = createValidator(document);
  return (
    v.validateResponse({ method: "GET", path: "/p" }, { status: 200, headers: { H: value } }) ===
    null
  );
}

describe("stitched external documents keep their own references (#1101)", () => {
  for (const [name, resolve] of Object.entries(resolvers)) {
    it(`validates the header against the external Cat (${name})`, async () => {
      const { document } = await resolve(files());
      expect(headerVerdict(document, "external")).toBe(true);
      expect(headerVerdict(document, "entry")).toBe(false);
    });
  }
});

describe("stitched fragments: names, mappings, chains and parity (#1101)", () => {
  const run = async (m: Map<string, unknown>) => {
    const a = await resolvers.async(m);
    const s = await resolvers.sync(m);
    expect(s.document).toEqual(a.document);
    return a.document;
  };

  it("hoists the external schema beside a colliding entry name, under a name of its own", async () => {
    const document = await run(files());
    const schemas = Object.keys(document.components?.schemas ?? {});
    expect(schemas).toContain("Cat");
    expect(schemas).toHaveLength(2);
    const stitched = at(document, "x-oaverify-externals", "b.json");
    const ref = at(stitched, "components", "headers", "H", "schema", "$ref");
    expect(ref).toMatch(/^#\/components\/schemas\//);
    expect(ref).not.toBe("#/components/schemas/Cat");
    // Only the referenced fragments are stitched, not the whole file.
    expect(Object.keys(stitched as object)).toEqual(["components"]);
    expect(Object.keys(at(stitched, "components") as object)).toEqual(["headers"]);
  });

  it("works when the entry declares no components at all", async () => {
    const bare = { ...entry, components: undefined };
    const document = await run(
      new Map<string, unknown>([
        ["entry.json", JSON.parse(JSON.stringify(bare))],
        ["b.json", b],
      ]),
    );
    expect(headerVerdict(document, "external")).toBe(true);
    expect(headerVerdict(document, "entry")).toBe(false);
  });

  it("follows a header chain inside one stitched document", async () => {
    const chained = structuredClone(b) as unknown as {
      components: { headers: Record<string, unknown> };
    };
    chained.components.headers.H = { $ref: "#/components/headers/H2" };
    chained.components.headers.H2 = { schema: { $ref: "#/components/schemas/Cat" } };
    const document = await run(files().set("b.json", chained));
    expect(headerVerdict(document, "external")).toBe(true);
    expect(headerVerdict(document, "entry")).toBe(false);
  });

  it("rewrites a discriminator mapping found in stitched content", async () => {
    const withMapping = structuredClone(b) as unknown as {
      components: { headers: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    withMapping.components.headers.H = {
      content: {
        "application/json": {
          schema: {
            oneOf: [{ $ref: "#/components/schemas/Pet" }],
            discriminator: { propertyName: "kind", mapping: { pet: "#/components/schemas/Pet" } },
          },
        },
      },
    };
    withMapping.components.schemas.Pet = {
      type: "object",
      required: ["kind", "meow"],
      properties: { kind: { const: "pet" }, meow: { type: "integer" } },
    };
    const document = await run(files().set("b.json", withMapping));
    const v = createValidator(document);
    const send = (value: unknown) =>
      v.validateResponse(
        { method: "GET", path: "/p" },
        { status: 200, headers: { H: JSON.stringify(value) } },
      ) === null;
    expect(send({ kind: "pet", meow: 1 })).toBe(true);
    expect(send({ kind: "pet", meow: "x" })).toBe(false);
    const mapped = JSON.stringify(document).match(/"mapping":\{"pet":"([^"]+)"\}/)?.[1];
    expect(mapped).toMatch(/^#\/components\/schemas\//);
    expect(Object.keys(document.components?.schemas ?? {})).toContain(
      mapped?.slice("#/components/schemas/".length),
    );
  });
});

describe("fragment stitching: overlap, siblings, reachability and cycles (#1101)", () => {
  const openapi = { openapi: "3.1.0", info: { title: "entry", version: "1" } };
  const resolveBoth = async (m: Map<string, unknown>) => {
    const a = await resolveSpec({
      reader: createMemoryReader(m),
      entry: "entry.json",
      provenance: true,
    });
    const s = await resolvers.sync(m);
    expect(s.document).toEqual(a.document);
    return a;
  };

  // lib.json#/items/A is stitched (its callback returns to it), and its
  // header X is also referenced on its own from lib.json#/items/B.
  const lib = {
    items: {
      A: {
        get: {
          responses: {
            "200": { description: "ok", headers: { X: { schema: { $ref: "#/defs/Small" } } } },
          },
          callbacks: { cb: { "{$url}": { $ref: "#/items/A" } } },
        },
      },
      B: {
        get: {
          responses: {
            "200": {
              description: "ok",
              headers: { X: { $ref: "#/items/A/get/responses/200/headers/X" } },
            },
          },
        },
      },
    },
    defs: { Small: { type: "integer", maximum: 5 } },
  };
  const overlap = (first: "/a" | "/b") =>
    new Map<string, unknown>([
      [
        "entry.json",
        {
          ...openapi,
          paths:
            first === "/a"
              ? { "/a": { $ref: "lib.json#/items/A" }, "/b": { $ref: "lib.json#/items/B" } }
              : { "/b": { $ref: "lib.json#/items/B" }, "/a": { $ref: "lib.json#/items/A" } },
        },
      ],
      ["lib.json", lib],
    ]);

  it("gives the same result whether the ancestor or the descendant is stitched first", async () => {
    const ancestorFirst = await resolveBoth(overlap("/a"));
    const descendantFirst = await resolveBoth(overlap("/b"));
    expect(descendantFirst.document).toEqual(ancestorFirst.document);
    for (const { document, regions } of [ancestorFirst, descendantFirst]) {
      const v = createValidator(document);
      for (const path of ["/a", "/b"]) {
        const send = (x: string) =>
          v.validateResponse({ method: "GET", path }, { status: 200, headers: { X: x } }) === null;
        expect(send("3"), path).toBe(true);
        expect(send("9"), path).toBe(false);
      }
      expect(
        sourceOf(
          regions ?? [],
          "/x-oaverify-externals/lib.json/items/A/get/responses/200/headers/X",
        ),
      ).toMatchObject({ uri: "lib.json", pointer: "/items/A/get/responses/200/headers/X" });
    }
  });

  it("stitches several fragments and kinds of one document side by side", async () => {
    const m = new Map<string, unknown>([
      [
        "entry.json",
        {
          ...openapi,
          paths: {
            "/p": {
              get: {
                parameters: [{ $ref: "b.json#/components/parameters/Q" }],
                responses: { "200": { $ref: "b.json#/components/responses/Ok" } },
              },
            },
          },
        },
      ],
      [
        "b.json",
        {
          components: {
            parameters: {
              Q: { $ref: "#/components/parameters/Q2" },
              Q2: {
                name: "q",
                in: "query",
                required: true,
                schema: { $ref: "#/components/schemas/Num" },
              },
            },
            responses: {
              Ok: { description: "ok", headers: { H: { $ref: "#/components/headers/H" } } },
            },
            headers: { H: { schema: { $ref: "#/components/schemas/Num" } } },
            schemas: { Num: { type: "integer" } },
          },
        },
      ],
    ]);
    const { document } = await resolveBoth(m);
    expect(
      Object.keys(at(document, "x-oaverify-externals", "b.json", "components") as object).sort(),
    ).toEqual(["headers", "parameters"]);
    const v = createValidator(document);
    expect(v.validateRequest({ method: "GET", path: "/p", query: { q: "1" } })).toBeNull();
    expect(v.validateRequest({ method: "GET", path: "/p", query: { q: "x" } })).not.toBeNull();
    const send = (h: string) =>
      v.validateResponse({ method: "GET", path: "/p" }, { status: 200, headers: { H: h } }) ===
      null;
    expect(send("1")).toBe(true);
    expect(send("x")).toBe(false);
  });

  it("leaves unreferenced content of a stitched document alone, broken or not", async () => {
    const broken = structuredClone(b) as unknown as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    broken.paths["/elsewhere"] = { $ref: "missing-item.json" };
    broken.components.schemas.Broken = { $ref: "missing-schema.json" };
    // The reader has neither missing file, so reading one would throw.
    const { document } = await resolveBoth(files().set("b.json", broken));
    expect(JSON.stringify(document)).not.toContain("missing-");
    expect(headerVerdict(document, "external")).toBe(true);
  });

  it("terminates on a reference cycle across two documents", async () => {
    const m = new Map<string, unknown>([
      [
        "entry.json",
        {
          ...openapi,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": { description: "ok", headers: { X: { $ref: "a.json#/H" } } },
                },
              },
            },
          },
        },
      ],
      ["a.json", { H: { $ref: "c.json#/H" } }],
      ["c.json", { H: { $ref: "a.json#/H" } }],
    ]);
    const { document } = await resolveBoth(m);
    expect(at(document, "x-oaverify-externals", "a.json", "H")).toBeDefined();
    expect(() => createValidator(document).precompile()).toThrow(/32 hops/);
  });

  it("validates a stitched whole-file object and a stitched fragment alike", async () => {
    const item = {
      get: {
        parameters: [{ name: "n", in: "query", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
    };
    const wholeFile = {
      ...item,
      get: { ...item.get, callbacks: { cb: { "{$url}": { $ref: "item.json" } } } },
    };
    const fragment = {
      items: {
        A: {
          ...item,
          get: { ...item.get, callbacks: { cb: { "{$url}": { $ref: "#/items/A" } } } },
        },
      },
    };
    const whole = await resolveBoth(
      new Map<string, unknown>([
        ["entry.json", { ...openapi, paths: { "/q": { $ref: "item.json" } } }],
        ["item.json", wholeFile],
      ]),
    );
    const part = await resolveBoth(
      new Map<string, unknown>([
        ["entry.json", { ...openapi, paths: { "/q": { $ref: "lib.json#/items/A" } } }],
        ["lib.json", fragment],
      ]),
    );
    for (const { document } of [whole, part]) {
      const v = createValidator(document);
      expect(v.validateRequest({ method: "GET", path: "/q", query: { n: "1" } })).toBeNull();
      expect(v.validateRequest({ method: "GET", path: "/q", query: { n: "x" } })).not.toBeNull();
    }
    expect(at(whole.document, "x-oaverify-externals", "item.json", "get")).toBeDefined();
    expect(
      at(part.document, "x-oaverify-externals", "lib.json", "items", "A", "get"),
    ).toBeDefined();
  });
});

describe("fragment stitching: own kind under an ancestor, and the '/' fragment (#1101)", () => {
  const openapi = { openapi: "3.1.0", info: { title: "entry", version: "1" } };
  const entryCat = { Cat: { type: "string", const: "entry" } };
  const externalCat = { Cat: { type: "string", const: "external" } };
  const verdict = (document: OpenAPIDocument, path: string, value: string) =>
    createValidator(document).validateResponse(
      { method: "GET", path },
      { status: 200, headers: { H: value } },
    ) === null;

  // Outer holds the header under an `x-` field, which a Response walk does
  // not type; the header is referenced on its own as a Header.
  const lib = {
    components: {
      responses: {
        Wrap: { $ref: "#/components/responses/Outer" },
        Outer: {
          description: "outer",
          "x-header": { schema: { $ref: "#/components/schemas/Cat" } },
          headers: { H: { $ref: "#/components/responses/Outer/x-header" } },
        },
        Q: {
          description: "q",
          headers: { H: { $ref: "#/components/responses/Outer/x-header" } },
        },
      },
      schemas: externalCat,
    },
  };
  const docs = (paths: Record<string, unknown>) =>
    new Map<string, unknown>([
      ["entry.json", { ...openapi, paths, components: { schemas: entryCat } }],
      ["b.json", lib],
    ]);
  const op = (ref: string) => ({ get: { responses: { "200": { $ref: ref } } } });

  for (const [order, paths] of [
    [
      "ancestor first",
      { "/p": op("b.json#/components/responses/Wrap"), "/q": op("b.json#/components/responses/Q") },
    ],
    [
      "descendant first",
      { "/q": op("b.json#/components/responses/Q"), "/p": op("b.json#/components/responses/Wrap") },
    ],
  ] as const) {
    it(`walks a referenced fragment as its own kind under a stitched ancestor (${order})`, async () => {
      for (const resolve of Object.values(resolvers)) {
        const { document } = await resolve(docs(paths));
        for (const path of ["/p", "/q"]) {
          expect(verdict(document, path, "external"), path).toBe(true);
          expect(verdict(document, path, "entry"), path).toBe(false);
        }
      }
    });
  }

  it("stitches a '#/' reference at the empty-string key, not the whole document", async () => {
    const withEmptyKey = {
      "": { schema: { $ref: "#/components/schemas/Cat" } },
      components: {
        responses: { Ok: { description: "ok", headers: { H: { $ref: "#/" } } } },
        schemas: externalCat,
      },
    };
    const m = new Map<string, unknown>([
      [
        "entry.json",
        {
          ...openapi,
          paths: { "/p": op("b.json#/components/responses/Ok") },
          components: { schemas: entryCat },
        },
      ],
      ["b.json", withEmptyKey],
    ]);
    for (const resolve of Object.values(resolvers)) {
      const { document } = await resolve(m);
      expect(JSON.stringify(document)).toContain('"#/x-oaverify-externals/b.json/"');
      expect(verdict(document, "/p", "external")).toBe(true);
      expect(verdict(document, "/p", "entry")).toBe(false);
    }
  });
});

describe("fragment stitching keeps arrays it descends through (#1101)", () => {
  const openapi = { openapi: "3.1.0", info: { title: "entry", version: "1" } };
  // items/A is stitched by its own callback; its first parameter is also
  // referenced on its own from items/B.
  const lib = {
    items: {
      A: {
        parameters: [
          { name: "first", in: "query", required: true, schema: { type: "integer" } },
          { name: "second", in: "query", required: true, schema: { type: "integer" } },
        ],
        get: {
          responses: { "200": { description: "ok" } },
          callbacks: { cb: { "{$url}": { $ref: "#/items/A" } } },
        },
      },
      B: {
        parameters: [{ $ref: "#/items/A/parameters/0" }],
        get: { responses: { "200": { description: "ok" } } },
      },
    },
  };
  const docs = (first: "/a" | "/b") =>
    new Map<string, unknown>([
      [
        "entry.json",
        {
          ...openapi,
          paths:
            first === "/a"
              ? { "/a": { $ref: "lib.json#/items/A" }, "/b": { $ref: "lib.json#/items/B" } }
              : { "/b": { $ref: "lib.json#/items/B" }, "/a": { $ref: "lib.json#/items/A" } },
        },
      ],
      ["lib.json", lib],
    ]);

  for (const first of ["/a", "/b"] as const) {
    it(`keeps every parameter of a stitched array (${first} first)`, async () => {
      for (const resolve of Object.values(resolvers)) {
        const { document } = await resolve(docs(first));
        const params = at(document, "x-oaverify-externals", "lib.json", "items", "A", "parameters");
        expect(Array.isArray(params)).toBe(true);
        expect((params as Array<{ name: string }>).map((p) => p.name)).toEqual(["first", "second"]);
        const v = createValidator(document);
        const send = (path: string, query: Record<string, string>) =>
          v.validateRequest({ method: "GET", path, query }) === null;
        expect(send("/a", { first: "1", second: "2" })).toBe(true);
        expect(send("/a", { first: "1" })).toBe(false);
        expect(send("/b", { first: "1" })).toBe(true);
        expect(send("/b", { first: "x" })).toBe(false);
      }
    });
  }
});
