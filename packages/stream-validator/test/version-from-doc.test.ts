/**
 * The operation helper and the spec analyzer read the OpenAPI minor from the
 * document. A minor is matched exactly: `3.10.0` is not 3.1 and `3.01.0` is
 * not 3.0, and an unknown one means raw JSON Schema unless overridden.
 */
import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { analyzeSpec, streamValidatorForOperation, type StreamVerdict } from "../src/index.js";
import { versionFromDoc } from "../src/openapi/body-schema.js";

const doc = (openapi: string, schema: SchemaOrBoolean): OpenAPIDocument =>
  ({
    openapi,
    info: { title: "t", version: "1" },
    paths: {
      "/a": {
        post: {
          operationId: "a",
          requestBody: { content: { "application/json": { schema } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

function verdictOf(
  document: OpenAPIDocument,
  value: unknown,
  options: Record<string, unknown> = {},
): Promise<StreamVerdict> {
  const validator = streamValidatorForOperation(
    document,
    { method: "post", path: "/a" },
    {
      policy: "detach",
      ...options,
    },
  );
  validator.on("error", () => {});
  validator.resume();
  const result = validator.result;
  validator.end(Buffer.from(JSON.stringify(value)));
  return result;
}

describe("versionFromDoc", () => {
  it.each([
    ["3.0.0", "3.0"],
    ["3.0.4", "3.0"],
    ["3.0", "3.0"],
    ["3.1.0", "3.1"],
    ["3.1.2", "3.1"],
    ["3.2.0", "3.2"],
    ["3.2.0-rc1", "3.2"],
  ])("maps %s to %s", (raw, expected) => {
    expect(versionFromDoc(raw)).toBe(expected);
  });

  it.each([
    "3.10.0",
    "3.11",
    "3.01.0",
    "3.20.0",
    "3.3.0",
    "4.0.0",
    "13.0.0",
    "3",
    "3.x",
    "",
    "v3.0",
  ])("leaves %j unknown", (raw) => {
    expect(versionFromDoc(raw)).toBeUndefined();
  });
});

describe("minor detection through the operation helper", () => {
  const boundary = { type: "number", minimum: 5, exclusiveMinimum: true } as SchemaOrBoolean;

  it("normalizes a real 3.0 document", async () => {
    expect((await verdictOf(doc("3.0.3", boundary), 5)).valid).toBe(false);
  });

  it("does not read 3.01.0 as 3.0: nullable does not widen under raw JSON Schema", async () => {
    const nullable = { type: "string", nullable: true } as SchemaOrBoolean;
    expect((await verdictOf(doc("3.0.3", nullable), null)).valid).toBe(true);
    expect((await verdictOf(doc("3.01.0", nullable), null)).valid).toBe(false);
  });

  it("does not read 3.10.0 as 3.1: format does not assert under raw JSON Schema", async () => {
    const email = { type: "string", format: "email" } as SchemaOrBoolean;
    expect((await verdictOf(doc("3.1.0", email), "nope")).valid).toBe(false);
    expect((await verdictOf(doc("3.10.0", email), "nope")).valid).toBe(true);
  });

  it("applies a $ref sibling under 3.01.0, which 3.0 would discard", async () => {
    const document = {
      ...doc("3.0.3", { $ref: "#/components/schemas/Q", maxProperties: 0 } as SchemaOrBoolean),
      components: { schemas: { Q: { type: "object" } } },
    } as OpenAPIDocument;
    expect((await verdictOf(document, { a: "x" })).valid).toBe(true);
    expect((await verdictOf({ ...document, openapi: "3.01.0" }, { a: "x" })).valid).toBe(false);
  });

  it("normalizes an unknown minor under an explicit 3.0 override", async () => {
    const nullable = { type: "string", nullable: true } as SchemaOrBoolean;
    const verdict = await verdictOf(doc("3.10.0", nullable), null, { openApiVersion: "3.0" });
    expect(verdict.valid).toBe(true);
  });

  // An unquoted YAML `openapi: 3.1` parses to a number, and a Swagger 2.0
  // document has no field at all.
  it.each([[3.1], [undefined]])("treats the non-string %j as unknown", async (openapi) => {
    const email = { type: "string", format: "email" } as SchemaOrBoolean;
    const document = { ...doc("3.1.0", email), openapi } as unknown as OpenAPIDocument;
    expect((await verdictOf(document, "nope")).valid).toBe(true);
  });

  it("honors an explicit override of an unknown minor", async () => {
    const email = { type: "string", format: "email" } as SchemaOrBoolean;
    const verdict = await verdictOf(doc("3.10.0", email), "nope", { openApiVersion: "3.1" });
    expect(verdict.valid).toBe(false);
  });
});

describe("minor detection through analyzeSpec", () => {
  it("analyzes 3.10.0 as raw JSON Schema and honors an override", () => {
    const email = { type: "string", format: "email", maxLength: 10 } as SchemaOrBoolean;
    const classification = (openapi: string, options = {}) =>
      analyzeSpec(doc(openapi, email), options).operations[0]?.bodies[0]?.report?.classification;
    expect(classification("3.1.0")).toBe("buffer");
    expect(classification("3.10.0")).toBe("streamable");
    expect(classification("3.10.0", { openApiVersion: "3.1" })).toBe("buffer");
  });
});
