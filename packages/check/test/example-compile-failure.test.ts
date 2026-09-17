import { expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkDocumentExamples } from "@oaverify/internal-validator";
import { checkSpec } from "../src/check.js";
import { parseFindingTerms, resolveFindingSelection } from "../src/selection.js";

it("keeps standalone compile failures distinct from checker-owned withholding", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "examples", version: "1" },
    paths: {},
    components: {
      schemas: {
        Malformed: { type: "nonsense", example: 1 },
        Unsupported: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "nonsense",
          example: 1,
        },
        Invalid: { type: "string", example: 1 },
        Valid: { type: "string", example: "ok" },
      },
    },
  };
  const resolved = await loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", document]])),
  });
  expect(checkDocumentExamples(resolved.document).map((i) => [i.code, i.pointer])).toEqual([
    ["example-uncheckable", "/components/schemas/Malformed/example"],
    ["example-uncheckable", "/components/schemas/Unsupported/example"],
    ["example-invalid", "/components/schemas/Invalid/example"],
  ]);
  const selected = (terms: string) =>
    checkSpec(resolved, { findings: resolveFindingSelection(parseFindingTerms(terms)) });
  expect(
    selected("schema,examples")
      .map((i) => i.code)
      .sort(),
  ).toEqual(["example-invalid", "malformed-schema", "unsupported-schema-dialect"]);
  // Examples-only selection still hides checker-owned compile failures.
  // That existing selection limitation is outside standalone issue #1106.
  expect(selected("examples")).toEqual([
    expect.objectContaining({
      code: "example-invalid",
      target: expect.objectContaining({ pointer: "/components/schemas/Invalid/example" }),
    }),
  ]);
});
