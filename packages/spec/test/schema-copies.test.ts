import { describe, expect, it } from "vitest";
import { createMemoryReader } from "../src/reader.js";
import { loadSpec, loadSpecSync, type LoadSpecOptions } from "../src/load.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { sourceOf } from "../src/provenance.js";
import { lintResolvedSpec } from "../src/lint.js";

function documents(
  body: unknown = {
    $defs: { Used: { type: "string" }, Dead: { type: "number" } },
    properties: { code: { $ref: "#/$defs/Used" } },
  },
): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "entry.json",
      {
        openapi: "3.1.0",
        info: { title: "Copies", version: "1" },
        paths: {},
        components: { schemas: { Body: { $ref: "body.json" } } },
      },
    ],
    ["body.json", body],
  ]);
}

for (const sync of [false, true]) {
  describe(`hoisted schema copies (sync=${sync})`, () => {
    const run = async (
      sources: Map<string, unknown>,
      options: Omit<LoadSpecOptions, "reader" | "entry"> = {},
      direct = false,
    ) => {
      const common = { entry: "entry.json", ...options };
      if (sync) {
        const reader = {
          canRead: (uri: string) => sources.has(uri),
          read: (uri: string) => sources.get(uri),
        };
        return direct
          ? resolveSpecSync({ ...common, reader })
          : loadSpecSync({ ...common, reader });
      }
      const reader = createMemoryReader(sources);
      return direct ? resolveSpec({ ...common, reader }) : loadSpec({ ...common, reader });
    };

    it("records copies without requesting lint or provenance", async () => {
      const resolved = await run(documents());
      expect(resolved.regions).toBeUndefined();
      expect(resolved.specHygieneIssues).toEqual([]);
      expect(resolved.hoistedSchemaCopies).toEqual([
        { target: expect.any(String), copies: ["/components/schemas/Body/$defs/Used"] },
      ]);
      expect(
        lintResolvedSpec(resolved.document, resolved)
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Dead"]);
    });

    it("uses the same metadata when linting directly in the resolver", async () => {
      const resolved = await run(documents(), { lint: true }, true);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Dead"]);
    });

    it("records exact schema copies outside definitions", async () => {
      const resolved = await run(
        documents({
          properties: {
            original: { type: "string" },
            referring: { $ref: "#/properties/original" },
          },
        }),
      );
      expect(resolved.hoistedSchemaCopies).toEqual([
        { target: expect.any(String), copies: ["/components/schemas/Body/properties/original"] },
      ]);
    });

    it("records multiple copies when an enclosing schema is also hoisted", async () => {
      const resolved = await run(
        documents({
          $defs: { Container: { $defs: { Used: false } } },
          properties: {
            whole: { $ref: "#/$defs/Container" },
            nested: { $ref: "#/$defs/Container/$defs/Used" },
          },
        }),
      );
      const container = resolved.hoistedSchemaCopies!.find((group) =>
        group.copies.includes("/components/schemas/Body/$defs/Container"),
      )!;
      const nested = resolved.hoistedSchemaCopies!.find((group) =>
        group.copies.includes("/components/schemas/Body/$defs/Container/$defs/Used"),
      )!;
      expect(nested.copies).toEqual(
        expect.arrayContaining([
          "/components/schemas/Body/$defs/Container/$defs/Used",
          `${container.target}/$defs/Used`,
        ]),
      );
      expect(nested.copies).toHaveLength(2);
    });

    it("does not invent copies for missing targets", async () => {
      const resolved = await run(
        documents({
          $defs: { Dead: true },
          properties: { code: { $ref: "#/$defs/Missing" } },
        }),
        { onUnresolved: "record", lint: true },
      );
      expect(resolved.hoistedSchemaCopies).toEqual([]);
      expect(resolved.unresolved).toHaveLength(1);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Dead"]);
    });

    it("preserves connections through unrelated overlays", async () => {
      const resolved = await run(documents(), {
        lint: true,
        overlays: [{ info: { description: "Edited" } }],
      });
      expect(resolved.hoistedSchemaCopies).toHaveLength(1);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Dead"]);
    });

    it("reports a definition when an overlay removes the reference to its target", async () => {
      const resolved = await run(documents(), {
        lint: true,
        overlays: [
          {
            replaceSchemas: {
              Body: { $defs: { Used: { type: "string" }, Dead: { type: "number" } } },
            },
          },
        ],
      });
      expect(resolved.hoistedSchemaCopies).toHaveLength(1);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Used", "/components/schemas/Body/$defs/Dead"]);
    });

    it("invalidates a changed retained copy even if its old target remains referenced", async () => {
      const initial = await run(documents());
      const target = initial.hoistedSchemaCopies![0]!.target;
      const resolved = await run(documents(), {
        lint: true,
        overlays: [
          {
            replaceSchemas: {
              Body: {
                $defs: { Used: { type: "number" } },
                properties: { code: { $ref: `#${target}` } },
              },
            },
          },
        ],
      });
      expect(resolved.hoistedSchemaCopies).toEqual([]);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Used"]);
    });

    it("invalidates a changed hoisted target", async () => {
      const initial = await run(documents());
      const name = initial.hoistedSchemaCopies![0]!.target.split("/").at(-1)!;
      const resolved = await run(documents(), {
        lint: true,
        overlays: [{ replaceSchemas: { [name]: { type: "number" } } }],
      });
      expect(resolved.hoistedSchemaCopies).toEqual([]);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/components/schemas/Body/$defs/Used", "/components/schemas/Body/$defs/Dead"]);
    });

    it("keeps completed mounts and replacement mounts across multiple sibling overrides", async () => {
      const operation = (response: string, status = "200") => ({
        responses: { [status]: { $ref: response } },
      });
      const sources = new Map<string, unknown>([
        [
          "entry.json",
          {
            openapi: "3.1.0",
            info: { title: "Mount boundaries", version: "1" },
            paths: {
              "/before": { get: operation("before.json") },
              "/probe": {
                $ref: "path.json",
                summary: "authored summary",
                get: operation("replacement.json"),
                post: { responses: { "201": { description: "authored response" } } },
                ["__proto__"]: { authored: true },
              },
              "/after": { get: operation("after.json") },
            },
          },
        ],
        [
          "path.json",
          {
            summary: "old summary",
            get: operation("old-get.json"),
            post: operation("old-post.json", "201"),
          },
        ],
        ...["before.json", "old-get.json", "old-post.json", "replacement.json", "after.json"].map(
          (name) => [name, { description: name }] as [string, unknown],
        ),
      ]);
      const resolved = await run(sources, { provenance: true });
      expect(resolved.hoistedSchemaCopies).toEqual([]);
      for (const [pointer, uri, original] of [
        ["/paths/~1before/get/responses/200/description", "before.json", "/description"],
        ["/paths/~1probe/get/responses/200/description", "replacement.json", "/description"],
        [
          "/paths/~1probe/post/responses/201/description",
          "entry.json",
          "/paths/~1probe/post/responses/201/description",
        ],
        ["/paths/~1probe/summary", "entry.json", "/paths/~1probe/summary"],
        ["/paths/~1probe/__proto__/authored", "entry.json", "/paths/~1probe/__proto__/authored"],
        ["/paths/~1after/get/responses/200/description", "after.json", "/description"],
      ] as const) {
        expect(sourceOf(resolved.regions!, pointer)).toMatchObject({ uri, pointer: original });
      }
      const path = resolved.document.paths!["/probe"]!;
      expect(Object.hasOwn(path, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(path, "__proto__")?.value).toEqual({ authored: true });
    });

    it.each([false, true])(
      "discards displaced nested mounts and preserves replacement mounts (external=%s)",
      async (external) => {
        const content = (type: string) => ({
          "application/json": { schema: { $defs: { Used: { type } } } },
        });
        const replacement = { description: "replacement", content: content("number") };
        const sourcePointer = "/content/application~1json/schema/$defs/Used";
        const pointer = `/paths/~1probe/get/responses/200${sourcePointer}`;
        const sources = new Map<string, unknown>([
          [
            "entry.json",
            {
              openapi: "3.1.0",
              info: { title: "Nested shadow", version: "1" },
              paths: {
                "/probe": {
                  $ref: "path.json",
                  get: {
                    responses: { "200": external ? { $ref: "replacement.json" } : replacement },
                  },
                },
              },
              components: {
                schemas: {
                  Used: { $ref: `response.json#${sourcePointer}` },
                  Referring: { $ref: "#/components/schemas/Used" },
                  ...(external && {
                    Replacement: { $ref: `replacement.json#${sourcePointer}` },
                    ReferringReplacement: { $ref: "#/components/schemas/Replacement" },
                  }),
                },
              },
            },
          ],
          ["path.json", { get: { responses: { "200": { $ref: "response.json" } } } }],
          ["response.json", { description: "original", content: content("string") }],
          ["replacement.json", replacement],
        ]);
        const resolved = await run(sources, { lint: true, provenance: true });
        expect(sourceOf(resolved.regions!, pointer)).toMatchObject({
          uri: external ? "replacement.json" : "entry.json",
          pointer: external ? sourcePointer : pointer,
        });
        expect(resolved.hoistedSchemaCopies).toEqual(
          external
            ? [
                {
                  target: "/components/schemas/Replacement",
                  copies: [pointer],
                },
              ]
            : [],
        );
        expect(
          resolved.specHygieneIssues
            .filter((x) => x.code === "unreachable-defs")
            .map((x) => x.pointer),
        ).toEqual(external ? [] : [pointer]);
      },
    );

    it("does not infer shared descendants across an inlined sibling override", async () => {
      const content = { "application/json": { schema: { $defs: { Used: { type: "string" } } } } };
      const sources = new Map<string, unknown>([
        [
          "entry.json",
          {
            openapi: "3.1.0",
            info: { title: "Shadow", version: "1" },
            paths: {
              "/probe": { get: { responses: { "200": { $ref: "response.json", content } } } },
            },
            components: {
              schemas: {
                All: { $ref: "response.json" },
                Referring: {
                  $ref: "#/components/schemas/All/content/application~1json/schema/$defs/Used",
                },
              },
            },
          },
        ],
        ["response.json", { description: "OK", content }],
      ]);
      const resolved = await run(sources, { lint: true });
      expect(resolved.hoistedSchemaCopies).toEqual([
        {
          target: "/components/schemas/All",
          copies: ["/paths/~1probe/get/responses/200"],
        },
      ]);
      expect(
        resolved.specHygieneIssues
          .filter((x) => x.code === "unreachable-defs")
          .map((x) => x.pointer),
      ).toEqual(["/paths/~1probe/get/responses/200/content/application~1json/schema/$defs/Used"]);
    });

    it.each([false, true])(
      "accounts for non-schema inlining and sibling shadows (shadow=%s)",
      async (shadow) => {
        const content = { "application/json": { schema: { $defs: { Used: { type: "string" } } } } };
        const sources = new Map<string, unknown>([
          [
            "entry.json",
            {
              openapi: "3.1.0",
              info: { title: "Inline", version: "1" },
              paths: {
                "/probe": {
                  get: {
                    responses: {
                      "200": {
                        $ref: "response.json",
                        ...(shadow && { content }),
                      },
                    },
                  },
                },
              },
              components: {
                schemas: {
                  Used: { $ref: "response.json#/content/application~1json/schema/$defs/Used" },
                },
              },
            },
          ],
          ["response.json", { description: "OK", content }],
        ]);
        const resolved = await run(sources);
        expect(resolved.hoistedSchemaCopies).toEqual(
          shadow
            ? []
            : [
                {
                  target: "/components/schemas/Used",
                  copies: [
                    "/paths/~1probe/get/responses/200/content/application~1json/schema/$defs/Used",
                  ],
                },
              ],
        );
      },
    );
  });
}
