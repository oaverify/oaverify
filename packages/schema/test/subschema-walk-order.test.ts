import { describe, expect, it } from "vitest";
import { subschemaEntries } from "@oaverify/internal-core/subschema-positions";
import { resolve } from "../src/resolve/resolver.js";
import { walkSubschemas } from "../src/subschema-positions.js";

/**
 * Pins the order `subschemaEntries` yields position families in.
 *
 * Order is observable wherever a walker writes into a last-write-wins
 * sink. `walkScoped` has three (`byId`, the anchor scopes, and
 * `schemaBaseUri`), so which family is walked last decides which
 * declaration wins when a document declares the same name twice.
 *
 * Before the walkers were unified, `walkScoped` alone walked
 * map -> mixed -> single -> array while every other walker went
 * single -> array -> map -> mixed. Unifying them moved `walkScoped` to
 * the common order, which changes which declaration wins.
 *
 * Two kinds of document see that change, and only one of them is
 * ill-formed:
 *
 * - A duplicate `$anchor` within one resource. `$anchor` must be
 *   unique per resource, so the document is invalid either way.
 * - One schema *object* reachable from two `$id` scopes, which is what
 *   `const Email = {...}` reuse produces in a JS-built schema. That
 *   document is well-formed, and the reorder can flip a validation
 *   verdict for it: `schemaBaseUri` is keyed by object identity, so
 *   the last scope walked decides the base a relative `$ref` inside
 *   the shared object resolves against.
 *
 * Neither revision is more correct in the second case, because one
 * object cannot carry two base URIs; the answer was arbitrary before
 * and is arbitrary now. Representing it properly means keying the base
 * by use site rather than by identity, which is a separate change.
 * What this test buys is that the order is now one order rather than
 * two, and that changing it fails here rather than surfacing as a
 * changed verdict.
 */
describe("subschema walk order", () => {
  it("yields families in the order single, array, map, mixed-map", () => {
    const families = [
      ...subschemaEntries({
        dependencies: { d: { type: "string" } },
        properties: { p: { type: "string" } },
        allOf: [{ type: "string" }],
        not: { type: "string" },
      }),
    ].map((e) => e.family);

    // Declaration order in the schema is deliberately the reverse, so
    // this pins the table's order rather than the object's.
    expect(families).toEqual(["single", "array", "map", "mixed-map"]);
  });

  it("resolves a duplicated $anchor to the last family walked", () => {
    const viaProperties = { $anchor: "dup", type: "string" };
    const viaAllOf = { $anchor: "dup", type: "number" };
    const graph = resolve({
      $id: "https://ex/root",
      properties: { p: viaProperties },
      allOf: [viaAllOf],
    } as never);

    // `properties` (map) is walked after `allOf` (array), so it wins.
    expect(graph.anchorScopes.get("https://ex/root")?.get("dup")).toBe(viaProperties);
  });
});

describe("a hole in a subschema map", () => {
  it("is never handed to a walkSubschemas visitor as a node", () => {
    const seen: string[] = [];
    walkSubschemas(
      { allOf: [undefined], properties: { a: undefined, b: {} } } as never,
      (_s, p) => {
        seen.push(p);
      },
    );
    // The root, plus `properties.b`. Neither hole is a schema.
    expect(seen).toEqual(["", "properties.b"]);
  });

  it("does not reach the resolver as a schema", () => {
    // Regression: the map families once yielded `undefined` through,
    // and `walkScoped` reads `$id` off it immediately.
    expect(() => resolve({ properties: { a: undefined } } as never)).not.toThrow();
    expect(() => resolve({ dependencies: { a: undefined } } as never)).not.toThrow();
  });
});
