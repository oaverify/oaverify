import { checkSpec } from "../src/check.js";
import { selectionForClasses } from "../src/selection.js";
import { expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkDocumentExamples } from "@oaverify/internal-validator";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkDocumentFormats, KNOWN_FORMATS } from "../src/format-check.js";

const document = (mediaType: unknown): OpenAPIDocument =>
  ({
    openapi: "3.2.0",
    info: { title: "T", version: "1" },
    paths: {},
    components: { mediaTypes: { M: mediaType } },
  }) as OpenAPIDocument;

it("walks media components, item schemas and recursive encoding headers", () => {
  let format = 0;
  const schema = () => ({ type: "string", format: `custom-${format++}` });
  const doc = document({
    schema: schema(),
    itemSchema: schema(),
    example: 7,
    encoding: { p: { headers: { h: { schema: schema(), example: 7 } } } },
    prefixEncoding: [{ itemEncoding: { headers: { h: { schema: schema(), example: 7 } } } }],
    itemEncoding: {
      prefixEncoding: [{ encoding: { p: { headers: { h: { schema: schema(), example: 7 } } } } }],
    },
  });
  expect(checkDocumentFormats(doc, KNOWN_FORMATS).map((f) => f.pointer)).toEqual([
    "/components/mediaTypes/M/schema/format",
    "/components/mediaTypes/M/itemSchema/format",
    "/components/mediaTypes/M/encoding/p/headers/h/schema/format",
    "/components/mediaTypes/M/prefixEncoding/0/itemEncoding/headers/h/schema/format",
    "/components/mediaTypes/M/itemEncoding/prefixEncoding/0/encoding/p/headers/h/schema/format",
  ]);
  expect(checkDocumentExamples(doc).map((f) => f.pointer)).toEqual([
    "/components/mediaTypes/M/example",
    "/components/mediaTypes/M/encoding/p/headers/h/example",
    "/components/mediaTypes/M/prefixEncoding/0/itemEncoding/headers/h/example",
    "/components/mediaTypes/M/itemEncoding/prefixEncoding/0/encoding/p/headers/h/example",
  ]);
});

it("resolves external schemas at 3.2 positions and retains their source", async () => {
  const schema = { $ref: "shared.json" };
  const doc = document({
    itemSchema: schema,
    prefixEncoding: [{ itemEncoding: { headers: { h: { schema } } } }],
  });
  const resolved = await loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(
      new Map<string, unknown>([
        ["entry.json", doc],
        ["shared.json", { type: "string", format: "iban" }],
      ]),
    ),
    provenance: true,
  });
  const media = (
    resolved.document.components as unknown as {
      mediaTypes: Record<string, { itemSchema: { $ref: string } }>;
    }
  ).mediaTypes.M!;
  expect(media.itemSchema.$ref).toMatch(/^#\/components\/schemas\//);
  const formats = checkDocumentFormats(resolved.document, KNOWN_FORMATS);
  expect(formats).toHaveLength(1);
  const finding = checkSpec(resolved, { findings: selectionForClasses(["schema"]) }).find(
    (f) => f.code === "format-not-validated",
  );
  expect(finding?.target?.source?.uri).toContain("shared.json");
  expect(formats[0]!.pointer).toMatch(/^\/components\/schemas\//);
  expect(JSON.stringify(resolved.document)).not.toContain('"shared.json"');
});

it.each([null, [], 7])("ignores malformed encoding containers: %j", (value) => {
  const doc = document({ encoding: value, prefixEncoding: value, itemEncoding: value });
  expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([]);
});

it("leaves schema-shaped media examples as data", () => {
  const doc = document({
    example: {
      itemSchema: { format: "iban" },
      prefixEncoding: [{ headers: { h: { schema: { format: "iban" } } } }],
    },
  });
  expect(checkDocumentFormats(doc, KNOWN_FORMATS)).toEqual([]);
});
