import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, jsonSchemaDialect } from "@oaverify/internal-schema";
import { createStreamValidator } from "../src/index.js";

const enc = new TextEncoder();

async function streamVerdict(schema: SchemaOrBoolean, value: unknown): Promise<boolean> {
  const v = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
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
