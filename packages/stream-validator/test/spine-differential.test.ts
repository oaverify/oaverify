import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, jsonSchemaDialect } from "@oaverify/internal-schema";
import { ClassifierError } from "../src/classifier/index.js";
import { createStreamValidator } from "../src/index.js";

const enc = new TextEncoder();

/**
 * Stream-validate `value` against `schema` through the full engine
 * (which materializes + delegates BUFFER/TEE islands). Returns the
 * verdict, or "unsupported" when the schema fails classification (a
 * REJECT keyword). Uses detach + unbounded budget so the verdict is
 * complete and the stream finishes without erroring.
 */
async function streamValid(
  schema: SchemaOrBoolean,
  value: unknown,
): Promise<boolean | "unsupported"> {
  let validator;
  try {
    validator = createStreamValidator(schema, {
      policy: "detach",
      maxErrors: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    if (err instanceof ClassifierError) return "unsupported";
    throw err;
  }
  validator.on("error", () => {});
  validator.resume(); // drain (and discard) the echoed bytes
  const result = validator.result;
  validator.end(Buffer.from(enc.encode(JSON.stringify(value))));
  const verdict = await result;
  return verdict.valid;
}

function inMemoryValid(schema: SchemaOrBoolean, value: unknown): boolean {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
  }).validate(value).valid;
}

