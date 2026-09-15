import { describe, expect, it } from "vitest";
import { createValidator } from "@oaverify/internal-validator";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkSpec } from "../src/check.js";
import {
  selectionForClasses,
  parseFindingTerms,
  resolveFindingSelection,
} from "../src/selection.js";

const document = (schemas: unknown = {}): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths: {},
    components: { schemas },
  }) as OpenAPIDocument;
const check = (doc: OpenAPIDocument) =>
  checkSpec({ document: doc } as never, {
    findings: selectionForClasses(["schema"]),
  });

describe("document schema compilation (#1047)", () => {
  it.each(["webhook", "callback", "component"])("reports malformed schemas in a %s", (position) => {
    const schema = { type: "string", pattern: "(?" };
    const doc = document(position === "component" ? { Bad: schema } : {});
    const operation = { requestBody: { content: { "application/json": { schema } } } };
    let pointer = "/components/schemas/Bad/pattern";
    if (position === "webhook") {
      doc.webhooks = { hook: { post: operation } };
      pointer = "/webhooks/hook/post/requestBody/content/application~1json/schema/pattern";
    } else if (position === "callback") {
      doc.components!.callbacks = { cb: { expression: { post: operation } } };
      pointer =
        "/components/callbacks/cb/expression/post/requestBody/content/application~1json/schema/pattern";
    }
    expect(check(doc)).toEqual([
      expect.objectContaining({ code: "malformed-schema", target: { pointer, anchor: "node" } }),
    ]);
    expect(createValidator(doc).precompile({ onMalformed: "collect" })).toEqual([]);
  });

  it("checks boolean and malformed root slots", () => {
    const findings = check(document({ True: true, False: false, Bad: null }));
    expect(findings.filter((f) => f.class === "malformed").map((f) => f.target?.pointer)).toEqual([
      "/components/schemas/Bad",
    ]);
    expect(findings.find((f) => f.class === "malformed")?.target?.anchor).toBe("node");
  });

  it("keeps composition context within each authored root", () => {
    expect(
      check(
        document({
          Good: { allOf: [{ properties: { x: { type: "string" } } }, { required: ["x"] }] },
        }),
      ).filter((f) => f.code === "required-not-defined"),
    ).toEqual([]);
  });

  it("preserves resource-local references and locates anchor targets", () => {
    const doc = document({
      A: { $id: "https://example.test/a", $ref: "b#target" },
      B: {
        $id: "https://example.test/b",
        $defs: { Inner: { $anchor: "target", type: "string", minLength: -1 } },
      },
      Good: {
        $id: "https://example.test/good",
        $defs: { Inner: { type: "string" } },
        $ref: "#/$defs/Inner",
      },
    });
    const findings = check(doc);
    expect(findings.filter((f) => f.class === "malformed")).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pointer: "/components/schemas/B/$defs/Inner/minLength" }),
      }),
    ]);
  });
});

it("executes referenced resources with dynamic scope and unevaluated tracking", async () => {
  const { documentSchemas } = await import("../src/document-schemas.js");
  const { compileSchemaInContext } = await import("@oaverify/internal-schema/internals");
  const root = {
    $id: "https://example.test/strict",
    $dynamicAnchor: "node",
    $ref: "tree",
    unevaluatedProperties: false,
  };
  const tree = {
    $id: "https://example.test/tree",
    $dynamicAnchor: "node",
    type: "object",
    properties: { children: { type: "array", items: { $dynamicRef: "#node" } } },
  };
  const inventory = documentSchemas(
    document({
      Root: root,
      Tree: tree,
      Unrelated: { $id: "https://example.test/unrelated", pattern: "(?" },
    }),
  );
  const compiled = compileSchemaInContext(
    root,
    { dialect: inventory.dialect, output: "predicate" },
    inventory.contextFor(root),
  );
  expect(compiled.validate({ children: [{}] })).toBe(true);
  expect(compiled.validate({ children: [{ extra: true }] })).toBe(false);
});

it("uses each referring resource's base URI in required lint", () => {
  const doc = document({
    A: {
      $id: "https://example.test/a",
      $defs: { X: { properties: { a: { type: "string" } } } },
      allOf: [{ $ref: "#/$defs/X" }, { required: ["a"] }],
    },
    B: {
      $id: "https://example.test/b",
      $defs: { X: { properties: { b: { type: "string" } } } },
      allOf: [{ $ref: "#/$defs/X" }, { required: ["b"] }],
    },
  });
  expect(check(doc).filter((f) => f.code === "silent-rewrite/required-not-in-properties")).toEqual(
    [],
  );
});

