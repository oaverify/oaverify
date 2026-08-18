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

describe("lintResolvedSpec: path-template-malformed", () => {
  it("flags an undecodable percent escape in a path template", () => {
    // #708: this used to throw URIError out of the router instead of
    // producing a located finding.
    const spec = minimalSpec({
      paths: { "/bad%zz": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(lintResolvedSpec(spec)).toContainEqual(
      expect.objectContaining({
        code: "path-template-malformed",
        pointer: "/paths/~1bad%zz",
      }),
    );
  });

  it("flags a trailing percent and a truncated multi-byte sequence", () => {
    for (const bad of ["/a%", "/%E0%A4%A", "/x/%zz/y"]) {
      const spec = minimalSpec({
        paths: { [bad]: { get: { responses: { "200": { description: "ok" } } } } },
      });
      expect(lintResolvedSpec(spec).map((i) => i.code)).toContain("path-template-malformed");
    }
  });

  it("checks each segment independently", () => {
    // `%C3` and `%A9` in separate segments are two truncated sequences,
    // not one valid character.
    const spec = minimalSpec({
      paths: { "/%C3/%A9": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(lintResolvedSpec(spec).map((i) => i.code)).toContain("path-template-malformed");
  });

  it("accepts well-formed escapes, including multi-byte UTF-8 sequences", () => {
    // A multi-byte sequence only decodes as a whole: `%C3` and `%A9`
    // each throw on their own, so a per-escape check would flag `caf%C3%A9`.
    const spec = minimalSpec({
      paths: {
        "/a%2Fb": { get: { responses: { "200": { description: "ok" } } } },
        "/caf%C3%A9": { get: { responses: { "200": { description: "ok" } } } },
        "/%E0%A4%A1": { get: { responses: { "200": { description: "ok" } } } },
        "/plain": { get: { responses: { "200": { description: "ok" } } } },
        "/pets/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(lintResolvedSpec(spec).map((i) => i.code)).not.toContain("path-template-malformed");
  });

  it("flags a degenerate `{` segment, which the router decodes as a literal", () => {
    // parseSegment treats a `{` with no closing `}` as literal text and
    // decodes it, so it is spec text and has to be checked. Skipping
    // every `{`-bearing segment made this the one false negative.
    for (const bad of ["/x%zz{", "/{%zz", "/a{b%zz"]) {
      const spec = minimalSpec({
        paths: { [bad]: { get: { responses: { "200": { description: "ok" } } } } },
      });
      expect(lintResolvedSpec(spec).map((i) => i.code)).toContain("path-template-malformed");
    }
  });

  it("flags a bad escape in a literal run beside a placeholder", () => {
    // The router decodes the literal runs of a compound segment, so they
    // are spec text and a bad escape in one leaves the route reachable
    // only by a request repeating it.
    for (const bad of ["/a%zz-{id}", "/{id}-a%zz", "/x/pre%zz-{id}.{ext}"]) {
      const spec = minimalSpec({
        paths: {
          [bad]: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "ext", in: "path", required: true, schema: { type: "string" } },
            ],
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      });
      expect(lintResolvedSpec(spec).map((i) => i.code)).toContain("path-template-malformed");
    }
  });

  it("accepts a valid multi-byte escape in a literal run beside a placeholder", () => {
    const spec = minimalSpec({
      paths: {
        "/caf%C3%A9-{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(lintResolvedSpec(spec).map((i) => i.code)).not.toContain("path-template-malformed");
  });

  it("does not flag a percent inside a {placeholder} name", () => {
    // Placeholders are captured, never decoded as spec text.
    const spec = minimalSpec({
      paths: {
        "/pets/{a%zz}": {
          parameters: [{ name: "a%zz", in: "path", required: true, schema: { type: "string" } }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(lintResolvedSpec(spec).map((i) => i.code)).not.toContain("path-template-malformed");
  });
});

describe("a parameters field that is not a list (#837)", () => {
  const holed = (template: string, params: unknown): OpenAPIDocument =>
    ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        [template]: { get: { parameters: params, responses: { "200": { description: "ok" } } } },
      },
    }) as unknown as OpenAPIDocument;

  it("does not throw out of the whole lint", () => {
    // `parameters is not iterable` took `oaverify check` to exit 3,
    // naming no path, method or parameter.
    expect(() => lintResolvedSpec(holed("/t", { name: "id", in: "query" }))).not.toThrow();
    expect(lintResolvedSpec(holed("/t", { name: "id", in: "query" }))).toEqual([]);
  });

  it("stays quiet on a templated path rather than calling the parameter undeclared", () => {
    // The author did declare `{id}`, one missing `- ` away. Reporting it
    // undeclared would be false, and it would sit ahead of the
    // conformance finding that names the real defect.
    const issues = lintResolvedSpec(holed("/p/{id}", { name: "id", in: "path", required: true }));
    expect(issues.map((i) => i.code)).not.toContain("path-param-undeclared");
  });

  it("still reports an undeclared path parameter when the list is readable", () => {
    const issues = lintResolvedSpec(holed("/p/{id}", []));
    expect(issues.map((i) => i.code)).toContain("path-param-undeclared");
  });
});
