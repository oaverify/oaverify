import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, jsonSchemaDialect, oas30Dialect } from "@oaverify/internal-schema";
import { classify } from "../src/classifier/index.js";
import { createStreamValidator, type StreamValidatorOptions } from "../src/index.js";

const enc = new TextEncoder();

async function streamVerdict(
  schema: SchemaOrBoolean,
  value: unknown,
  options: StreamValidatorOptions = {},
): Promise<boolean> {
  const v = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    ...options,
  });
  v.on("error", () => {});
  v.resume();
  const r = v.result;
  v.end(Buffer.from(enc.encode(JSON.stringify(value))));
  return (await r).valid;
}

function inMemory(schema: SchemaOrBoolean, value: unknown): boolean {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
  }).validate(value).valid;
}

async function expectParity(schema: SchemaOrBoolean, values: unknown[]): Promise<void> {
  for (const value of values) {
    expect(await streamVerdict(schema, value), `${JSON.stringify(value)}`).toBe(
      inMemory(schema, value),
    );
  }
}

describe("components is a ref container, not an unknown keyword", () => {
  it("resolves a #/components/schemas ref on the stream path", async () => {
    const schema = {
      $ref: "#/components/schemas/Pet",
      components: { schemas: { Pet: { type: "object", required: ["name"] } } },
    } as unknown as SchemaOrBoolean;
    await expectParity(schema, [{ name: "x" }, {}, "not-object"]);
  });

  it("resolves component refs inside a BUFFER island (oneOf)", async () => {
    // `components` is an OpenAPI ref container, not a schema keyword.
    const schema = {
      type: "object",
      properties: {
        pet: {
          oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
        },
      },
      components: {
        schemas: {
          Cat: { type: "object", required: ["meow"] },
          Dog: { type: "object", required: ["bark"] },
        },
      },
    };
    await expectParity(schema, [
      { pet: { meow: true } },
      { pet: { bark: true } },
      { pet: { meow: true, bark: true } },
      { pet: {} },
    ]);
  });
});

describe("anchor refs resolve (and stay correct) across many array elements", () => {
  // Regression for the per-value anchor-resolution scan: an anchor ref
  // (`#name`) used as the items schema is followed once per element via
  // `expand`. The spine memoizes the resolution, so a large array must
  // not change the verdict (and must not re-walk the schema per element).
  it("validates each element of a long array against an anchor ref", async () => {
    const schema: SchemaObject = {
      type: "array",
      items: { $ref: "#item" },
      $defs: {
        Item: { $anchor: "item", type: "object", required: ["id"] },
      },
    };
    const good = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const oneBad = [...good.slice(0, 100), { nope: true }, ...good.slice(100)];
    await expectParity(schema, [good, oneBad, []]);
  });
});

describe("island ref-container graft: root #/$defs wins over a node-local $defs", () => {
  it("a buffer island's root-targeting ref resolves against the document root", async () => {
    // `#/$defs/Strict` inside the island means the DOCUMENT root's $defs
    // (a string), not the node-local decoy (an integer).
    const schema: SchemaObject = {
      type: "object",
      properties: {
        p: {
          oneOf: [{ $ref: "#/$defs/Strict" }, { const: { tag: 1 } }], // const-object -> BUFFER island
          $defs: { Strict: { type: "integer" } }, // local decoy
        },
      },
      $defs: { Strict: { type: "string" } }, // the real target
    };
    await expectParity(schema, [{ p: "hello" }, { p: 5 }, { p: { tag: 1 } }, { p: {} }]);
  });
});

describe("co-located reference keywords", () => {
  it("evaluates composition targets without re-expanding their reference wrappers", async () => {
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const schema: SchemaObject = {
        $ref: "#/$defs/A",
        $dynamicRef: "#/$defs/B",
        $defs: { A: { type: "string" }, B: { [keyword]: [{ minLength: 5 }, { const: "hi" }] } },
      };
      await expectParity(schema, ["hi", "abc", "abcde", 42]);
    }
  });

  it("preserves recursive object constraints from both targets", async () => {
    const schema: SchemaObject = {
      $ref: "#/$defs/Node",
      $dynamicRef: "#/$defs/Required",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node", $dynamicRef: "#/$defs/Required" } },
        },
        Required: { required: ["id"] },
      },
    };
    await expectParity(schema, [{ id: 1 }, { id: 1, next: { id: 2 } }, { id: 1, next: {} }, {}]);
  });

  it("retains OpenAPI 3.0 reference sibling suppression", async () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { value: { $ref: "#/$defs/A", $dynamicRef: "#/$defs/B" } },
      $defs: { A: { type: "string" }, B: { minLength: 5 } },
    };
    const core = compileSchema(schema, { dialect: oas30Dialect });
    for (const value of [{ value: "abc" }, { value: "abcde" }, { value: 42 }]) {
      expect(await streamVerdict(schema, value, { openApiVersion: "3.0" })).toBe(
        core.validate(value).valid,
      );
    }
  });

  it("applies both scalar targets", async () => {
    const schema: SchemaObject = {
      $ref: "#/$defs/A",
      $dynamicRef: "#/$defs/B",
      $defs: { A: { type: "string" }, B: { minLength: 5 } },
    };
    await expectParity(schema, ["abc", "abcde", 42]);
  });

  it("collects a second target outside subschema containers", async () => {
    const schema = {
      $ref: "#/components/schemas/A",
      $dynamicRef: "#/components/schemas/B",
      components: { schemas: { A: { type: "object" }, B: { enum: [{ a: 1 }] } } },
    };
    const classification = classify(schema);
    expect(classification.root).toBe("buffer");
    expect(classification.strategyOf(schema.components.schemas.B)).toBe("buffer");
    expect(classification.fullyStreamable).toBe(false);
    await expectParity(schema, [{ a: 1 }, { a: 2 }, {}, 42]);
  });

  it.each([true, false])(
    "applies a boolean first target (%s) before the second target",
    async (target) => {
      const schema: SchemaObject = {
        $ref: "#/$defs/A",
        $dynamicRef: "#/$defs/B",
        $defs: { A: target, B: { type: "string", minLength: 5 } },
      };
      await expectParity(schema, ["abc", "abcde", 42]);
    },
  );

  it("handles shared targets", async () => {
    const schema: SchemaObject = {
      $ref: "#/$defs/A",
      $dynamicRef: "#/$defs/A",
      $defs: { A: { type: "string", minLength: 5 } },
    };
    await expectParity(schema, ["abc", "abcde", 42]);
  });

  it("classifies cyclic targets without losing the second dependency", () => {
    const schema = {
      $ref: "#/components/schemas/A",
      $dynamicRef: "#/components/schemas/B",
      components: {
        schemas: {
          A: { $ref: "#" },
          B: { enum: [{ a: 1 }] },
        },
      },
    };
    expect(classify(schema).root).toBe("buffer");
  });
});
