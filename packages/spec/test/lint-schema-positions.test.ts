import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";
import { createMemoryReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

function minimalSpec(overrides: Record<string, unknown>): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Positions", version: "1" },
    paths: {},
    ...overrides,
  } as OpenAPIDocument;
}

describe("unreachable-defs schema positions", () => {
  it.each(["3.0.3", "3.1.0", "3.2.0"])("retains nested schema definitions under %s", (openapi) => {
    const dead = { $defs: { "unused/name": false } };
    const spec = minimalSpec({
      openapi,
      components: {
        schemas: {
          Root: {
            allOf: [dead],
            properties: { "x-member": dead },
            dependencies: { trigger: dead, names: ["other"] },
          },
        },
      },
    });
    expect(
      lintResolvedSpec(spec)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual([
      "/components/schemas/Root/allOf/0/$defs/unused~1name",
      "/components/schemas/Root/properties/x-member/$defs/unused~1name",
      "/components/schemas/Root/dependencies/trigger/$defs/unused~1name",
    ]);
  });

  it("reaches OpenAPI 3.2 item schemas and encoding header schemas", () => {
    const dead = { $defs: { Unused: {} } };
    const spec = minimalSpec({
      openapi: "3.2.0",
      components: {
        mediaTypes: {
          Items: {
            itemSchema: dead,
            prefixEncoding: [{ headers: { H: { schema: dead } } }],
            itemEncoding: { headers: { H: { schema: dead } } },
          },
        },
      },
    });
    expect(
      lintResolvedSpec(spec)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual([
      "/components/mediaTypes/Items/itemSchema/$defs/Unused",
      "/components/mediaTypes/Items/prefixEncoding/0/headers/H/schema/$defs/Unused",
      "/components/mediaTypes/Items/itemEncoding/headers/H/schema/$defs/Unused",
    ]);
  });

  it("does not interpret extension entries in OpenAPI containers", () => {
    const response = {
      description: "data",
      content: { "application/json": { schema: { $defs: { Data: {} } } } },
    };
    const spec = minimalSpec({
      paths: {
        "x-data": { get: { responses: { "200": response } } },
        "/x": { get: { responses: { "x-data": response } } },
      },
    });
    expect(lintResolvedSpec(spec).filter((i) => i.code === "unreachable-defs")).toEqual([]);
  });

  it.each(["$ref", "$dynamicRef"])(
    "follows %s into otherwise ordinary data without duplicating findings",
    (ref) => {
      const spec = minimalSpec({
        components: {
          schemas: {
            A: { [ref]: "#/x-schema" },
            B: { [ref]: "#/x-schema" },
            Missing: { $ref: "#/missing" },
          },
        },
        "x-schema": { $defs: { Dead: {} }, properties: { recursive: { $ref: "#/x-schema" } } },
      });
      expect(
        lintResolvedSpec(spec)
          .filter((i) => i.code === "unreachable-defs")
          .map((i) => i.pointer),
      ).toEqual(["/x-schema/$defs/Dead"]);
    },
  );

  it.each(["$ref", "$dynamicRef"])("resolves %s within its schema resource", (ref) => {
    const spec = minimalSpec({
      components: {
        schemas: {
          Root: {
            $id: "https://example.com/root",
            [ref]: "#/x-schema",
            "x-schema": { $defs: { Actual: {} } },
          },
        },
      },
      "x-schema": { $defs: { Data: {} } },
    });
    expect(
      lintResolvedSpec(spec)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual(["/components/schemas/Root/x-schema/$defs/Actual"]);
  });

  it("retains a target's lexical resource when reached through a document pointer", () => {
    const spec = minimalSpec({
      components: {
        schemas: {
          First: { $ref: "#/components/schemas/Root/$defs/Target" },
          Root: {
            $id: "https://example.com/root",
            $defs: { Target: { $ref: "#/x-schema" } },
            "x-schema": { $defs: { Actual: {} } },
          },
        },
      },
      "x-schema": { $defs: { Data: {} } },
    });
    expect(
      lintResolvedSpec(spec)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual(["/components/schemas/Root/x-schema/$defs/Actual"]);
  });

  it.each([false, true])(
    "retains schema definitions in stitched cycles (sync=%s)",
    async (sync) => {
      const files = new Map<string, unknown>([
        ["entry.json", minimalSpec({ paths: { "/pets": { $ref: "path.json" } } })],
        [
          "path.json",
          {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $defs: { Dead: {} }, example: { $defs: { Data: 1 } } },
                    },
                  },
                },
              },
              callbacks: { again: { "{$request.query.url}": { $ref: "path.json" } } },
            },
          },
        ],
      ]);
      const result = sync
        ? resolveSpecSync({
            entry: "entry.json",
            reader: { canRead: (uri) => files.has(uri), read: (uri) => files.get(uri) },
          })
        : await resolveSpec({ entry: "entry.json", reader: createMemoryReader(files) });
      const pointers = lintResolvedSpec(result.document, result)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer);
      expect(
        pointers.some((p) => p.startsWith("/x-oaverify-externals/") && p.endsWith("/$defs/Dead")),
      ).toBe(true);
      expect(pointers.every((p) => p.endsWith("/$defs/Dead"))).toBe(true);
    },
  );

  it("ignores definition-shaped example, default and extension data", () => {
    const payload = { $defs: { ordinary: 1 }, schema: { $defs: { disguised: {} } } };
    const spec = minimalSpec({
      "x-data": payload,
      components: {
        schemas: {
          S: {
            example: payload,
            examples: [payload],
            default: payload,
            enum: [payload],
            const: payload,
            "x-data": payload,
            $defs: { Dead: { type: "string" } },
          },
        },
        examples: { Example: { value: payload } },
      },
    });
    expect(lintResolvedSpec(spec).filter((i) => i.code === "unreachable-defs")).toMatchObject([
      { pointer: "/components/schemas/S/$defs/Dead" },
    ]);
  });
});

