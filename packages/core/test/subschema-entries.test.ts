import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "../src/types.js";
import {
  subschemaEntries,
  subschemaFamilyOf,
  transformSubschemaValue,
} from "../src/subschema-positions.js";

describe("subschemaFamilyOf", () => {
  it("names the family of each uniform position", () => {
    expect(subschemaFamilyOf("not")).toBe("single");
    expect(subschemaFamilyOf("allOf")).toBe("array");
    expect(subschemaFamilyOf("properties")).toBe("map");
  });

  it("answers for a mixed position, where the every-value predicate cannot", () => {
    expect(subschemaFamilyOf("dependencies")).toBe("mixed-map");
  });

  it("is undefined for a key holding author data rather than schemas", () => {
    expect(subschemaFamilyOf("examples")).toBeUndefined();
    expect(subschemaFamilyOf("default")).toBeUndefined();
    expect(subschemaFamilyOf("type")).toBeUndefined();
  });
});

describe("subschemaEntries", () => {
  it("yields every family from one schema, mixed included", () => {
    const found = [
      ...subschemaEntries({
        not: { type: "string" },
        allOf: [{ type: "object" }],
        properties: { a: { type: "number" } },
        dependencies: { b: { type: "boolean" } },
      }),
    ];

    expect(found.map((e) => [e.key, e.family, e.at])).toEqual([
      ["not", "single", undefined],
      ["allOf", "array", 0],
      ["properties", "map", "a"],
      ["dependencies", "mixed-map", "b"],
    ]);
  });

  it("skips a mixed map's array entries, which name properties", () => {
    const found = [
      ...subschemaEntries({
        dependencies: { needsB: ["b"], withSchema: { type: "string" } },
      }),
    ];

    expect(found).toHaveLength(1);
    expect(found[0]?.at).toBe("withSchema");
  });

  it("never descends into author data", () => {
    const found = [...subschemaEntries({ examples: [{ $ref: "#/nope" }], default: { a: 1 } })];
    expect(found).toEqual([]);
  });

  it("skips a hole in an array position", () => {
    expect([...subschemaEntries({ allOf: [undefined] })]).toEqual([]);
    // A sparse array, whose hole `entries()` also yields.
    const sparse: unknown[] = new Array<unknown>(2);
    sparse[1] = { type: "string" };
    expect([...subschemaEntries({ prefixItems: sparse })]).toHaveLength(1);
  });

  it("skips a hole in a map rather than yielding undefined as a schema", () => {
    // `resolve()` reads `$id` off whatever it is handed, so yielding a
    // hole here is a TypeError at the caller rather than a no-op.
    expect([...subschemaEntries({ properties: { a: undefined } })]).toEqual([]);
    expect([...subschemaEntries({ $defs: { a: undefined } })]).toEqual([]);
    expect([...subschemaEntries({ dependencies: { a: undefined } })]).toEqual([]);
  });

  it("yields nothing for a boolean schema or a non-object", () => {
    expect([...subschemaEntries(true)]).toEqual([]);
    expect([...subschemaEntries(null)]).toEqual([]);
    expect([...subschemaEntries([{ type: "string" }])]).toEqual([]);
  });
});

describe("transformSubschemaValue", () => {
  const mark = (): SchemaOrBoolean => ({ title: "marked" });

  it("preserves the shape of each family", () => {
    expect(transformSubschemaValue("single", { type: "string" }, mark)).toEqual({
      title: "marked",
    });
    expect(transformSubschemaValue("array", [{ type: "string" }], mark)).toEqual([
      { title: "marked" },
    ]);
    expect(transformSubschemaValue("map", { a: { type: "string" } }, mark)).toEqual({
      a: { title: "marked" },
    });
  });

  it("passes a mixed map's array entry through untouched", () => {
    expect(
      transformSubschemaValue("mixed-map", { needsB: ["b"], sub: { type: "string" } }, mark),
    ).toEqual({ needsB: ["b"], sub: { title: "marked" } });
  });

  it("leaves a value that does not match its family alone", () => {
    expect(transformSubschemaValue("array", "not-an-array", mark)).toBe("not-an-array");
    expect(transformSubschemaValue("map", 42, mark)).toBe(42);
  });
});
