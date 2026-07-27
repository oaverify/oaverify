import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { walkSubschemas } from "../src/subschema-positions.js";

describe("walkSubschemas", () => {
  it("visits the root, then every schema-valued position in pre-order", () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { not: { type: "null" } },
      },
      allOf: [{ minProperties: 1 }, { maxProperties: 5 }],
    };
    const paths: string[] = [];
    walkSubschemas(schema, (_node, path) => {
      paths.push(path);
    });
    // Order: single-valued keys first, then array keys, then map keys.
    // Matches the SUBSCHEMA_{SINGLE,ARRAY,MAP}_POSITIONS iteration.
    expect(paths).toEqual([
      "",
      "allOf[0]",
      "allOf[1]",
      "properties.a",
      "properties.b",
      "properties.b.not",
    ]);
  });

  it("descends through map positions (patternProperties, dependentSchemas, $defs)", () => {
    const schema: SchemaOrBoolean = {
      $defs: { X: { type: "string" } },
      patternProperties: { "^a": { type: "number" } },
      dependentSchemas: { trigger: { minProperties: 1 } },
    };
    const paths: string[] = [];
    walkSubschemas(schema, (_n, p) => {
      paths.push(p);
    });
    expect(paths).toContain("$defs.X");
    expect(paths).toContain("patternProperties.^a");
    expect(paths).toContain("dependentSchemas.trigger");
  });

  it("honors a `false` return to prune the subtree", () => {
    const schema: SchemaOrBoolean = {
      properties: { a: { properties: { aa: { type: "string" } } } },
    };
    const paths: string[] = [];
    walkSubschemas(schema, (_n, path) => {
      paths.push(path);
      if (path === "properties.a") return false; // don't descend into aa
    });
    expect(paths).toEqual(["", "properties.a"]);
  });

  it("visits boolean subschemas without descending", () => {
    const schema: SchemaOrBoolean = {
      properties: { forbidden: false, anything: true },
    };
    const visited: SchemaOrBoolean[] = [];
    walkSubschemas(schema, (node) => {
      visited.push(node);
    });
    expect(visited).toContain(false);
    expect(visited).toContain(true);
  });
});