it("ignores schema-shaped data and OAS 3.0 discarded subtrees", () => {
  const doc = document({
    Base: { type: "string", examples: [{ properties: { x: { pattern: "(?" } } }] },
    Use: { $ref: "#/components/schemas/Base", $defs: { Bad: { pattern: "(?" } } },
  });
  doc.openapi = "3.0.3";
  expect(check(doc).filter((f) => f.class === "malformed")).toEqual([]);
});

it("keeps independent roots visible after a malformed root", () => {
  const findings = check(
    document({ Bad: { minLength: -1 }, Good: { type: "string", typo: true } }),
  );
  expect(findings.map((f) => f.code).sort()).toEqual(["malformed-schema", "unknown-keyword"]);
});

it.each(["$ref", "$dynamicRef"])(
  "locates malformed reference targets once through %s",
  (keyword) => {
    for (const bad of [null, [1], { items: null }, { pattern: "(?" }]) {
      const findings = check(
        document({ Use: { [keyword]: "#/components/schemas/Bad" }, Bad: bad }),
      );
      const malformed = findings.filter((f) => f.class === "malformed");
      expect(malformed).toHaveLength(1);
      expect(malformed[0]?.target?.pointer).toMatch(
        /^\/components\/schemas\/Bad(?:\/(items|pattern))?$/,
      );
    }
  },
);

it("counts each recursive authored entry once", () => {
  const findings = check(
    document({
      A: { type: "object", typo: true, properties: { child: { $ref: "#/components/schemas/A" } } },
    }),
  );
  expect(findings.filter((f) => f.code === "unknown-keyword")).toEqual([
    expect.not.objectContaining({ occurrences: expect.anything() }),
  ]);
});

it("includes dynamic overrides from reachable resources in the compile closure", async () => {
  const { documentSchemas } = await import("../src/document-schemas.js");
  const { compileSchemaInContext } = await import("@oaverify/internal-schema/internals");
  const root = { $dynamicRef: "https://example.test/base#node" };
  const doc = document({
    Root: root,
    Base: { $id: "https://example.test/base", $dynamicAnchor: "node", type: "object" },
    Override: { $dynamicAnchor: "node", unevaluatedProperties: false },
  });
  const inventory = documentSchemas(doc);
  const compiled = compileSchemaInContext(
    root,
    { dialect: inventory.dialect, output: "predicate" },
    inventory.contextFor(root),
  );
  expect(compiled.validate({ x: 1 })).toBe(false);
  doc.components!.schemas!.Override = { $dynamicAnchor: "node", pattern: "(?" };
  expect(check(doc).filter((f) => f.class === "malformed")).toEqual([
    expect.objectContaining({
      target: expect.objectContaining({ pointer: "/components/schemas/Override/pattern" }),
      message: expect.stringContaining("components.schemas.Override"),
    }),
  ]);
});

it("follows dynamic references for composition and independent lint findings", () => {
  const target = { properties: { x: { type: "string" } }, typo: true };
  const doc = document({
    Use: {
      allOf: [{ $dynamicRef: "#/components/schemas/Container/$defs/Good" }, { required: ["x"] }],
    },
    Container: { $defs: { Good: target, Bad: { minLength: -1 } } },
  });
  const findings = check(doc);
  expect(findings.filter((f) => f.code === "silent-rewrite/required-not-in-properties")).toEqual(
    [],
  );
  expect(findings.find((f) => f.code === "unknown-keyword")?.target?.pointer).toBe(
    "/components/schemas/Container/$defs/Good",
  );
});

it("includes dynamic reference declarations in closed composition analysis", () => {
  const findings = check(
    document({
      Use: { additionalProperties: false, $dynamicRef: "#/components/schemas/Target" },
      Target: { properties: { x: { type: "string" } }, required: ["x"] },
    }),
  );
  expect(findings.some((f) => f.code === "unsatisfiable/composed-properties")).toBe(true);
});

it("keeps unresolved unused dynamic references from becoming lint failures", () => {
  expect(check(document({ A: { $defs: { unused: { $dynamicRef: "#missing" } } } }))).toEqual([]);
});

it("withholds closed-composition conclusions across different dynamic bindings", () => {
  const findings = check(
    document({
      Root: {
        additionalProperties: false,
        properties: { y: { type: "number" } },
        $dynamicRef: "https://example.test/base#node",
      },
      Base: {
        $id: "https://example.test/base",
        $dynamicAnchor: "node",
        properties: { x: { type: "string" } },
      },
      Override: { $dynamicAnchor: "node", properties: { y: { type: "number" } } },
    }),
  );
  expect(findings.filter((f) => f.code === "unsatisfiable/composed-properties")).toEqual([]);
});

