import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  composeReaders,
  createFileReader,
  createHttpReader,
  createMemoryReader,
  loadSpec,
  sourceOf,
  type DocumentReader,
  type SourceAddress,
} from "@oaverify/internal-spec";
import { createSmartHttpReader, createYamlFileReader, loadSpecSync } from "../src/index.js";

/**
 * Reader coverage matrix: every path a document can arrive by, and what
 * provenance says about a node that arrived that way.
 *
 * This package is the only one that can see all of them at once (the
 * YAML readers live here, the rest in `@oaverify/internal-spec`), which
 * is why the matrix lives here rather than beside the resolver.
 *
 * The claim under test is that provenance is a property of the walk and
 * not of the reader: `uri` comes from the URI the resolver derived, so
 * every row answers with the same shape, and the only thing that varies
 * is the URI itself. A reader that retains source positions could add
 * to that answer later; none of them subtract from it.
 */

const ENTRY_JSON = {
  openapi: "3.1.0",
  info: { title: "X", version: "1" },
  paths: {
    "/orders": {
      post: {
        responses: { "200": { description: "ok" } },
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "./order.json#/components/schemas/Order" } },
          },
        },
      },
    },
  },
};

const ORDER_JSON = {
  components: { schemas: { Order: { type: "object", required: ["id", "nope"] } } },
};

const ENTRY_YAML = `openapi: 3.1.0
info: { title: X, version: "1" }
paths:
  /orders:
    post:
      responses: { "200": { description: ok } }
      requestBody:
        content:
          application/json:
            schema:
              $ref: "./order.yaml#/components/schemas/Order"
`;

const ORDER_YAML = `components:
  schemas:
    Order:
      type: object
      required: [id, nope]
`;

/** Where the defect in the external file should be reported from. */
function expected(orderUri: string, entryUri: string): SourceAddress {
  return {
    uri: orderUri,
    pointer: "/components/schemas/Order/required/1",
    via: [
      {
        uri: entryUri,
        pointer: "/paths/~1orders/post/requestBody/content/application~1json/schema",
      },
    ],
  };
}

/** The resolved pointer the finding for that defect would carry. */
const RESOLVED_POINTER = "/components/schemas/Order/required/1";

async function addressVia(
  reader: DocumentReader,
  entry: string,
): Promise<SourceAddress | undefined> {
  const { regions } = await loadSpec({ reader, entry, provenance: true });
  expect(regions).toBeDefined();
  return sourceOf(regions ?? [], RESOLVED_POINTER);
}

function stubFetch(bodies: Record<string, { body: string; type: string }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const hit = bodies[String(url)];
      if (hit === undefined) return new Response("not found", { status: 404 });
      return new Response(hit.body, { status: 200, headers: { "Content-Type": hit.type } });
    }),
  );
}

describe("reader coverage matrix", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-provenance-"));
    writeFileSync(join(dir, "entry.json"), JSON.stringify(ENTRY_JSON));
    writeFileSync(join(dir, "order.json"), JSON.stringify(ORDER_JSON));
    writeFileSync(join(dir, "entry.yaml"), ENTRY_YAML);
    writeFileSync(join(dir, "order.yaml"), ORDER_YAML);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("filesystem, JSON: createFileReader", async () => {
    expect(await addressVia(createFileReader(dir), "entry.json")).toEqual(
      expected("order.json", "entry.json"),
    );
  });

  it("filesystem, YAML: createYamlFileReader", async () => {
    const reader = composeReaders([createYamlFileReader(dir), createFileReader(dir)]);
    expect(await addressVia(reader, "entry.yaml")).toEqual(expected("order.yaml", "entry.yaml"));
  });

  it("HTTP, JSON: createHttpReader", async () => {
    stubFetch({
      "https://example.com/entry.json": {
        body: JSON.stringify(ENTRY_JSON),
        type: "application/json",
      },
      "https://example.com/order.json": {
        body: JSON.stringify(ORDER_JSON),
        type: "application/json",
      },
    });
    expect(await addressVia(createHttpReader(), "https://example.com/entry.json")).toEqual(
      expected("https://example.com/order.json", "https://example.com/entry.json"),
    );
  });

  it("HTTP, YAML: createSmartHttpReader", async () => {
    stubFetch({
      "https://example.com/entry.yaml": { body: ENTRY_YAML, type: "application/yaml" },
      "https://example.com/order.yaml": { body: ORDER_YAML, type: "application/yaml" },
    });
    expect(await addressVia(createSmartHttpReader(), "https://example.com/entry.yaml")).toEqual(
      expected("https://example.com/order.yaml", "https://example.com/entry.yaml"),
    );
  });

  it("in-memory: createMemoryReader", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        ["entry.json", ENTRY_JSON],
        ["order.json", ORDER_JSON],
      ]),
    );
    expect(await addressVia(reader, "entry.json")).toEqual(expected("order.json", "entry.json"));
  });

  it("sync mirror: loadSpecSync with the default YAML reader", () => {
    const { regions } = loadSpecSync({ entry: join(dir, "entry.yaml"), provenance: true });
    expect(regions).toBeDefined();
    expect(sourceOf(regions ?? [], RESOLVED_POINTER)).toEqual(
      expected(join(dir, "order.yaml"), join(dir, "entry.yaml")),
    );
  });

  it("every row agrees except for the URI", async () => {
    // The shape is the reader-independent part of the claim, so it is
    // asserted as a shape rather than only per row.
    const rows = [
      await addressVia(createFileReader(dir), "entry.json"),
      await addressVia(
        composeReaders([createYamlFileReader(dir), createFileReader(dir)]),
        "entry.yaml",
      ),
    ];
    for (const row of rows) {
      expect(row?.pointer).toBe("/components/schemas/Order/required/1");
      expect(row?.via).toHaveLength(1);
    }
  });
});
