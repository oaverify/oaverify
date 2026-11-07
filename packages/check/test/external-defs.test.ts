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

describe("a hoisted external referenced under $id", () => {
  // The resolver hoists `ext.json` to components.schemas.ext and writes the use
  // site as `#/components/schemas/ext`. Read against the enclosing $id, as the
  // compiler reads it, that fragment does not reach the component, so the lint
  // reports it unused beside the fatal finding the document already carries.
  it("reports unused-component beside malformed-schema", async () => {
    const sources = new Map<string, unknown>([
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "T", version: "1" },
          paths: {
            "/a": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Outer" } },
                  },
                },
                responses: { "200": { description: "OK" } },
              },
            },
          },
          components: {
            schemas: {
              Outer: { $id: "https://example.com/outer", properties: { x: { $ref: "ext.json" } } },
            },
          },
        },
      ],
      ["ext.json", { type: "string" }],
    ]);
    const resolved = await loadSpec({ entry: "entry.json", reader: createMemoryReader(sources) });
    const findings = checkSpec(resolved).map((f) => [f.code, f.severity, f.target?.pointer]);
    expect(findings).toContainEqual([
      "malformed-schema",
      "fatal",
      expect.stringMatching(/^\/components\/schemas\/Outer/),
    ]);
    expect(findings).toContainEqual(["unused-component", "warning", "/components/schemas/ext"]);
  });
});

describe("an external file with a root $id", () => {
  // The resolver rewrites the file's own `#/$defs/Tag` to the hoisted copy's
  // document pointer, which read against the file's $id reaches neither the
  // copy nor the original definition. The document is already fatal.
  it("reports the hoisted copy and the original definition beside malformed-schema", async () => {
    const sources = new Map<string, unknown>([
      [
        "entry.json",
        {
          openapi: "3.1.0",
          info: { title: "T", version: "1" },
          paths: {
            "/a": {
              post: {
                requestBody: { content: { "application/json": { schema: { $ref: "pet.json" } } } },
                responses: { "200": { description: "OK" } },
              },
            },
          },
        },
      ],
      [
        "pet.json",
        {
          $id: "https://example.com/pet",
          $defs: { Tag: {} },
          properties: { t: { $ref: "#/$defs/Tag" } },
        },
      ],
    ]);
    const resolved = await loadSpec({ entry: "entry.json", reader: createMemoryReader(sources) });
    const findings = checkSpec(resolved).map((f) => [f.code, f.target?.pointer]);
    expect(findings.map(([code]) => code)).toContain("malformed-schema");
    expect(findings).toContainEqual(["unused-component", "/components/schemas/pet__defs_Tag"]);
    expect(findings).toContainEqual(["unreachable-defs", "/components/schemas/pet/$defs/Tag"]);
  });
});

describe("an empty $id", () => {
  const checkCodes = async (schemas: Record<string, unknown>) => {
    const entry = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/a": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Outer" } } },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: { schemas },
    };
    const reader = createMemoryReader(new Map([["entry.json", entry]]));
    return checkSpec(await loadSpec({ entry: "entry.json", reader })).map((f) => f.code);
  };

  // With no non-empty $id above it, the compiler reads the fragment against the document.
  it("reads a top-level one against the document", async () => {
    const codes = await checkCodes({
      Outer: { $id: "", $ref: "#/components/schemas/T" },
      T: { type: "string" },
    });
    expect(codes).not.toContain("malformed-schema");
    expect(codes).not.toContain("unused-component");
  });

  // Under a non-empty $id, the compiler reads the fragment against the nested schema.
  it("reads a nested one against its own schema", async () => {
    const codes = await checkCodes({
      Outer: {
        $id: "https://example.com/outer",
        properties: { x: { $id: "", $defs: { Inner: { type: "string" } }, $ref: "#/$defs/Inner" } },
      },
    });
    expect(codes).not.toContain("malformed-schema");
    expect(codes).not.toContain("unreachable-defs");
  });
});
