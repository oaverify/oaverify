import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

function minimalSpec(overrides: Partial<OpenAPIDocument> = {}): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths: {},
    ...overrides,
  };
}

describe("lintResolvedSpec: clean specs", () => {
  it("returns no findings for a minimal valid spec", () => {
    expect(lintResolvedSpec(minimalSpec())).toEqual([]);
  });

  it("returns no findings for a spec where every component is reached", () => {
    const spec = minimalSpec({
      paths: {
        "/pets/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            responses: {
              "200": { $ref: "#/components/responses/PetResponse" },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: { type: "object", properties: { id: { type: "string" } } },
        },
        responses: {
          PetResponse: {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });
});

describe("lintResolvedSpec: unused-component", () => {
  it("flags a schema declared in components.schemas but not reached", () => {
    const spec = minimalSpec({
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
      components: {
        schemas: { Orphan: { type: "object" } },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unused-component",
      pointer: "/components/schemas/Orphan",
    });
  });

  it("does not flag a schema that's reached transitively via another component", () => {
    const spec = minimalSpec({
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: { type: "object", properties: { tag: { $ref: "#/components/schemas/Tag" } } },
          Tag: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });

  it("flags an unused securityScheme (no security: clause references it)", () => {
    const spec = minimalSpec({
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(
      issues.some((i) => i.code === "unused-component" && i.pointer.endsWith("/bearerAuth")),
    ).toBe(true);
  });

  it("does not flag a securityScheme reached via top-level security", () => {
    const spec = minimalSpec({
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });

  it("treats a discriminator.mapping target as reached", () => {
    const spec = minimalSpec({
      paths: {
        "/animals": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      discriminator: {
                        propertyName: "kind",
                        mapping: { cat: "#/components/schemas/Cat" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: { Cat: { type: "object" } },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });
});

describe("lintResolvedSpec: unused-tag", () => {
  it("flags a top-level tag that no operation uses", () => {
    const spec = minimalSpec({
      tags: [{ name: "Internal" }, { name: "Pets" }],
      paths: {
        "/pets": { get: { tags: ["Pets"], responses: { "200": { description: "ok" } } } },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unused-tag", pointer: "/tags/0" });
  });

  it("returns nothing when every tag has at least one user", () => {
    const spec = minimalSpec({
      tags: [{ name: "Pets" }],
      paths: {
        "/pets": { get: { tags: ["Pets"], responses: { "200": { description: "ok" } } } },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });
});

describe("lintResolvedSpec: unreachable-defs", () => {
  it("flags a $defs entry that no $ref points at", () => {
    const spec = minimalSpec({
      components: {
        schemas: {
          Pet: {
            type: "object",
            $defs: {
              Used: { type: "string" },
              Dead: { type: "number" },
            },
            properties: {
              tag: { $ref: "#/components/schemas/Pet/$defs/Used" },
            },
          },
        },
      },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
                },
              },
            },
          },
        },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unreachable-defs",
      pointer: "/components/schemas/Pet/$defs/Dead",
    });
  });

  it("does not flag $defs/__ext__/<uri> entries (resolver-injected)", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/$defs/__ext__/foo" } } },
              },
            },
          },
        },
      },
      $defs: {
        __ext__: {
          foo: { type: "object" },
        },
      },
    } as OpenAPIDocument;
    expect(lintResolvedSpec(spec).filter((i) => i.code === "unreachable-defs")).toEqual([]);
  });
});

describe("lintResolvedSpec: path-param-undeclared / path-param-unused", () => {
  it("flags a {placeholder} in the path with no matching declaration", () => {
    const spec = minimalSpec({
      paths: {
        "/pets/{id}": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "path-param-undeclared",
        pointer: "/paths/~1pets~1{id}/get",
      }),
    );
  });

  it("flags a declared in:path parameter that's not in the path template", () => {
    const spec = minimalSpec({
      paths: {
        "/pets": {
          get: {
            parameters: [{ name: "ghost", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const issues = lintResolvedSpec(spec);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "path-param-unused",
      }),
    );
  });

  it("accepts a parameter declared at the path-item level", () => {
    const spec = minimalSpec({
      paths: {
        "/pets/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });

  it("accepts a parameter declared via $ref to components.parameters", () => {
    const spec = minimalSpec({
      paths: {
        "/pets/{id}": {
          parameters: [{ $ref: "#/components/parameters/PetId" }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
      components: {
        parameters: {
          PetId: { name: "id", in: "path", required: true, schema: { type: "string" } },
        },
      },
    });
    expect(lintResolvedSpec(spec)).toEqual([]);
  });
});
