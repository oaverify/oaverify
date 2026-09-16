import { describe, expect, it } from "vitest";
import { createMemoryReader, loadSpec, loadSpecSync } from "@oaverify/internal-spec";
import { createValidator } from "@oaverify/internal-validator";
import { checkSpec } from "../src/check.js";

function documents(): Map<string, unknown> {
  return new Map([
    [
      "entry.json",
      {
        openapi: "3.1.0",
        info: { title: "External definitions", version: "1" },
        paths: {
          "/probe": {
            post: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Probe" } },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
        components: { schemas: { Probe: { $ref: "body.json" } } },
      },
    ],
    [
      "body.json",
      {
        type: "object",
        $defs: { Used: { type: "string" }, Dead: { type: "number" } },
        properties: { code: { $ref: "#/$defs/Used" } },
      },
    ],
  ]);
}

describe("external $defs reachability", () => {
  it("distinguishes source locations even when a memory reader reuses an object", async () => {
    const sharedDefs = { Used: { type: "string" } };
    const sources = documents();
    sources.set("body.json", {
      $defs: {
        Reached: { $defs: sharedDefs },
        Dead: { $defs: sharedDefs },
      },
      properties: { code: { $ref: "#/$defs/Reached/$defs/Used" } },
    });
    const resolved = await loadSpec({ entry: "entry.json", reader: createMemoryReader(sources) });
    expect(
      checkSpec(resolved)
        .filter((finding) => finding.code === "unreachable-defs")
        .map((finding) => finding.target?.pointer),
    ).toEqual([
      "/components/schemas/Probe/$defs/Dead",
      "/components/schemas/Probe/$defs/Dead/$defs/Used",
    ]);
  });

  it.each([
    {
      name: "equal but separately declared definitions",
      schema: {
        $defs: { Used: { type: "string" }, Dead: { type: "string" } },
        properties: { code: { $ref: "#/$defs/Used" } },
      },
    },
    {
      name: "boolean definitions",
      schema: {
        $defs: { Used: true, Dead: true },
        properties: { code: { $ref: "#/$defs/Used" } },
      },
    },
    {
      name: "escaped and percent-encoded definition names",
      schema: {
        $defs: { "Used/~ space": { type: "string" }, Dead: { type: "string" } },
        properties: { code: { $ref: "#/$defs/Used~1~0%20space" } },
      },
    },
    {
      name: "references to a descendant of a definition",
      schema: {
        $defs: { Used: { properties: { code: { type: "string" } } }, Dead: true },
        properties: { code: { $ref: "#/$defs/Used/properties/code" } },
      },
    },
  ])("preserves reachability for $name", async ({ schema }) => {
    const sources = documents();
    sources.set("body.json", schema);
    const resolved = await loadSpec({ entry: "entry.json", reader: createMemoryReader(sources) });
    expect(
      checkSpec(resolved)
        .filter((finding) => finding.code === "unreachable-defs")
        .map((finding) => finding.target?.pointer),
    ).toEqual(["/components/schemas/Probe/$defs/Dead"]);
  });

  for (const provenance of [false, true]) {
    for (const sync of [false, true]) {
      it(`keeps genuinely dead definitions and ignores hoisted used copies (sync=${sync}, provenance=${provenance})`, async () => {
        const sources = documents();
        const reader = {
          canRead: (uri: string) => sources.has(uri),
          read: (uri: string) => sources.get(uri),
        };
        const options = { entry: "entry.json", lint: true, provenance };
        const resolved = sync
          ? loadSpecSync({ ...options, reader: reader })
          : await loadSpec({ ...options, reader: createMemoryReader(sources) });
        expect(
          resolved.specHygieneIssues
            .filter((issue) => issue.code === "unreachable-defs")
            .map((issue) => issue.pointer),
        ).toEqual(["/components/schemas/Probe/$defs/Dead"]);
        const validator = createValidator(resolved.document, { output: "predicate" });
        const request = { method: "POST", path: "/probe", contentType: "application/json" };
        expect(validator.validateRequest({ ...request, body: { code: "accepted" } })).toBe(true);
        expect(validator.validateRequest({ ...request, body: { code: 123 } })).toBe(false);
        expect(
          checkSpec(resolved)
            .filter((finding) => finding.code === "unreachable-defs")
            .map((finding) => finding.target?.pointer),
        ).toEqual(["/components/schemas/Probe/$defs/Dead"]);
      });
    }
  }
});
