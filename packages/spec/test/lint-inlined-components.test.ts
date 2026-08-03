import { describe, expect, it } from "vitest";
import { createMemoryReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { loadSpec } from "../src/load.js";
import { lintResolvedSpec } from "../src/lint.js";
import type { SpecOverlay } from "../src/overlay.js";

/**
 * `unused-component` and the components resolution inlines (#612).
 *
 * A non-schema component referenced from another document is inlined at
 * the use site, so the resolved document holds its content and reaches
 * nothing at the component. The rule grades the resolved document, so
 * on its own it can only call that unused. The resolver knows better
 * and says so through {@link ResolvedSpec.inlinedComponents}.
 */

const files = () =>
  new Map<string, unknown>([
    [
      "main.json",
      {
        openapi: "3.1.0",
        info: { title: "X", version: "1" },
        paths: { "/pets": { $ref: "./paths/pets.json" } },
        components: {
          parameters: {
            PageSize: { name: "pageSize", in: "query", schema: { type: "integer" } },
            NeverUsed: { name: "nope", in: "query", schema: { type: "string" } },
          },
        },
      },
    ],
    [
      "paths/pets.json",
      {
        get: {
          parameters: [{ $ref: "../main.json#/components/parameters/PageSize" }],
          responses: { "200": { description: "ok" } },
        },
      },
    ],
  ]);

describe("a component reached across documents and inlined", () => {
  it("is named by the resolver", async () => {
    const resolved = await resolveSpec({ reader: createMemoryReader(files()), entry: "main.json" });
    expect(resolved.inlinedComponents).toEqual(["/components/parameters/PageSize"]);
  });

  it("is not reported unused, and a genuinely unused one still is", async () => {
    const { specHygieneIssues } = await resolveSpec({
      reader: createMemoryReader(files()),
      entry: "main.json",
      lint: true,
    });
    expect(specHygieneIssues.map((i) => i.pointer)).toEqual(["/components/parameters/NeverUsed"]);
  });

  it("is reported again when the lint pass is called without the list", async () => {
    // The rule itself is unchanged: given only the document, it still
    // answers the way it always did.
    const { document } = await resolveSpec({
      reader: createMemoryReader(files()),
      entry: "main.json",
    });
    expect(lintResolvedSpec(document).map((i) => i.pointer)).toEqual([
      "/components/parameters/PageSize",
      "/components/parameters/NeverUsed",
    ]);
  });

  it("is named identically by the sync resolver", () => {
    const sources = files();
    const syncReader = {
      canRead: (uri: string) => sources.has(uri),
      read: (uri: string) => {
        if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
        return structuredClone(sources.get(uri));
      },
    };
    const resolved = resolveSpecSync({ reader: syncReader, entry: "main.json", lint: true });
    expect(resolved.inlinedComponents).toEqual(["/components/parameters/PageSize"]);
    expect(resolved.specHygieneIssues.map((i) => i.pointer)).toEqual([
      "/components/parameters/NeverUsed",
    ]);
  });

  it("stays empty for a spec with no cross-document references", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "X", version: "1" },
            paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
          },
        ],
      ]),
    );
    const resolved = await resolveSpec({ reader, entry: "main.json" });
    expect(resolved.inlinedComponents).toEqual([]);
  });
});

describe("loadSpec and overlays", () => {
  it("carries the list through when no overlay ran", async () => {
    const loaded = await loadSpec({
      reader: createMemoryReader(files()),
      entry: "main.json",
      lint: true,
    });
    expect(loaded.inlinedComponents).toEqual(["/components/parameters/PageSize"]);
    expect(loaded.specHygieneIssues.map((i) => i.pointer)).toEqual([
      "/components/parameters/NeverUsed",
    ]);
  });

  it("drops it when an overlay ran, and reports the component again", async () => {
    // An overlay can re-reference or remove any of the components the
    // list names, so it stops describing the document being linted.
    // Dropping it restores the finding this fix removes, which is the
    // safe direction: a false positive rather than silence about a
    // component an overlay orphaned.
    const overlays: SpecOverlay[] = [
      { addPaths: { "/health": { get: { responses: { "200": { description: "ok" } } } } } },
    ];
    const loaded = await loadSpec({
      reader: createMemoryReader(files()),
      entry: "main.json",
      overlays,
      lint: true,
    });
    expect(loaded.inlinedComponents).toBeUndefined();
    expect(loaded.specHygieneIssues.map((i) => i.pointer)).toEqual([
      "/components/parameters/PageSize",
      "/components/parameters/NeverUsed",
    ]);
  });
});