it("renders cached diagnostics with each operation's label and schema-relative suffix", async () => {
  const { checkDocumentSchemas } = await import("../src/document-schemas.js");
  const doc = document({ Shared: { properties: { value: { typo: true } } } });
  const schema = { $ref: "#/components/schemas/Shared" };
  doc.paths = {
    "/a": { post: { requestBody: { content: { "application/json": { schema } } } } },
    "/b": {
      get: {
        responses: { "200": { description: "ok", content: { "application/json": { schema } } } },
      },
    },
  };
  const findings = [...checkDocumentSchemas(doc)].filter((f) => f.code === "unknown-keyword");
  expect(findings.map((f) => f.location)).toEqual([
    "POST /a request body (application/json) -> properties.value",
    "GET /b 200 response body (application/json) -> properties.value",
    "/components/schemas/Shared -> properties.value",
  ]);
  expect(new Set(findings.map((f) => f.target?.pointer))).toEqual(
    new Set(["/components/schemas/Shared/properties/value"]),
  );
});

it("prefixes cached malformed messages with their own operation labels", async () => {
  const { checkDocumentSchemas } = await import("../src/document-schemas.js");
  const doc = document({ Shared: { items: 7 } });
  const schema = { $ref: "#/components/schemas/Shared" };
  doc.paths = {
    "/a": { get: { parameters: [{ in: "query", name: "filter", schema }] } },
    "/b": { post: { requestBody: { content: { "application/json": { schema } } } } },
  };
  const findings = [...checkDocumentSchemas(doc)];
  expect(findings[0]).toMatchObject({
    location: 'GET /a query parameter "filter"',
    message: expect.stringContaining('GET /a query parameter "filter": '),
  });
  expect(findings[1]).toMatchObject({
    location: "POST /b request body (application/json)",
    message: expect.stringContaining("POST /b request body (application/json): "),
  });
  expect(findings[1]!.message).not.toContain("GET /a");
});

it("isolates cyclic authored schemas when building the document inventory", () => {
  const schema: Record<string, unknown> = { type: "object" };
  schema.properties = { child: schema };
  const doc = document({ Independent: { typo: true } });
  doc.paths = {
    "/a": {
      post: { requestBody: { content: { "application/json": { schema: schema as never } } } },
    },
  };
  const findings = check(doc);
  expect(findings).toContainEqual(
    expect.objectContaining({
      class: "malformed",
      location: "POST /a request body (application/json)",
      target: {
        pointer: "/paths/~1a/post/requestBody/content/application~1json/schema",
        anchor: "node",
      },
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: "unknown-keyword",
      target: expect.objectContaining({ pointer: "/components/schemas/Independent" }),
    }),
  );
});

it("labels referenced request bodies and parameters by their first operation use", async () => {
  const { checkDocumentSchemas } = await import("../src/document-schemas.js");
  const doc = document();
  doc.components!.requestBodies = {
    Body: { content: { "application/json": { schema: { items: 7 } as never } } },
  };
  doc.components!.parameters = {
    P: { in: "query", name: "filter", schema: { typo: true } as never },
  };
  doc.paths = {
    "/a": {
      post: {
        parameters: [{ $ref: "#/components/parameters/P" }],
        requestBody: { $ref: "#/components/requestBodies/Body" },
      },
    },
  };
  const findings = [...checkDocumentSchemas(doc)];
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: "unknown-keyword",
      location: 'POST /a query parameter "filter" -> <root>',
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({
      class: "malformed",
      location: "POST /a request body (application/json)",
      target: expect.objectContaining({
        pointer: "/components/requestBodies/Body/content/application~1json/schema/items",
      }),
    }),
  );
});

it("collects failures in deeply nested roots and their references", () => {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 4000; i++) schema = { items: schema };
  const doc = document({ Deep: schema, Independent: { typo: true } });
  doc.paths = {
    "/a": {
      post: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Deep" } } },
        },
      },
    },
  };
  const findings = checkSpec({ document: doc } as never, {
    findings: resolveFindingSelection(parseFindingTerms("unknown-keyword")),
  });
  expect(findings).toContainEqual(expect.objectContaining({ class: "malformed" }));
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: "unknown-keyword",
      target: expect.objectContaining({ pointer: "/components/schemas/Independent" }),
    }),
  );
});
