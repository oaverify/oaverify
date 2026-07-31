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

  describe("position frames (#517)", () => {
    it("gives no pointer at all when the caller supplied no document position", () => {
      // The bare-schema caller. There is no document, so there is no
      // pointer, and a synthesized one would resolve nowhere.
      const schema: SchemaOrBoolean = { properties: { a: { type: "string" } } };
      const seen: (string | undefined)[] = [];
      walkSubschemas(schema, (_n, _p, at) => {
        seen.push(at.pointer);
      });
      expect(seen).toEqual([undefined, undefined]);
    });

    it("builds a pointer from the supplied root and keeps schemaPath as segments", () => {
      const schema: SchemaOrBoolean = {
        properties: { a: { items: { type: "string" } } },
      };
      const seen: { pointer?: string; schemaPath?: readonly (string | number)[] }[] = [];
      walkSubschemas(
        schema,
        (_n, _p, at) => {
          seen.push({ ...at });
        },
        {
          pointer: "/components/schemas/Thing",
        },
      );
      expect(seen).toEqual([
        { pointer: "/components/schemas/Thing", schemaPath: [] },
        {
          pointer: "/components/schemas/Thing/properties/a",
          schemaPath: ["properties", "a"],
        },
        {
          pointer: "/components/schemas/Thing/properties/a/items",
          schemaPath: ["properties", "a", "items"],
        },
      ]);
    });

    it("escapes a key holding / or ~ rather than letting it split the pointer", () => {
      // The lossy-join defect (#517 3b) in its original form: a dotted
      // path cannot round-trip these and a pointer must.
      const schema: SchemaOrBoolean = { properties: { "a/b~c": { type: "string" } } };
      const seen: (string | undefined)[] = [];
      walkSubschemas(
        schema,
        (_n, _p, at) => {
          seen.push(at.pointer);
        },
        { pointer: "" },
      );
      expect(seen[1]).toBe("/properties/a~1b~0c");
    });

    it("re-roots the pointer at a local ref target and ends schemaPath there", () => {
      // The two frames part company exactly here, which is the whole
      // point: the pointer follows the text, and schemaPath cannot
      // express the hop so it stops.
      const target: SchemaOrBoolean = { properties: { deep: { type: "string" } } };
      const schema: SchemaOrBoolean = {
        properties: { a: { $ref: "#/components/schemas/Target" } },
      };
      const seen: { path: string; pointer?: string; schemaPath?: readonly unknown[] }[] = [];
      walkSubschemas(
        schema,
        (_n, path, at) => {
          seen.push({ path, ...at });
        },
        {
          resolveRef: (ref) => (ref === "#/components/schemas/Target" ? target : undefined),
          pointer: "/paths/~1t/get/parameters/0/schema",
        },
      );

      const inTarget = seen.find((s) => s.path === "components.schemas.Target");
      expect(inTarget?.pointer).toBe("/components/schemas/Target");
      expect(inTarget?.schemaPath).toBeUndefined();

      const below = seen.find((s) => s.path === "components.schemas.Target.properties.deep");
      expect(below?.pointer).toBe("/components/schemas/Target/properties/deep");
      expect(below?.schemaPath).toBeUndefined();
    });

    it("percent-decodes a ref fragment so one pointer grammar comes out", () => {
      const target: SchemaOrBoolean = { type: "string" };
      const schema: SchemaOrBoolean = { properties: { a: { $ref: "#/components/My%20Schema" } } };
      const seen: (string | undefined)[] = [];
      walkSubschemas(
        schema,
        (_n, _p, at) => {
          seen.push(at.pointer);
        },
        {
          resolveRef: () => target,
          pointer: "",
        },
      );
      expect(seen).toContain("/components/My Schema");
    });

    it("drops both frames below an anchor or external ref rather than guessing", () => {
      const target: SchemaOrBoolean = { properties: { x: { type: "string" } } };
      for (const ref of ["#some-anchor", "https://example.com/other.json#/A"]) {
        const schema: SchemaOrBoolean = { properties: { a: { $ref: ref } } };
        const seen: { pointer?: string; schemaPath?: readonly unknown[] }[] = [];
        walkSubschemas(
          schema,
          (_n, _p, at) => {
            seen.push({ ...at });
          },
          {
            resolveRef: () => target,
            pointer: "/components/schemas/Root",
          },
        );
        // The target and everything under it has neither frame.
        const inTarget = seen.slice(2);
        expect(inTarget.length).toBeGreaterThan(0);
        for (const at of inTarget) {
          expect(at.pointer).toBeUndefined();
          expect(at.schemaPath).toBeUndefined();
        }
      }
    });

    it("does not synthesize a pointer from a local ref when no frame is in scope", () => {
      // A `$ref` fragment addresses the ref resolution root, which is
      // not the document frame the caller supplied and may be a bare
      // schema with no document at all. Deriving one from the ref alone
      // would put a schema-relative address under a field documented as
      // document-relative.
      const target: SchemaOrBoolean = { properties: { deep: { type: "string" } } };
      const schema: SchemaOrBoolean = { properties: { a: { $ref: "#/$defs/T" } } };
      const seen: (string | undefined)[] = [];
      walkSubschemas(
        schema,
        (_n, _p, at) => {
          seen.push(at.pointer);
        },
        { resolveRef: () => target },
      );
      expect(seen.length).toBeGreaterThan(2); // the target was walked
      expect(seen.every((p) => p === undefined)).toBe(true);
    });

    it("does not resume a pointer at a local ref reached after the frame was lost", () => {
      // External hop drops the frame; a local ref below it must not
      // silently restore one.
      const inner: SchemaOrBoolean = { properties: { deep: { type: "string" } } };
      const outer: SchemaOrBoolean = { properties: { b: { $ref: "#/$defs/Inner" } } };
      const schema: SchemaOrBoolean = {
        properties: { a: { $ref: "https://example.com/other.json#/A" } },
      };
      const seen: (string | undefined)[] = [];
      walkSubschemas(
        schema,
        (_n, _p, at) => {
          seen.push(at.pointer);
        },
        {
          resolveRef: (ref) => (ref.startsWith("https://") ? outer : inner),
          pointer: "/components/schemas/Root",
        },
      );
      // Root and properties.a still have the frame; nothing below the
      // external hop does.
      expect(seen.slice(0, 2)).toEqual([
        "/components/schemas/Root",
        "/components/schemas/Root/properties/a",
      ]);
      expect(seen.slice(2).every((p) => p === undefined)).toBe(true);
    });

    it("still accepts a bare resolver as the third argument", () => {
      // Every pre-existing caller passes a function here.
      const target: SchemaOrBoolean = { type: "string" };
      const schema: SchemaOrBoolean = { properties: { a: { $ref: "#/T" } } };
      const paths: string[] = [];
      walkSubschemas(
        schema,
        (_n, path) => void paths.push(path),
        () => target,
      );
      expect(paths).toContain("T");
    });
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
