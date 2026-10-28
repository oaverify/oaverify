import { collectLeaves, httpStatusFor, type OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "./fixtures.js";
import { createValidator as createValidatorRaw } from "../src/index.js";

// A spec whose request body is a self-recursive `Node` (tree shape).
function treeSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/tree": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Node" } },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
  };
}

function nestChild(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let i = 0; i < depth; i += 1) node = { child: node };
  return node;
}

function postTree(
  body: unknown,
): Parameters<ReturnType<typeof createValidator>["validateRequest"]>[0] {
  return {
    method: "POST",
    path: "/tree",
    contentType: "application/json",
    headers: {},
    body,
  };
}

describe("createValidator maxDepth: option validation", () => {
  it("rejects zero, negative, and non-integer caps eagerly", () => {
    expect(() => createValidator(treeSpec(), { maxDepth: 0 })).toThrow(/positive integer/);
    expect(() => createValidator(treeSpec(), { maxDepth: -1 })).toThrow(/positive integer/);
    expect(() => createValidator(treeSpec(), { maxDepth: 1.5 })).toThrow(/positive integer/);
  });

  it("accepts a positive integer cap", () => {
    expect(() => createValidator(treeSpec(), { maxDepth: 1 })).not.toThrow();
    expect(() => createValidator(treeSpec(), { maxDepth: 64 })).not.toThrow();
  });
});

describe("createValidator maxDepth: request body", () => {
  it("accepts a recursive body within the cap", () => {
    const v = createValidator(treeSpec(), { maxDepth: 8 });
    expect(v.validateRequest(postTree(nestChild(8)))).toBeNull();
  });

  it("rejects a recursive body past the cap with a depth error mapped to 400", () => {
    const v = createValidator(treeSpec(), { maxDepth: 8 });
    const err = v.validateRequest(postTree(nestChild(20)));
    expect(err?.code).toBe("request");
    expect(collectLeaves(err!).map((l) => l.code)).toContain("depth");
    expect(httpStatusFor(err!)).toBe(400);
  });

  it("bounds a pathologically deep body instead of overflowing", () => {
    const v = createValidator(treeSpec(), { maxDepth: 64 });
    const err = v.validateRequest(postTree(nestChild(100_000)));
    expect(err?.code).toBe("request");
    expect(collectLeaves(err!).map((l) => l.code)).toContain("depth");
  });

  it("still overflows without the cap (the guard is what prevents it)", () => {
    const v = createValidator(treeSpec());
    expect(() => v.validateRequest(postTree(nestChild(100_000)))).toThrow(RangeError);
  });
});

describe("createValidator maxDepth: request body behind a union", () => {
  function unionSpec(): OpenAPIDocument {
    const spec = treeSpec();
    spec.components!.schemas!.Node = {
      anyOf: [
        { type: "null" },
        { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
      ],
    };
    return spec;
  }

  it("rejects a body past the cap with a depth error", () => {
    const err = createValidator(unionSpec(), { maxDepth: 8 }).validateRequest(
      postTree(nestChild(20)),
    );
    expect(collectLeaves(err!).map((l) => l.code)).toContain("depth");
  });

  it("bounds a pathologically deep body instead of overflowing", () => {
    const err = createValidator(unionSpec(), { maxDepth: 64 }).validateRequest(
      postTree(nestChild(100_000)),
    );
    expect(err).not.toBeNull();
  });
});

describe("createValidator maxDepth: aliased recursive body", () => {
  for (const openapi of ["3.0.3", "3.1.0", "3.2.0"]) {
    it(`preserves cap boundaries with default output under ${openapi}`, () => {
      const spec = treeSpec();
      spec.openapi = openapi;
      spec.components!.schemas = {
        Node: { $ref: "#/components/schemas/Inner" },
        Inner: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
          ],
        },
      };
      // Use the public flat output; the fixture forces tree mode and an unlimited budget.
      for (const maxErrors of [1, Number.POSITIVE_INFINITY]) {
        const v = createValidatorRaw(spec, { maxDepth: 3, maxErrors });
        for (const depth of [0, 3, 4, 100_000, 3]) {
          const r = v.validateRequest(postTree(nestChild(depth)));
          expect(r.valid, `depth ${depth}`).toBe(depth <= 3);
          if (!r.valid && maxErrors === Number.POSITIVE_INFINITY) {
            expect(r.errors.some((e) => e.code === "depth" && e.params.limit === 3)).toBe(true);
          }
        }
      }
    });
  }
});
