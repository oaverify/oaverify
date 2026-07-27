import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { RefResolver } from "@oaverify/internal-schema";
import { describe, expect, it } from "vitest";
import {
  createDirectionResolver,
  transformBodySchemaForDirection,
} from "../src/body-schema-transform.js";

/**
 * Direct unit tests for the body-schema pre-transform. Covers the two
 * concerns that live in this module:
 *   - readOnly / writeOnly direction filtering
 *   - `format: "binary"` opaque-body bypass
 */

function refResolver(refs: Record<string, SchemaOrBoolean> = {}): RefResolver {
  return {
    resolve(ref) {
      const hit = refs[ref];
      if (hit === undefined) throw new Error(`unresolved ref: ${ref}`);
      return hit;
    },
  };
}

describe("transformBodySchemaForDirection", () => {
  const emptyResolver = refResolver();

  it("returns booleans and non-objects unchanged", () => {
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    expect(transformBodySchemaForDirection(true, "request", emptyResolver, cache)).toBe(true);
    expect(transformBodySchemaForDirection(false, "response", emptyResolver, cache)).toBe(false);
  });

  it("replaces readOnly properties with `false` and strips them from required on the request side", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string", readOnly: true },
        name: { type: "string" },
      },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "request", emptyResolver, cache) as {
      properties: Record<string, SchemaOrBoolean>;
      required: string[];
    };
    expect(out.properties.id).toBe(false);
    expect(out.properties.name).toEqual({ type: "string" });
    expect(out.required).toEqual(["name"]);
  });

  it("replaces writeOnly properties with `false` and strips them on the response side", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      required: ["secret", "public"],
      properties: {
        secret: { type: "string", writeOnly: true },
        public: { type: "string" },
      },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "response", emptyResolver, cache) as {
      properties: Record<string, SchemaOrBoolean>;
      required: string[];
    };
    expect(out.properties.secret).toBe(false);
    expect(out.required).toEqual(["public"]);
  });

  it("leaves writeOnly properties alone on the request side", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { password: { type: "string", writeOnly: true } },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "request", emptyResolver, cache) as {
      properties: Record<string, SchemaOrBoolean>;
    };
    expect(out.properties.password).toEqual({ type: "string", writeOnly: true });
  });

  it("unwraps a root-level $ref before transforming", () => {
    const target: SchemaOrBoolean = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", readOnly: true } },
    };
    const resolver = refResolver({ "#/components/schemas/Thing": target });
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(
      { $ref: "#/components/schemas/Thing" },
      "request",
      resolver,
      cache,
    ) as { properties: Record<string, SchemaOrBoolean>; required: string[] };
    expect(out.properties.id).toBe(false);
    expect(out.required).toEqual([]);
  });

  it("descends into allOf, oneOf, prefixItems, items, additionalProperties", () => {
    const schema: SchemaOrBoolean = {
      allOf: [{ type: "object", properties: { a: { type: "string", readOnly: true } } }],
      oneOf: [{ type: "object", properties: { b: { type: "string", readOnly: true } } }],
      prefixItems: [{ type: "object", properties: { c: { type: "string", readOnly: true } } }],
      items: { type: "object", properties: { d: { type: "string", readOnly: true } } },
      additionalProperties: {
        type: "object",
        properties: { e: { type: "string", readOnly: true } },
      },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "request", emptyResolver, cache) as {
      allOf: Array<{ properties: Record<string, SchemaOrBoolean> }>;
      oneOf: Array<{ properties: Record<string, SchemaOrBoolean> }>;
      prefixItems: Array<{ properties: Record<string, SchemaOrBoolean> }>;
      items: { properties: Record<string, SchemaOrBoolean> };
      additionalProperties: { properties: Record<string, SchemaOrBoolean> };
    };
    expect(out.allOf[0]?.properties.a).toBe(false);
    expect(out.oneOf[0]?.properties.b).toBe(false);
    expect(out.prefixItems[0]?.properties.c).toBe(false);
    expect(out.items.properties.d).toBe(false);
    expect(out.additionalProperties.properties.e).toBe(false);
  });

  it("strips a `format: binary` string schema to `{}` (opaque body bypass)", () => {
    const schema: SchemaOrBoolean = { type: "string", format: "binary" };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    expect(transformBodySchemaForDirection(schema, "request", emptyResolver, cache)).toEqual({});
    expect(transformBodySchemaForDirection(schema, "response", emptyResolver, cache)).toEqual({});
  });

  it("strips `format: binary` when type is array-typed including string", () => {
    const schema: SchemaOrBoolean = {
      type: ["string", "null"],
      format: "binary",
    } as SchemaOrBoolean;
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    expect(transformBodySchemaForDirection(schema, "request", emptyResolver, cache)).toEqual({});
  });

  it("does NOT strip a `format: binary` schema whose type is non-string", () => {
    const schema: SchemaOrBoolean = { type: "integer", format: "binary" } as SchemaOrBoolean;
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "request", emptyResolver, cache);
    expect(out).toEqual({ type: "integer", format: "binary" });
  });

  it("caches identical input schemas so shared references stay shared", () => {
    const inner: SchemaOrBoolean = {
      type: "object",
      properties: { x: { type: "string", readOnly: true } },
    };
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { a: inner, b: inner },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const out = transformBodySchemaForDirection(schema, "request", emptyResolver, cache) as {
      properties: { a: object; b: object };
    };
    expect(out.properties.a).toBe(out.properties.b);
  });

  it("guards against cycles in $ref chains at the root-unwrap step", () => {
    // schema.$ref points at itself; unwrapRootRef must bail rather than
    // loop forever.
    const cyclic: SchemaOrBoolean = { $ref: "#/self" };
    const resolver: RefResolver = {
      resolve() {
        return cyclic;
      },
    };
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    expect(() => transformBodySchemaForDirection(cyclic, "request", resolver, cache)).not.toThrow();
  });
});

describe("createDirectionResolver", () => {
  it("projects the direction transform onto every $ref target", () => {
    const target: SchemaOrBoolean = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", readOnly: true } },
    };
    const base = refResolver({ "#/T": target });
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const wrapped = createDirectionResolver(base, "request", cache);
    const out = wrapped.resolve("#/T") as {
      properties: Record<string, SchemaOrBoolean>;
      required: string[];
    };
    expect(out.properties.id).toBe(false);
    expect(out.required).toEqual([]);
  });

  it("memoises per (target, direction) via the shared cache", () => {
    const target: SchemaOrBoolean = {
      type: "object",
      properties: { id: { type: "string", readOnly: true } },
    };
    const base = refResolver({ "#/T": target });
    const cache = new Map<SchemaOrBoolean, SchemaOrBoolean>();
    const wrapped = createDirectionResolver(base, "request", cache);
    const a = wrapped.resolve("#/T");
    const b = wrapped.resolve("#/T");
    expect(a).toBe(b);
  });
});
