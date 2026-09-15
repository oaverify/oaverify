import type { OpenAPIDocument } from "@oaverify/internal-core";
import { expect, it } from "vitest";
import { checkDocumentFormats, checkDocumentRedos, KNOWN_FORMATS } from "../src/index.js";

const DRAFT7 = "http://json-schema.org/draft-07/schema#";
const JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const OAS = "https://spec.openapis.org/oas/3.1/dialect/base";
const assertions = { format: "vendor", pattern: "^(a+)+$" };
const document = (schemas: Record<string, unknown>, extra = {}): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas },
    ...extra,
  }) as OpenAPIDocument;

it("includes referenced schema targets in standalone observations", () => {
  const doc = document(
    { Use: { $ref: "#/x-schema" }, Local: { ...assertions } },
    {
      "x-schema": assertions,
    },
  );
  expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([
    expect.objectContaining({
      pointer: "/components/schemas/Local/format",
      message: expect.stringContaining("2 positions use it"),
    }),
  ]);
  expect(checkDocumentRedos(doc).map((f) => f.pointer)).toEqual([
    "/components/schemas/Local/pattern",
    "/x-schema/pattern",
  ]);
});

it("applies effective dialects in standalone observations", () => {
  const doc = document(
    {
      Unsupported: {
        ...assertions,
        $defs: {
          Supported: { ...assertions, $id: "https://example.test/nested", $schema: OAS },
        },
      },
      Annotation: { ...assertions, $schema: JSON_SCHEMA },
      Override: { ...assertions, $schema: OAS },
    },
    { jsonSchemaDialect: DRAFT7 },
  );
  expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([
    expect.objectContaining({
      pointer: "/components/schemas/Unsupported/$defs/Supported/format",
      message: expect.stringContaining("2 positions use it"),
    }),
  ]);
  expect(checkDocumentRedos(doc).map((f) => f.pointer)).toEqual([
    "/components/schemas/Unsupported/$defs/Supported/pattern",
    "/components/schemas/Annotation/pattern",
    "/components/schemas/Override/pattern",
  ]);
});

it.each(["3.0.3", "3.1.0"])(
  "uses the %s ref-sibling policy in standalone observations",
  (openapi) => {
    const doc = document(
      {
        Base: {},
        Use: {
          $ref: "#/components/schemas/Base",
          ...assertions,
          patternProperties: { "^(b+)+$": {} },
        },
      },
      { openapi },
    );
    expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toHaveLength(openapi === "3.0.3" ? 0 : 1);
    expect(checkDocumentRedos(doc)).toHaveLength(openapi === "3.0.3" ? 0 : 2);
  },
);
