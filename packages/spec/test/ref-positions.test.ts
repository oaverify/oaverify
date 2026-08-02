import { describe, expect, it } from "vitest";
import { createMemoryReader, type DocumentReader, type SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

/**
 * A reader that records every URI it is asked for, so a test can assert
 * that an illegal position was not followed rather than inferring it
 * from the resolved document.
 */
function recordingReader(docs: Map<string, unknown>): {
  reader: DocumentReader;
  reads: string[];
} {
  const inner = createMemoryReader(docs);
  const reads: string[] = [];
  return {
    reads,
    reader: {
      canRead: (uri) => inner.canRead(uri),
      read: async (uri) => {
        reads.push(uri);
        return inner.read(uri);
      },
    },
  };
}

const BASE = {
  openapi: "3.1.0",
  info: { title: "X", version: "1" },
  paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
};

describe("$ref is followed only where OpenAPI defines one", () => {
  it("leaves a $ref in a tag description alone instead of reading it", async () => {
    // The Redocly shape that motivated this: a tag description pulling
    // in a markdown file. `description` is typed `string`, so the object
    // is author data and the file must never reach the reader.
    const { reader, reads } = recordingReader(
      new Map<string, unknown>([
        ["main.json", { ...BASE, tags: [{ name: "T", description: { $ref: "./flow.mdx" } }] }],
      ]),
    );
    const { document } = await resolveSpec({ reader, entry: "main.json" });

    expect(reads).toEqual(["main.json"]);
    expect((document as { tags: { description: unknown }[] }).tags[0]?.description).toEqual({
      $ref: "./flow.mdx",
    });
  });

  it("reports the unreadable file rather than crashing on its first byte", async () => {
    // Before position-awareness this threw a JSON parse error naming the
    // offending token. The document is now resolvable, and the illegal
    // position is left for the conformance pass to report.
    const { reader } = recordingReader(
      new Map<string, unknown>([
        ["main.json", { ...BASE, tags: [{ name: "T", description: { $ref: "./missing.mdx" } }] }],
      ]),
    );
    await expect(resolveSpec({ reader, entry: "main.json" })).resolves.toBeDefined();
  });

  it("does not follow a $ref inside an example value", async () => {
    const { reader, reads } = recordingReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            ...BASE,
            components: {
              examples: { E: { value: { $ref: "./payload.json" } } },
            },
          },
        ],
      ]),
    );
    await resolveSpec({ reader, entry: "main.json" });
    expect(reads).toEqual(["main.json"]);
  });

  it("does not follow a $ref inside a vendor extension", async () => {
    const { reader, reads } = recordingReader(
      new Map<string, unknown>([["main.json", { ...BASE, "x-vendor": { $ref: "./vendor.json" } }]]),
    );
    await resolveSpec({ reader, entry: "main.json" });
    expect(reads).toEqual(["main.json"]);
  });

  it("still follows every position the specification does define", async () => {
    const { reader, reads } = recordingReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/a": { $ref: "./path-item.json" },
              "/b": {
                get: {
                  parameters: [{ $ref: "./parameter.json" }],
                  requestBody: { $ref: "./request-body.json" },
                  responses: { "200": { $ref: "./response.json" } },
                },
              },
            },
            webhooks: { hook: { $ref: "./path-item.json" } },
            components: {
              headers: { H: { $ref: "./header.json" } },
              schemas: { S: { $ref: "./schema.json" } },
            },
          },
        ],
        ["path-item.json", { get: { responses: { "200": { description: "ok" } } } }],
        ["parameter.json", { name: "q", in: "query", schema: { type: "string" } }],
        ["request-body.json", { content: { "application/json": { schema: { type: "object" } } } }],
        ["response.json", { description: "ok" }],
        ["header.json", { schema: { type: "string" } }],
        ["schema.json", { type: "object" }],
      ]),
    );
    await resolveSpec({ reader, entry: "main.json" });

    expect(new Set(reads)).toEqual(
      new Set([
        "main.json",
        "path-item.json",
        "parameter.json",
        "request-body.json",
        "response.json",
        "header.json",
        "schema.json",
      ]),
    );
  });

  it("resolves a response header ref reached through a nested position", async () => {
    const { reader, reads } = recordingReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: {
              "/a": {
                get: {
                  responses: {
                    "200": { description: "ok", headers: { H: { $ref: "./header.json" } } },
                  },
                },
              },
            },
          },
        ],
        ["header.json", { schema: { type: "string" } }],
      ]),
    );
    await resolveSpec({ reader, entry: "main.json" });
    expect(reads).toContain("header.json");
  });

  it("holds the same line in the sync mirror", () => {
    const sources = new Map<string, unknown>([
      ["main.json", { ...BASE, tags: [{ name: "T", description: { $ref: "./flow.mdx" } }] }],
    ]);
    const reads: string[] = [];
    const reader: SyncDocumentReader = {
      canRead: (uri) => sources.has(uri),
      read: (uri) => {
        reads.push(uri);
        if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
        return structuredClone(sources.get(uri));
      },
    };
    const { document } = resolveSpecSync({ reader, entry: "main.json" });
    expect(reads).toEqual(["main.json"]);
    expect((document as { tags: { description: unknown }[] }).tags[0]?.description).toEqual({
      $ref: "./flow.mdx",
    });
  });
});
