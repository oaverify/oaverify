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
  const result = v.result;
  v.end(Buffer.from(enc.encode(JSON.stringify(value))));
  return (await result).valid;
}

function inMemory(schema: SchemaOrBoolean, value: unknown): boolean {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
  }).validate(value).valid;
}

/**
 * Comprehensive composition coverage: this is the safety net for the TEE
 * refactor (which changes composition from buffer-and-delegate to forward
 * streaming). Every (schema, value) pair must produce the same verdict as
 * @oaverify/internal-schema's in-memory engine; the refactor must keep them green.
 *
 * Each schema is probed against a broad set of diverse values, so the
 * matrix exercises exactly-one (`oneOf`) overlap, keyword-applies-only-to-
 * type subtleties, nesting, refs, and composition-with-siblings.
 */
const PROBES: unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -2,
  3.14,
  6,
  "",
  "a",
  "abc",
  "123",
  [],
  [1],
  [1, 2, 3],
  ["a", "b"],
  [1, "x"],
  {},
  { a: 1 },
  { a: "x" },
  { a: 1, b: 2 },
  { b: 2 },
  { t: "a", x: 1 },
  { t: "a" },
  { y: 1 },
  { nested: { deep: 1 } },
  [{ a: 1 }, { b: 2 }],
];

// `then` is a JSON Schema keyword. Build via a JSON string so it never
// appears as an object property (the no-thenable lint flags those).
const ite = (cond: object, t: object, e: object): SchemaObject =>
  JSON.parse(
    `{"if":${JSON.stringify(cond)},"then":${JSON.stringify(t)},"else":${JSON.stringify(e)}}`,
  ) as SchemaObject;

const SCHEMAS: SchemaObject[] = [
  // allOf
  { allOf: [{ type: "integer" }, { minimum: 0 }] },
  { allOf: [{ type: "string" }, { minLength: 2 }] },
  { allOf: [] },
  { allOf: [{ type: "object" }, { required: ["a"] }] },
  {
    allOf: [{ properties: { a: { type: "integer" } } }, { properties: { b: { type: "string" } } }],
  },
  { allOf: [{ type: "integer" }, { type: "string" }] }, // unsatisfiable
  // anyOf
  { anyOf: [{ type: "string" }, { type: "integer" }] },
  { anyOf: [{ type: "object" }, { type: "array" }] },
  { anyOf: [] },
  { anyOf: [{ const: 1 }, { const: 2 }, { const: 3 }] },
  { anyOf: [{ required: ["a"] }, { required: ["b"] }] },
  // oneOf (exactly-one; includes deliberately-overlapping branches)
  { oneOf: [{ type: "integer" }, { type: "string" }] },
  { oneOf: [{ minimum: 0 }, { maximum: 10 }] },
  {
    oneOf: [
      { type: "number", multipleOf: 2 },
      { type: "number", multipleOf: 3 },
    ],
  },
  { oneOf: [{ required: ["a"] }, { required: ["b"] }] },
  // not
  { not: { type: "null" } },
  { not: { type: "object" } },
  { not: { required: ["a"] } },
  { not: { not: { type: "string" } } },
  // if/then/else
  ite({ type: "integer" }, { minimum: 0 }, { type: "string" }),
  ite(
    { properties: { t: { const: "a" } }, required: ["t"] },
    { required: ["x"] },
    { required: ["y"] },
  ),
  JSON.parse('{"if":{"type":"integer"},"then":{"multipleOf":2}}') as SchemaObject, // no else
  JSON.parse('{"if":{"type":"string"},"else":{"type":"integer"}}') as SchemaObject, // no then
  // nested composition
  { allOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }, { not: { const: 0 } }] },
  { anyOf: [{ allOf: [{ type: "integer" }, { minimum: 5 }] }, { type: "string" }] },
  { oneOf: [{ allOf: [{ type: "object" }, { required: ["a"] }] }, { type: "array" }] },
  { not: { oneOf: [{ const: 1 }, { const: 2 }] } },
  // composition nested under stream applicators
  { type: "object", properties: { x: { oneOf: [{ type: "integer" }, { type: "string" }] } } },
  { type: "array", items: { anyOf: [{ type: "integer" }, { type: "null" }] } },
  // composition with $ref branches
  { allOf: [{ $ref: "#/$defs/Pos" }], $defs: { Pos: { type: "integer", minimum: 0 } } },
  {
    oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
    $defs: { A: { type: "object", required: ["a"] }, B: { type: "object", required: ["b"] } },
  },
  // composition with sibling validation keywords
  { type: "object", properties: { n: { type: "integer" } }, allOf: [{ required: ["n"] }] },
  { type: "integer", anyOf: [{ minimum: 100 }, { maximum: -100 }] },
];

describe("composition differential vs @oaverify/internal-schema (TEE safety net)", () => {
  for (const schema of SCHEMAS) {
    for (const value of PROBES) {
      it(`${JSON.stringify(schema)} vs ${JSON.stringify(value) ?? "undefined"}`, async () => {
        expect(await streamVerdict(schema, value)).toBe(inMemory(schema, value));
      });
    }
  }
});