const CORPUS: Array<{ schema: SchemaOrBoolean; values: unknown[] }> = [
  // --- STREAM keyword set ---
  { schema: { type: "string" }, values: ["", "abc", 1, true, null, {}, []] },
  { schema: { type: "integer" }, values: [1, 1.0, 1.5, "1", true] },
  { schema: { type: ["string", "null"] }, values: ["x", null, 1, {}] },
  {
    schema: { type: "string", minLength: 2, maxLength: 4 },
    values: ["a", "ab", "abcd", "abcde", "éé"],
  },
  { schema: { type: "string", pattern: "^a+$" }, values: ["aaa", "aab", "", "a"] },
  { schema: { enum: ["a", 1, null, true] }, values: ["a", 1, null, true, "b", 2, false] },
  { schema: { const: 42 }, values: [42, 43, "42"] },
  { schema: { type: "number", minimum: 0, maximum: 10 }, values: [0, 5, 10, -1, 11] },
  {
    schema: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
    values: [0, 0.0001, 10, 9.999],
  },
  { schema: { type: "integer", multipleOf: 3 }, values: [0, 3, 9, 4, -6] },
  { schema: { type: "number", multipleOf: 0.1 }, values: [0.3, 0.1, 0.2, 1, 0.15] },
  {
    schema: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a"],
    },
    values: [{ a: "x" }, { a: "x", b: 1 }, { b: 1 }, { a: 1 }, { a: "x", b: "y" }, "not-object"],
  },
  {
    schema: { type: "object", additionalProperties: false, properties: { a: {} } },
    values: [{ a: 1 }, { a: 1, b: 2 }, {}],
  },
  {
    schema: { type: "object", additionalProperties: { type: "number" } },
    values: [{ a: 1 }, { a: "x" }, {}],
  },
  {
    schema: { type: "object", patternProperties: { "^x": { type: "number" } } },
    values: [{ x1: 1 }, { x1: "s" }, { y: "s" }],
  },
  {
    schema: { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
    values: [{ ab: 1 }, { Ab: 1 }, { "1": 1 }],
  },
  {
    schema: { type: "object", minProperties: 1, maxProperties: 2 },
    values: [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }],
  },
  {
    schema: { type: "object", dependentRequired: { card: ["cvv"] } },
    values: [{}, { card: 1 }, { card: 1, cvv: 2 }, { cvv: 2 }],
  },
  { schema: { type: "array", items: { type: "number" } }, values: [[], [1, 2], [1, "x"], "no"] },
  {
    schema: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "boolean" },
    },
    values: [["a", 1], ["a", 1, true], ["a", 1, 2], [1, 1], ["a"]],
  },
  { schema: { type: "array", minItems: 1, maxItems: 2 }, values: [[], [1], [1, 2], [1, 2, 3]] },
  { schema: true, values: [1, "x", {}, [], null] },
  { schema: false, values: [1, "x", {}, null] },
  { schema: { type: "object", properties: { a: false } }, values: [{}, { a: 1 }] },
  {
    schema: {
      type: "object",
      properties: { value: { type: "integer" }, children: { type: "array", items: { $ref: "#" } } },
      required: ["value"],
    },
    values: [
      { value: 1 },
      { value: 1, children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }] },
      { value: 1, children: [{ value: "x" }] },
      { children: [] },
    ],
  },
  {
    schema: {
      type: "object",
      properties: { id: { $ref: "#/$defs/Id" } },
      $defs: { Id: { type: "string", minLength: 3 } },
    },
    values: [{ id: "abc" }, { id: "ab" }, { id: 1 }, {}],
  },
  // --- BUFFER / TEE islands (materialized + delegated) ---
  {
    schema: { uniqueItems: true, type: "array" },
    values: [[1, 2, 3], [1, 2, 2], [], [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }]],
  },
  { schema: { allOf: [{ type: "integer" }, { minimum: 0 }] }, values: [5, -1, 1.5, "x"] },
  { schema: { anyOf: [{ type: "string" }, { type: "integer" }] }, values: ["x", 1, 1.5, true] },
  { schema: { oneOf: [{ type: "integer" }, { minimum: 5 }] }, values: [3, 7, 10.5, "x"] },
  { schema: { not: { type: "null" } }, values: [1, "x", null, {}] },
  { schema: { enum: [{ a: 1 }, [1, 2]] }, values: [{ a: 1 }, [1, 2], { a: 2 }, [1], "x"] },
  {
    schema: { const: { nested: { x: [1, 2] } } },
    values: [{ nested: { x: [1, 2] } }, { nested: { x: [1] } }, {}],
  },
  {
    schema: { type: "object", dependentSchemas: { card: { required: ["cvv"] } } },
    values: [{}, { card: 1 }, { card: 1, cvv: 2 }],
  },
  {
    schema: { type: "array", contains: { type: "string" }, minContains: 2 },
    values: [
      ["a", "b"],
      ["a", 1],
      [1, 2],
      ["a", "b", "c"],
    ],
  },
  {
    schema: { type: "object", properties: { tag: { oneOf: [{ const: "a" }, { const: "b" }] } } },
    values: [{ tag: "a" }, { tag: "c" }, {}],
  },
  // A streamed object whose property is a BUFFER island.
  {
    schema: {
      type: "object",
      properties: { meta: { allOf: [{ type: "object" }, { required: ["k"] }] } },
      required: ["meta"],
    },
    values: [{ meta: { k: 1 } }, { meta: {} }, { meta: 5 }, {}],
  },
  // If/then/else. Built via JSON.parse: a literal `then` property trips
  // the no-thenable lint, but `then` is a JSON Schema keyword here.
  {
    schema: JSON.parse(
      '{"if":{"properties":{"t":{"const":"n"}},"required":["t"]},"then":{"required":["n"]},"else":{"required":["s"]}}',
    ) as SchemaObject,
    values: [{ t: "n", n: 1 }, { t: "n" }, { s: "x" }, {}],
  },
];

describe("engine verdict equivalence with @oaverify/internal-schema (differential, incl. islands)", () => {
  let supported = 0;
  let skipped = 0;
  for (const { schema, values } of CORPUS) {
    for (const value of values) {
      it(`${JSON.stringify(schema)} vs ${JSON.stringify(value)}`, async () => {
        const streamed = await streamValid(schema, value);
        if (streamed === "unsupported") {
          skipped += 1;
          return;
        }
        supported += 1;
        expect(streamed).toBe(inMemoryValid(schema, value));
      });
    }
  }
  it("exercised a meaningful number of supported cases", () => {
    expect(supported).toBeGreaterThan(120);
    void skipped;
  });
});