it.each([false, true])(
  "discovers reference-reached resources independently of order (reverse=%s)",
  (reverse) => {
    const entries = [
      ["First", { $ref: "#/x-resource/$defs/Target" }],
      ["Second", { $ref: "#/x-alias" }],
    ];
    if (reverse) entries.reverse();
    const spec = minimalSpec({
      components: { schemas: Object.fromEntries(entries) },
      "x-alias": { $ref: "#/x-resource" },
      "x-resource": {
        $id: "https://example.com/root",
        $defs: { Target: { $ref: "#/x-schema" } },
        "x-schema": { $defs: { Actual: {} } },
      },
      "x-schema": { $defs: { Data: {} } },
    });
    expect(
      lintResolvedSpec(spec)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual(["/x-resource/x-schema/$defs/Actual"]);
  },
);

it("does not treat an id in an unreferenced data ancestor as a resource", () => {
  const spec = minimalSpec({
    components: { schemas: { S: { $ref: "#/x-data/schema" } } },
    "x-data": {
      $id: "https://example.com/data",
      schema: { $ref: "#/x-target" },
      "x-target": { $defs: { Data: {} } },
    },
    "x-target": { $defs: { Actual: {} } },
  });
  expect(
    lintResolvedSpec(spec)
      .filter((i) => i.code === "unreachable-defs")
      .map((i) => i.pointer),
  ).toEqual(["/x-target/$defs/Actual"]);
});

it("withholds positions whose resource interpretation oscillates", () => {
  const spec = minimalSpec({
    components: {
      schemas: { S: { $ref: "#/x-resource/$defs/Target" }, Control: { $defs: { Dead: {} } } },
    },
    "x-resource": {
      $id: "https://example.com/root",
      $defs: { Target: { $ref: "#/x-resource" }, Ambiguous: {} },
    },
  });
  expect(
    lintResolvedSpec(spec)
      .filter((i) => i.code === "unreachable-defs")
      .map((i) => i.pointer),
  ).toEqual(["/components/schemas/Control/$defs/Dead"]);
});

it("preserves physical declaration order after following a schema ref", () => {
  const spec = minimalSpec({
    "x-schema": { $defs: { First: {} } },
    components: { schemas: { S: { $ref: "#/x-schema", $defs: { Second: {} } } } },
  });
  expect(
    lintResolvedSpec(spec)
      .filter((i) => i.code === "unreachable-defs")
      .map((i) => i.pointer),
  ).toEqual(["/x-schema/$defs/First", "/components/schemas/S/$defs/Second"]);
});

it("treats x-prefixed media type names as content entries", () => {
  const spec = minimalSpec({
    paths: {
      "/x": {
        post: {
          requestBody: { content: { "x-private/json": { schema: { $defs: { Dead: {} } } } } },
        },
      },
    },
  });
  expect(
    lintResolvedSpec(spec)
      .filter((i) => i.code === "unreachable-defs")
      .map((i) => i.pointer),
  ).toEqual(["/paths/~1x/post/requestBody/content/x-private~1json/schema/$defs/Dead"]);
});

describe("reachability reads a fragment against the enclosing $id", () => {
  const body = {
    "/a": {
      post: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Outer" } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  };
  const codes = (spec: OpenAPIDocument, code: string): string[] =>
    lintResolvedSpec(spec)
      .filter((i) => i.code === code)
      .map((i) => i.pointer);
  const outerSpec = (openapi = "3.1.0") =>
    minimalSpec({
      openapi,
      paths: body,
      components: {
        schemas: {
          Outer: {
            $id: "https://example.com/outer",
            $defs: { Inner: { type: "string" } },
            properties: {
              x: { $ref: "#/components/schemas/Unused" },
              y: { $ref: "#/$defs/Inner" },
            },
          },
          Unused: { type: "integer" },
        },
      },
    });

  it("counts a definition the fragment reaches inside the resource", () => {
    expect(codes(outerSpec(), "unreachable-defs")).toEqual([]);
  });

  it("does not count a document pointer written inside the resource", () => {
    expect(codes(outerSpec(), "unused-component")).toEqual(["/components/schemas/Unused"]);
  });

  it("keeps the document reading under OAS 3.0, which ignores $id", () => {
    const spec = outerSpec("3.0.3");
    expect(codes(spec, "unused-component")).toEqual([]);
    expect(codes(spec, "unreachable-defs")).toEqual(["/components/schemas/Outer/$defs/Inner"]);
  });

  it("uses the nearest of two nested resources", () => {
    const spec = minimalSpec({
      paths: body,
      components: {
        schemas: {
          Outer: {
            $id: "https://example.com/outer",
            $defs: { Dead: {}, Live: {} },
            properties: {
              a: { $ref: "#/$defs/Live" },
              nested: {
                $id: "https://example.com/nested",
                $defs: { Dead: {}, Near: {} },
                $ref: "#/$defs/Near",
              },
            },
          },
        },
      },
    });
    expect(codes(spec, "unreachable-defs")).toEqual([
      "/components/schemas/Outer/$defs/Dead",
      "/components/schemas/Outer/properties/nested/$defs/Dead",
    ]);
  });

  it("does not take scope from an $id in data", () => {
    const spec = minimalSpec({
      paths: body,
      components: {
        schemas: {
          Outer: {
            example: { $id: "https://example.com/data", value: { $ref: "#/components/schemas/T" } },
          },
          T: { type: "string" },
        },
      },
    });
    expect(codes(spec, "unused-component")).toEqual([]);
  });

  it("finds a referenced schema's resource when the fragment sits in a target", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          post: {
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Outer/$defs/Entry" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          Outer: {
            $id: "https://example.com/outer",
            $defs: { Entry: { $ref: "#/$defs/Inner" }, Inner: {} },
          },
        },
      },
    });
    expect(codes(spec, "unreachable-defs")).toEqual([]);
  });
  const schemasSpec = (schemas: Record<string, unknown>) =>
    minimalSpec({ paths: body, components: { schemas } });

  it("reads a fragment under a top-level empty $id against the document", () => {
    const spec = schemasSpec({
      Outer: { $id: "", $ref: "#/components/schemas/T" },
      T: { type: "string" },
    });
    expect(codes(spec, "unused-component")).toEqual([]);
  });

  it('reads a fragment under a top-level $id "#" against that schema', () => {
    const spec = schemasSpec({
      Outer: { $id: "#", $ref: "#/components/schemas/T" },
      T: { type: "string" },
    });
    expect(codes(spec, "unused-component")).toEqual(["/components/schemas/T"]);
  });

  it.each(["", "#"])("reads a fragment under a nested $id %j against that schema", (id) => {
    const spec = schemasSpec({
      Outer: {
        $id: "https://example.com/outer",
        properties: { x: { $id: id, $defs: { Inner: { type: "string" } }, $ref: "#/$defs/Inner" } },
      },
    });
    expect(codes(spec, "unreachable-defs")).toEqual([]);
  });

  it("reads a $ref in data under $id against the document", () => {
    const spec = schemasSpec({
      Outer: { $id: "urn:example:root", example: { $ref: "#/components/schemas/T" } },
      T: { type: "string" },
    });
    expect(codes(spec, "unused-component")).toEqual([]);
  });

  it("reads a Reference Object under a schema extension against the document", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Outer" } } },
            },
            responses: { "200": { $ref: "#/components/schemas/Outer/x-response" } },
          },
        },
      },
      components: {
        schemas: {
          Outer: { $id: "urn:example:root", "x-response": { $ref: "#/components/responses/R" } },
        },
        responses: { R: { description: "OK" } },
      },
    });
    expect(codes(spec, "unused-component")).toEqual([]);
  });
  // Any $ref in the document counts toward reachability, whether or not an
  // operation reaches it. A resource whose own fragments point inside it
  // therefore reaches itself, as a document pointer from inside it would.
  it("counts a resource's own fragments toward its definitions", () => {
    const spec = schemasSpec({
      Outer: {
        $defs: {
          Dead: {
            $id: "https://example.com/dead",
            $defs: { S: { type: "string" } },
            properties: { a: { $ref: "#/$defs/S" } },
          },
        },
      },
    });
    expect(codes(spec, "unreachable-defs")).toEqual([]);
  });
});
