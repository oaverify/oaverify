import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { openapi31Dialect } from "../src/keywords/vocabulary.js";
import { resolve } from "../src/resolve/resolver.js";

describe("resolve", () => {
  it("returns the schema itself as the root", () => {
    const schema = { type: "number" };
    const graph = resolve(schema);
    expect(graph.root).toBe(schema);
  });

  it("accepts boolean root schemas", () => {
    expect(resolve(true).root).toBe(true);
    expect(resolve(false).root).toBe(false);
  });

  it("collects $id and $anchor entries from nested subschemas", () => {
    const pet = { $id: "/Pet", type: "object" } as const;
    const tail = { $anchor: "tail", type: "string" } as const;
    const schema = { $defs: { Pet: pet, Tail: tail } };
    const graph = resolve(schema);
    expect(graph.byId.get("/Pet")).toBe(pet);
    expect(graph.byAnchor.get("tail")).toBe(tail);
  });

  it("collects $dynamicAnchor entries", () => {
    const schema = { $dynamicAnchor: "node", type: "object" };
    const graph = resolve(schema);
    expect(graph.byDynamicAnchor.get("node")).toBe(schema);
  });

  it("descends into properties, items, prefixItems, allOf, oneOf, not", () => {
    const a = { $anchor: "a", type: "string" } as const;
    const b = { $anchor: "b", type: "number" } as const;
    const c = { $anchor: "c", type: "boolean" } as const;
    const d = { $anchor: "d", type: "array" } as const;
    const e = { $anchor: "e", type: "null" } as const;
    const schema = {
      properties: { a },
      items: b,
      prefixItems: [c],
      oneOf: [d],
      not: e,
    };
    const graph = resolve(schema);
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(graph.byAnchor.has(name)).toBe(true);
    }
  });
});

describe("the refResolver option is checked where it is passed (#478)", () => {
  /**
   * Load-bearing: without a `$ref` the resolver is never invoked, the
   * bad option compiles clean, and a test asserting the guard would
   * pass whether or not the guard existed. That is what hid this.
   */
  const withRef = {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "string" } },
  };

  const compile = (refResolver: unknown) =>
    compileSchema(withRef as SchemaOrBoolean, {
      dialect: openapi31Dialect,
      refResolver: refResolver as never,
    });

  it("names the option and the shape it wanted", () => {
    // The shape a caller reaches for first.
    expect(() => compile((ref: string) => ({ type: "string", ref }))).toThrow(
      /refResolver must be an object with a resolve\(ref\) method; received a function/,
    );
  });

  it("says what it got, for every wrong shape", () => {
    const cases: [unknown, string][] = [
      [42, "a number"],
      [null, "null"],
      [[], "an array"],
      [{ resolveRef: () => true }, "an object with no resolve method"],
    ];
    for (const [value, described] of cases) {
      expect(() => compile(value), described).toThrow(`received ${described}`);
    }
  });

  it("never mentions the internal field the old TypeError named", () => {
    expect(() => compile(() => true)).not.toThrow(/state\.refResolver/);
  });

  it("leaves a resolver of the right shape alone", () => {
    const compiled = compileSchema(withRef as SchemaOrBoolean, {
      dialect: openapi31Dialect,
      refResolver: { resolve: () => ({ type: "string" }) },
    });
    expect(compiled.validate({ a: "ok" }).valid).toBe(true);
    expect(compiled.validate({ a: 1 }).valid).toBe(false);
  });

  it("still resolves the $ref itself when the option is absent", () => {
    const compiled = compileSchema(withRef as SchemaOrBoolean, { dialect: openapi31Dialect });
    expect(compiled.validate({ a: "ok" }).valid).toBe(true);
    expect(compiled.validate({ a: 1 }).valid).toBe(false);
  });
});
