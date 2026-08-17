import { describe, expect, it } from "vitest";
import { applyOverlays, type SpecOverlay } from "../src/overlay.js";
import type { DocumentReader, SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

/**
 * A spec may legitimately declare a property, a component, or a
 * discriminator branch named `__proto__`. Rebuilding a node with
 * `out[key] = value` fires the inherited setter for that key: no own
 * property is created, the node's prototype is replaced instead, and the
 * subschema the author wrote vanishes from the resolved document.
 *
 * Every fixture here is a raw JSON string on purpose. A JS object
 * literal `{ __proto__: {...} }` sets the prototype rather than creating
 * the key, so a fixture built that way tests nothing and passes whether
 * or not the bug is present.
 */

function readers(sources: Record<string, string>): {
  async: DocumentReader;
  sync: SyncDocumentReader;
} {
  const canRead = (uri: string): boolean => Object.hasOwn(sources, uri);
  const read = (uri: string): unknown => {
    const raw = sources[uri];
    if (raw === undefined) throw new Error(`no such source ${uri}`);
    return JSON.parse(raw);
  };
  return {
    async: { canRead, read: (uri) => Promise.resolve(read(uri)) },
    sync: { canRead, read },
  };
}

const PROPERTIES_SPEC = `{
  "openapi": "3.1.0",
  "info": { "title": "t", "version": "1" },
  "paths": {},
  "components": {
    "schemas": {
      "S": {
        "type": "object",
        "properties": { "__proto__": { "type": "string" }, "ok": { "type": "string" } }
      }
    }
  }
}`;

function propertiesOf(doc: unknown): Record<string, unknown> {
  const components = (doc as { components: { schemas: Record<string, unknown> } }).components;
  return (components.schemas["S"] as { properties: Record<string, unknown> }).properties;
}

function expectIntact(props: Record<string, unknown>): void {
  expect(Object.hasOwn(props, "__proto__")).toBe(true);
  expect(Object.keys(props)).toEqual(["__proto__", "ok"]);
  expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  expect(props["__proto__"]).toEqual({ type: "string" });
}

describe("a __proto__ key survives resolution", () => {
  it("resolveSpec keeps the subschema as an own property", async () => {
    const { async } = readers({ "main.json": PROPERTIES_SPEC });
    const out = await resolveSpec({ entry: "main.json", reader: async });
    expectIntact(propertiesOf(out.document));
  });

  it("resolveSpecSync keeps the subschema as an own property", () => {
    const { sync } = readers({ "main.json": PROPERTIES_SPEC });
    const out = resolveSpecSync({ entry: "main.json", reader: sync });
    expectIntact(propertiesOf(out.document));
  });

  it("survives being hoisted in from an external document", async () => {
    const { async } = readers({
      "main.json": `{
        "openapi": "3.1.0",
        "info": { "title": "t", "version": "1" },
        "paths": {},
        "components": { "schemas": { "S": { "$ref": "ext.json#/Thing" } } }
      }`,
      "ext.json": `{
        "Thing": {
          "type": "object",
          "properties": { "__proto__": { "type": "string" }, "ok": { "type": "string" } }
        }
      }`,
    });
    const out = await resolveSpec({ entry: "main.json", reader: async });
    const schemas = (out.document as { components: { schemas: Record<string, unknown> } })
      .components.schemas;
    const hoisted = Object.values(schemas).find(
      (s): s is { properties: Record<string, unknown> } =>
        typeof s === "object" && s !== null && "properties" in s,
    );
    expect(hoisted).toBeDefined();
    expectIntact(hoisted!.properties);
  });

  it("keeps a discriminator mapping branch named __proto__", async () => {
    const { async } = readers({
      "main.json": `{
        "openapi": "3.1.0",
        "info": { "title": "t", "version": "1" },
        "paths": {},
        "components": {
          "schemas": {
            "A": { "type": "object" },
            "P": {
              "oneOf": [{ "$ref": "#/components/schemas/A" }],
              "discriminator": {
                "propertyName": "kind",
                "mapping": { "__proto__": "#/components/schemas/A" }
              }
            }
          }
        }
      }`,
    });
    const out = await resolveSpec({ entry: "main.json", reader: async });
    const schemas = (
      out.document as unknown as { components: { schemas: Record<string, unknown> } }
    ).components.schemas;
    const mapping = (schemas["P"] as { discriminator: { mapping: object } }).discriminator.mapping;
    expect(Object.hasOwn(mapping, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
  });
});

describe("a __proto__ key survives an overlay merge", () => {
  it("keeps a component named __proto__ added by replaceSchemas", () => {
    const doc = JSON.parse(`{
      "openapi": "3.1.0",
      "info": { "title": "t", "version": "1" },
      "paths": {},
      "components": { "schemas": { "__proto__": { "type": "integer" } } }
    }`) as never;
    const overlay = JSON.parse(
      `{ "replaceSchemas": { "__proto__": { "type": "string" } } }`,
    ) as SpecOverlay;
    const out = applyOverlays(doc, [overlay]);
    const schemas = (out as { components: { schemas: Record<string, unknown> } }).components
      .schemas;
    expect(Object.hasOwn(schemas, "__proto__")).toBe(true);
    expect(schemas["__proto__"]).toEqual({ type: "string" });
    expect(Object.getPrototypeOf(schemas)).toBe(Object.prototype);
  });

  it("keeps an operation extension named __proto__ set by setExtensions", () => {
    const doc = JSON.parse(`{
      "openapi": "3.1.0",
      "info": { "title": "t", "version": "1" },
      "paths": { "/t": { "get": { "responses": { "200": { "description": "ok" } } } } }
    }`) as never;
    const overlay = JSON.parse(`{
      "overrides": {
        "/t": {
          "operations": {
            "get": { "setExtensions": { "__proto__": { "x": 1 }, "x-ok": 1 } }
          }
        }
      }
    }`) as SpecOverlay;
    const out = applyOverlays(doc, [overlay]);
    const op = (out as unknown as { paths: Record<string, Record<string, object>> }).paths["/t"]!
      .get!;
    expect(Object.hasOwn(op, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(op)).toBe(Object.prototype);
    // The sibling extension still lands, and nothing is inherited.
    expect((op as Record<string, unknown>)["x-ok"]).toBe(1);
    expect((op as { x?: unknown }).x).toBeUndefined();
  });
});
