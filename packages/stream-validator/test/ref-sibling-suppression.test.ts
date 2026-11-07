/**
 * Under a dialect that suppresses `$ref` siblings, the compiler's decision is
 * the reference: a discarded keyword neither blocks streaming, nor counts as
 * buffering, nor affects the verdict.
 */
import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, oas30Dialect, openapi31Dialect } from "@oaverify/internal-schema";
import { analyzeSpec, analyzeStreamability, createStreamValidator } from "../src/index.js";

const enc = new TextEncoder();

async function streamed(schema: SchemaOrBoolean, value: unknown, dialect = oas30Dialect) {
  const validator = createStreamValidator(schema, {
    dialect,
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
  });
  validator.on("error", () => {});
  validator.resume();
  const result = validator.result;
  validator.end(Buffer.from(enc.encode(JSON.stringify(value))));
  return (await result).valid;
}

const withSibling = (sibling: Record<string, unknown>): SchemaObject =>
  ({
    type: "object",
    properties: { a: { $ref: "#/$defs/S", ...sibling } },
    $defs: { S: { type: "object" } },
  }) as SchemaObject;

const DISCARDED: Array<[string, Record<string, unknown>]> = [
  ["a keyword the stream rejects", { unevaluatedProperties: false }],
  ["a keyword nothing knows", { bogus: 1 }],
  ["a scalar constraint", { required: ["q"] }],
  ["a composition", { allOf: [{ required: ["q"] }] }],
  ["a buffering keyword", { uniqueItems: true, contains: {} }],
  ["a reject below a discarded position", { properties: { z: { unevaluatedItems: false } } }],
  ["a dangling reference below a discarded position", { allOf: [{ $ref: "#/$defs/none" }] }],
];

