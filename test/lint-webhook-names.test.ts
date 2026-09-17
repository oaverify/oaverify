import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkDocumentConformance } from "../packages/metaschema/src/conformance.js";
import { lintResolvedSpec } from "@oaverify/internal-spec";

describe.each(["3.1.0", "3.2.0"])("x-prefixed webhook names in %s", (openapi) => {
  it("treats webhook map keys as names and paths extensions as data", () => {
    const pathItem = {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $defs: { Dead: { type: "string" } } } },
            },
          },
        },
      },
    };
    const document = {
      openapi,
      info: { title: "webhooks", version: "1" },
      paths: { "x-data": pathItem },
      webhooks: { "x-event": pathItem },
    } as OpenAPIDocument;
    expect(checkDocumentConformance(document).issues).toEqual([]);
    expect(
      lintResolvedSpec(document)
        .filter((i) => i.code === "unreachable-defs")
        .map((i) => i.pointer),
    ).toEqual(["/webhooks/x-event/get/responses/200/content/application~1json/schema/$defs/Dead"]);
  });

  it("requires a Path Item even when a webhook name starts with x-", () => {
    const document = {
      openapi,
      info: { title: "webhooks", version: "1" },
      webhooks: { "x-event": 1 },
    };
    expect(checkDocumentConformance(document).issues).toContainEqual(
      expect.objectContaining({ pointer: "/webhooks/x-event", code: "type" }),
    );
  });
});
