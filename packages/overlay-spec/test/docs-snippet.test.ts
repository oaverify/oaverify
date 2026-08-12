import { expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { applySpecOverlay, type OverlayDocument } from "../src/index.js";

/**
 * The Overlay 1.0 snippet in `docs/integration.md`, compiled and run.
 *
 * It was written without a type annotation, which does not compile: the
 * `actions` array is heterogeneous (`update` on two entries, `remove` on
 * the third), so an inferred literal widens to a union whose members
 * carry `update?: undefined` / `remove?: undefined`, and `undefined`
 * does not satisfy `JsonValue`'s index signature. The reader hit TS2345
 * on `applySpecOverlay`, not on the literal, which is a confusing place
 * to land. The page now annotates it, and this keeps the two in step.
 */
it("compiles and runs the docs/integration.md overlay snippet", () => {
  const base = {
    openapi: "3.1.0",
    info: { title: "base", version: "1.0.0" },
    tags: [{ name: "internal" }, { name: "public" }],
    paths: {
      "/pets": {
        get: {
          parameters: [{ name: "X-Tenant", in: "header" }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenAPIDocument;

  const overlayDoc: OverlayDocument = {
    overlay: "1.0.0",
    info: { title: "tenant overlay", version: "1.0.0" },
    actions: [
      { target: "$.info", update: { description: "tenant-A view" } },
      {
        target: "$.paths['/pets'].get.parameters[?(@.name=='X-Tenant' && @.in=='header')]",
        update: { required: true, schema: { type: "string" } },
      },
      { target: "$.tags[?(@.name=='internal')]", remove: true },
    ],
  };

  const patched = applySpecOverlay(base, overlayDoc) as unknown as {
    info: { description?: string };
    tags: { name: string }[];
    paths: Record<string, { get: { parameters: { required?: boolean }[] } }>;
  };

  // Each of the three action shapes did something, so the snippet is a
  // worked example rather than three targets that happen to parse.
  expect(patched.info.description).toBe("tenant-A view");
  expect(patched.tags.map((t) => t.name)).toEqual(["public"]);
  expect(patched.paths["/pets"]?.get.parameters[0]?.required).toBe(true);
});