describe("OAS 3.0 $ref sibling suppression", () => {
  it.each(DISCARDED)("the verdict matches the compiler for %s", async (_name, sibling) => {
    const schema = withSibling(sibling);
    const value = { a: {} };
    const compiled = compileSchema(schema, { dialect: oas30Dialect }).validate(value).valid;
    expect(compiled).toBe(true);
    expect(await streamed(schema, value)).toBe(compiled);
  });

  it.each(DISCARDED)("the analyzer reports no buffering for %s", (_name, sibling) => {
    expect(analyzeStreamability(withSibling(sibling), { dialect: oas30Dialect })).toEqual(
      analyzeStreamability(withSibling({}), { dialect: oas30Dialect }),
    );
  });

  it("still applies the reference's target", async () => {
    const schema = withSibling({ required: ["q"] });
    expect(await streamed(schema, { a: 1 })).toBe(false);
  });

  it("refuses a root $ref into its own discarded $defs, as the compiler does", () => {
    const schema = { $ref: "#/$defs/S", $defs: { S: { type: "object" } } } as SchemaObject;
    expect(() => compileSchema(schema, { dialect: oas30Dialect })).toThrow();
    expect(() => createStreamValidator(schema, { dialect: oas30Dialect })).toThrow(/\$defs\/S/);
  });

  it("keeps siblings under a dialect that honors them", async () => {
    const schema = withSibling({ required: ["q"] });
    expect(await streamed(schema, { a: {} }, openapi31Dialect)).toBe(false);
    expect(
      analyzeStreamability(withSibling({ uniqueItems: true }), { dialect: openapi31Dialect })
        .classification,
    ).toBe("buffer");
  });

  it("does not drop the components an operation body carries", () => {
    const report = analyzeSpec(
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/a": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/B" } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: { schemas: { B: { type: "object" } } },
      } as never,
      { dialect: oas30Dialect },
    );
    expect(report.operations[0]?.bodies[0]?.report?.classification).toBe("streamable");
  });

  describe("a reference whose target buffers", () => {
    const target = { type: "object", dependentSchemas: { x: { required: ["y"] } } };
    const buffering = (sibling: Record<string, unknown>): SchemaObject =>
      ({
        type: "object",
        properties: { a: { $ref: "#/$defs/B", ...sibling } },
        $defs: { B: target },
      }) as SchemaObject;

    it.each([
      ["with a discarded sibling", { unevaluatedProperties: false }],
      ["with no sibling", {}],
    ])("validates %s rather than failing mid-stream", async (_name, sibling) => {
      expect(await streamed(buffering(sibling), { a: { x: 1, y: 1 } })).toBe(true);
      expect(await streamed(buffering(sibling), { a: { x: 1 } })).toBe(false);
    });

    it("reports the target's own error at the member", async () => {
      const validator = createStreamValidator(buffering({}), {
        dialect: oas30Dialect,
        policy: "detach",
        maxErrors: Number.POSITIVE_INFINITY,
      });
      validator.on("error", () => {});
      validator.resume();
      const result = validator.result;
      validator.end(Buffer.from(JSON.stringify({ a: { x: 1 } })));
      expect((await result).violations.map((v) => [v.code, v.path])).toContainEqual([
        "required",
        ["a", "y"],
      ]);
    });
  });

  it("does not assert a discarded format under unknownFormats: error", () => {
    const schema = withSibling({ format: "nope" });
    expect(() =>
      createStreamValidator(schema, { dialect: oas30Dialect, unknownFormats: "error" }),
    ).not.toThrow();
  });

  it("does not treat a nested components beside a $ref as a container", () => {
    const schema = {
      properties: {
        a: { $ref: "#/$defs/S", components: { schemas: { X: { type: "string" } } } },
        b: { $ref: "#/properties/a/components/schemas/X" },
      },
      $defs: { S: { type: "object" } },
    } as SchemaObject;
    expect(() => compileSchema(schema, { dialect: oas30Dialect })).toThrow();
    expect(() => createStreamValidator(schema, { dialect: oas30Dialect })).toThrow(/unresolvable/);
  });

  // Known gap, pinned so that closing it is visible. The compiler discards this
  // sibling too; `openApiVersion: "3.0"` has the same limit.
  it("keeps the siblings of a target outside the subschema positions", async () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/x-extra/S" } },
      "x-extra": { S: { $ref: "#/$defs/S", required: ["q"] } },
      $defs: { S: { type: "object" } },
    } as SchemaObject;
    expect(compileSchema(schema, { dialect: oas30Dialect }).validate({ a: {} }).valid).toBe(true);
    expect(await streamed(schema, { a: {} })).toBe(false);
  });

  it("does not rewrite an enum member a reference happens to target", async () => {
    const member = { $ref: "#/$defs/S", required: ["q"] };
    const schema = {
      enum: [member],
      allOf: [{ $ref: "#/enum/0" }],
      $defs: { S: { type: "object" } },
    } as unknown as SchemaObject;
    expect(compileSchema(schema, { dialect: oas30Dialect }).validate(member).valid).toBe(true);
    expect(await streamed(schema, member)).toBe(true);
  });

  it("handles a hand-built cycle", async () => {
    const schema = { type: "object" } as SchemaObject;
    schema.properties = { child: schema };
    expect(await streamed(schema, { child: {} })).toBe(true);
    expect(await streamed(schema, { child: 1 })).toBe(false);
    expect(analyzeStreamability(schema, { dialect: oas30Dialect }).classification).toBe(
      "streamable",
    );
  });

  it("does not expand a shared node once per path", async () => {
    let node: SchemaObject = { type: "object" };
    for (let i = 0; i < 40; i += 1) node = { properties: { a: node, b: node } } as SchemaObject;
    expect(await streamed(node, {})).toBe(true);
  });

  it("gives the same report through openApiVersion on a 3.0 document", () => {
    const report = analyzeStreamability(withSibling({ uniqueItems: true, contains: {} }), {
      openApiVersion: "3.0",
    });
    expect(report.classification).toBe("streamable");
  });
});
