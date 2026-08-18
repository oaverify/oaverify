import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compile } from "./helpers.js";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, openapi31Dialect } from "../src/keywords/vocabulary.js";
import { walkSubschemas } from "../src/subschema-positions.js";

/**
 * The schema package's own walkers against the mixed-map position.
 *
 * `dependencies` holds a subschema at some entries and an array of
 * property names at others, so every walker has to test each value
 * rather than act on the key. #845 taught these four walkers that;
 * nothing pinned it afterwards, and #859 then rebuilt all of them on a
 * shared iteration, which is exactly the change that could have undone
 * it silently.
 *
 * The sibling files are `packages/validator/test/mixed-map-positions.test.ts`
 * and `packages/stream-validator/test/normalize-mixed-map.test.ts`.
 */
describe("mixed-map subschema positions in the schema package", () => {
  it("sees a $dynamicRef declared under dependencies", () => {
    // The dynamic-scope pre-scan decides whether the compile unit gets a
    // runtime scope at all. Miss the `$dynamicRef` and `#node` compiles
    // as a plain `$ref`, so the extension point silently stops
    // extending: `unevaluatedProperties: false` at the outer resource
    // never sees `extra`.
    const compiled = compile({
      $id: "https://ex/strict-tree",
      $dynamicAnchor: "node",
      $ref: "https://ex/tree",
      unevaluatedProperties: false,
      $defs: {
        tree: {
          $id: "https://ex/tree",
          $dynamicAnchor: "node",
          type: "object",
          properties: { data: true },
          dependencies: {
            data: {
              properties: { children: { type: "array", items: { $dynamicRef: "#node" } } },
            },
          },
        },
      },
    });

    expect(compiled.validate({ data: 1, children: [{ data: 1, extra: 2 }] }).valid).toBe(false);
    expect(compiled.validate({ data: 1, children: [{ data: 1 }] }).valid).toBe(true);
  });

  it("visits a schema-valued dependencies entry and skips the array form", () => {
    const paths: string[] = [];
    walkSubschemas(
      {
        dependencies: {
          x: { type: "object", properties: { y: { type: "string" } } },
          arrayForm: ["z"],
        },
      } as SchemaOrBoolean,
      (_schema, path) => {
        paths.push(path);
      },
    );

    expect(paths).toContain("dependencies.x");
    // `["z"]` names required properties. Visiting it as a schema is the
    // corruption the mixed family exists to prevent.
    expect(paths).not.toContain("dependencies.arrayForm");
  });

  it.each(["dependentSchemas", "dependencies"] as const)(
    "resolves the required lint against properties reachable through %s",
    (keyword) => {
      const flagged = (schema: unknown) =>
        compileSchema(schema as SchemaOrBoolean, {
          dialect: jsonSchemaDialect,
        }).stats.schemaLintIssues.filter(
          (issue) => issue.code === "silent-rewrite/required-not-in-properties",
        );

      // `y` is declared inside the dependent schema, so requiring it at
      // the same instance position is satisfiable and not a finding.
      expect(
        flagged({
          type: "object",
          properties: { x: {} },
          [keyword]: { x: { properties: { y: {} } } },
          required: ["y"],
        }),
      ).toHaveLength(0);

      // A typo inside the dependent schema still is one.
      const typos = flagged({
        type: "object",
        properties: { x: {} },
        [keyword]: { x: { properties: { name: {} }, required: ["nmae"] } },
      });
      expect(typos).toHaveLength(1);
      expect(typos[0]?.message).toContain('"nmae"');
    },
  );

  it("checks the well-formedness of a schema-valued dependencies entry", () => {
    expect(() =>
      compileSchema({ dependencies: { x: { items: [] } } } as unknown as SchemaOrBoolean, {
        dialect: openapi31Dialect,
      }),
    ).toThrow(/"items" at "dependencies\.x" must be an object or boolean; got an array/);
  });

  it("accepts the array form as a property-name list rather than rejecting it", () => {
    // The other half of the well-formedness rule: an array here is
    // legal, and a pass that assumed every value is a schema would
    // refuse it.
    const compiled = compile({
      type: "object",
      properties: { x: {}, y: {} },
      dependencies: { x: ["y"] },
    });

    expect(compiled.validate({ x: 1 }).valid).toBe(false);
    expect(compiled.validate({ x: 1, y: 2 }).valid).toBe(true);
  });
});
