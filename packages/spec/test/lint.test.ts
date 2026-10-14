import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";
import { createMemoryReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";
import { loadSpec, loadSpecSync } from "../src/load.js";

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

  it("skips an unreadable tags list or entry, which conformance reports", () => {
    // `tags:\n  -` with nothing under the dash is `[null]`. Reading
    // `.name` off it threw and exited `oaverify check` with 3.
    for (const tags of [[null], [{}], [42], "Pets", { name: "Pets" }]) {
      const spec = minimalSpec({ tags } as never);
      expect(() => lintResolvedSpec(spec), JSON.stringify(tags)).not.toThrow();
      expect(lintResolvedSpec(spec), JSON.stringify(tags)).toEqual([]);
    }
  });

  it("still flags a readable unused tag next to an unreadable one", () => {
    const spec = minimalSpec({ tags: [null, { name: "Internal" }] } as never);
    expect(lintResolvedSpec(spec)).toMatchObject([{ code: "unused-tag", pointer: "/tags/1" }]);
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

  // The undeclared rule is per-operation, because the effective set
  // depends on the operation's own list. The unused rule for an
  // item-level declaration is not: it is a fact about the Path Item, and
  // reporting it inside the method loop produced one identical finding
  // per operation, all carrying the same pointer (#891).
  it("reports an unused path-item parameter once, not once per operation", () => {
    const spec = minimalSpec({
      paths: {
        "/p/{id}": {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "ghost", in: "path", required: true, schema: { type: "string" } },
          ],
          get: { responses: { "200": { description: "ok" } } },
          post: { responses: { "200": { description: "ok" } } },
          delete: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const unused = lintResolvedSpec(spec).filter((i) => i.code === "path-param-unused");
    expect(unused).toEqual([expect.objectContaining({ pointer: "/paths/~1p~1{id}/parameters" })]);
  });

  it("still reports an unused operation parameter once per operation", () => {
    const ghost = {
      name: "ghost",
      in: "path",
      required: true,
      schema: { type: "string" },
    } as const;
    const spec = minimalSpec({
      paths: {
        "/p/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: { parameters: [ghost], responses: { "200": { description: "ok" } } },
          post: { parameters: [ghost], responses: { "200": { description: "ok" } } },
        },
      },
    });
    const unused = lintResolvedSpec(spec).filter((i) => i.code === "path-param-unused");
    expect(unused.map((i) => i.pointer).sort()).toEqual([
      "/paths/~1p~1{id}/get/parameters",
      "/paths/~1p~1{id}/post/parameters",
    ]);
  });

  it("reports both declarations when an operation shadows an unused item-level one", () => {
    // Two declarations, two locations, both unused. The item-level one
    // used to be masked: the effective-set lookup credited the name to
    // the operation, so the path item's own declaration went unnamed.
    const ghost = {
      name: "ghost",
      in: "path",
      required: true,
      schema: { type: "string" },
    } as const;
    const spec = minimalSpec({
      paths: {
        "/p/{id}": {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            ghost,
          ],
          get: { parameters: [ghost], responses: { "200": { description: "ok" } } },
        },
      },
    });
    const unused = lintResolvedSpec(spec).filter((i) => i.code === "path-param-unused");
    expect(unused.map((i) => i.pointer).sort()).toEqual([
      "/paths/~1p~1{id}/get/parameters",
      "/paths/~1p~1{id}/parameters",
    ]);
  });

  it("reports an unused item-level parameter on a path item with no operations", () => {
    // Previously silent: the only reporting site was inside the method
    // loop, which never ran.
    const spec = minimalSpec({
      paths: {
        "/p": {
          parameters: [{ name: "ghost", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    });
    const unused = lintResolvedSpec(spec).filter((i) => i.code === "path-param-unused");
    expect(unused).toEqual([expect.objectContaining({ pointer: "/paths/~1p/parameters" })]);
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

  it("treats an empty `parameters:` as nothing declared, not unreadable", () => {
    // `parameters:` with nothing under it parses as null. Reading it as
    // unreadable silenced a true finding for a common YAML slip.
    const issues = lintResolvedSpec(holed("/p/{id}", null));
    expect(issues.map((i) => i.code)).toContain("path-param-undeclared");
  });

  it("keeps reporting an unused parameter beside an unreadable sibling", () => {
    // `path-param-unused` reads the declarations it can see, so an
    // unreadable list at the other level does not blind it.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/p/{id}": {
          parameters: { name: "a", in: "query" },
          get: {
            parameters: [{ name: "ghost", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(lintResolvedSpec(doc).map((i) => i.code)).toContain("path-param-unused");
  });

  it("still reports an undeclared path parameter when the list is readable", () => {
    const issues = lintResolvedSpec(holed("/p/{id}", []));
    expect(issues.map((i) => i.code)).toContain("path-param-undeclared");
  });
});

describe("a security field that is not a list (#883)", () => {
  const holed = (security: unknown, where: "op" | "doc"): OpenAPIDocument =>
    ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "x-k" } } },
      ...(where === "doc" ? { security } : {}),
      paths: {
        "/t": {
          get: {
            ...(where === "op" ? { security } : {}),
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }) as unknown as OpenAPIDocument;

  for (const where of ["op", "doc"] as const) {
    it(`does not throw out of the whole lint, ${where}-level`, () => {
      // `object is not iterable` took `oaverify check` to exit 3, naming
      // nothing, which is the symptom #837 had for `parameters`.
      expect(() => lintResolvedSpec(holed({ k: [] }, where))).not.toThrow();
    });
  }

  it("still reaches a scheme reference when the list is readable", () => {
    const issues = lintResolvedSpec(holed([{ k: [] }], "op"));
    expect(issues.map((i) => i.code)).not.toContain("unused-component");
  });

  it("does not throw on a list whose element is not a requirement object", () => {
    // `security:` with a bare `- ` under it parses as `[null]`, which is
    // an array, so it passes the container guard and reached
    // `Object.keys(null)`.
    expect(() => lintResolvedSpec(holed([null], "op"))).not.toThrow();
    expect(() => lintResolvedSpec(holed([null], "doc"))).not.toThrow();
  });

  it("still reaches the readable requirements beside an unreadable element", () => {
    const issues = lintResolvedSpec(holed([{ k: [] }, null], "op"));
    expect(issues.map((i) => i.code)).not.toContain("unused-component");
  });

  it("counts an unreadable requirement as reaching no scheme", () => {
    // The trade `path-param-mismatch` takes for an unreadable
    // `parameters`: the lint cannot see what it references, so the
    // scheme reads as unused. The conformance finding naming the real
    // defect sits alongside it.
    const issues = lintResolvedSpec(holed({ k: [] }, "op"));
    expect(issues.map((i) => i.code)).toContain("unused-component");
  });
});

describe("lintResolvedSpec: duplicate-parameter", () => {
  const ok = { "200": { description: "ok" } };
  const q = (type: string) => ({ name: "q", in: "query" as const, schema: { type } });
  const duplicates = (spec: OpenAPIDocument) =>
    lintResolvedSpec(spec)
      .filter((i) => i.code === "duplicate-parameter")
      .map((i) => i.pointer);

  it("reports the repeat of a name and location within an operation's list (#1054)", () => {
    const spec = minimalSpec({
      paths: { "/a": { get: { parameters: [q("string"), q("integer")], responses: ok } } },
    });
    expect(lintResolvedSpec(spec)).toEqual([
      {
        code: "duplicate-parameter",
        pointer: "/paths/~1a/get/parameters/1",
        message:
          'query parameter "q" is declared again at index 1 of a list that declares it at index 0; a parameter list must not repeat a name and location',
      },
    ]);
  });

  it("accepts an operation-level parameter overriding a path-level one", () => {
    const spec = minimalSpec({
      paths: {
        "/a": { parameters: [q("string")], get: { parameters: [q("integer")], responses: ok } },
      },
    });
    expect(duplicates(spec)).toEqual([]);
  });

  it("keys on the location too, and compares names exactly", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          get: {
            parameters: [
              { name: "q", in: "query" },
              { name: "q", in: "header" },
              { name: "X-Id", in: "header" },
              { name: "x-id", in: "header" },
            ],
            responses: ok,
          },
        },
      },
    });
    expect(duplicates(spec)).toEqual([]);
  });

  it("reads a Parameter reference, and reports the repeat at its own index", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          parameters: [{ $ref: "#/components/parameters/Q" }, q("string"), q("string")],
          get: { responses: ok },
        },
      },
      components: { parameters: { Q: q("integer") } },
    });
    expect(duplicates(spec)).toEqual(["/paths/~1a/parameters/1", "/paths/~1a/parameters/2"]);
  });

  it("checks webhooks, callbacks and components.pathItems where they are written", () => {
    // A fresh object per position: one object reached twice is one definition.
    const dup = () => ({ post: { parameters: [q("string"), q("string")], responses: ok } });
    const spec = minimalSpec({
      paths: {
        "/a": {
          get: {
            callbacks: { onEvent: { "{$request.query.cb}": dup() } },
            responses: ok,
          },
        },
        // A Path Item reference is checked at its target, once.
        "/b": { $ref: "#/components/pathItems/Shared" },
        "/c": { $ref: "#/components/pathItems/Shared" },
      },
      webhooks: { hook: dup() },
      components: {
        pathItems: { Shared: dup() },
        callbacks: { Reused: { "{$request.query.cb}": dup() } },
      },
    } as Partial<OpenAPIDocument>);
    expect(duplicates(spec)).toEqual([
      "/paths/~1a/get/callbacks/onEvent/{$request.query.cb}/post/parameters/1",
      "/webhooks/hook/post/parameters/1",
      "/components/pathItems/Shared/post/parameters/1",
      "/components/callbacks/Reused/{$request.query.cb}/post/parameters/1",
    ]);
  });

  it("reads past unreadable lists and entries", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          parameters: { name: "q", in: "query" },
          get: {
            parameters: [null, "q", { $ref: "#/nowhere" }, { name: "q" }, q("string")],
            responses: ok,
          },
        },
      },
    } as unknown as Partial<OpenAPIDocument>);
    expect(duplicates(spec)).toEqual([]);
  });

  it("follows a reference chain to the parameter", () => {
    const spec = minimalSpec({
      paths: {
        "/q": {
          get: { parameters: [{ $ref: "#/components/parameters/A" }, q("string")], responses: ok },
        },
      },
      components: {
        parameters: { A: { $ref: "#/components/parameters/B" }, B: q("string") },
      },
    } as Partial<OpenAPIDocument>);
    expect(duplicates(spec)).toEqual(["/paths/~1q/get/parameters/1"]);
  });

  it("checks a referenced Path Item written outside the named containers, at its own pointer", () => {
    const spec = minimalSpec({
      paths: { "/q": { $ref: "#/x-item" } },
      "x-item": { get: { parameters: [q("string"), q("string")], responses: ok } },
    } as unknown as Partial<OpenAPIDocument>);
    expect(duplicates(spec)).toEqual(["/x-item/get/parameters/1"]);
  });
});

describe("lintResolvedSpec: duplicate-operation-id", () => {
  const ok = { "200": { description: "ok" } };
  const op = (operationId: string) => ({ operationId, responses: ok });
  const findings = (spec: OpenAPIDocument) =>
    lintResolvedSpec(spec).filter((i) => i.code === "duplicate-operation-id");

  it("reports a second operation carrying an operationId already used (#809)", () => {
    const spec = minimalSpec({
      paths: { "/a": { get: op("listPets") }, "/b": { get: op("listPets"), post: op("other") } },
    });
    expect(findings(spec)).toEqual([
      {
        code: "duplicate-operation-id",
        pointer: "/paths/~1b/get/operationId",
        message:
          'operationId "listPets" is already used at /paths/~1a/get/operationId; an operationId must be unique among all operations',
      },
    ]);
  });

  it("compares exactly, and reads webhooks, callbacks and components.pathItems", () => {
    const spec = minimalSpec({
      paths: {
        "/a": {
          get: {
            ...op("x"),
            callbacks: { cb: { "{$request.query.u}": { post: op("x") } } },
          },
          put: op("X"),
        },
      },
      webhooks: { hook: { post: op("x") } },
      components: { pathItems: { Item: { get: op("x") } } },
    } as Partial<OpenAPIDocument>);
    expect(findings(spec).map((i) => i.pointer)).toEqual([
      "/paths/~1a/get/callbacks/cb/{$request.query.u}/post/operationId",
      "/webhooks/hook/post/operationId",
      "/components/pathItems/Item/get/operationId",
    ]);
  });

  it("counts one definition once, however many places reach it", () => {
    const spec = minimalSpec({
      paths: {
        "/a": { $ref: "#/components/pathItems/Shared" },
        "/b": { $ref: "#/components/pathItems/Shared" },
        "/c": {
          get: { ...op("c"), callbacks: { cb: { $ref: "#/components/callbacks/Cb" } } },
          put: { ...op("d"), callbacks: { cb: { $ref: "#/components/callbacks/Cb" } } },
        },
      },
      components: {
        pathItems: { Shared: { get: op("shared") } },
        callbacks: { Cb: { "{$request.query.u}": { post: op("onEvent") } } },
      },
    } as Partial<OpenAPIDocument>);
    expect(findings(spec)).toEqual([]);
  });

  // Resolution inlines an external Path Item at each use site; the
  // regions are what say the two copies are one definition.
  const sources = new Map<string, unknown>([
    [
      "main.json",
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/a": { $ref: "item.json" },
          "/b": { $ref: "item.json" },
          "/c": { get: op("shared") },
        },
      },
    ],
    ["item.json", { get: op("shared") }],
  ]);
  const external = () => createMemoryReader(sources);
  const externalSync = { read: (uri: string) => sources.get(uri), canRead: () => true };

  it("recognises copies of one external definition through the resolver's regions", async () => {
    for (const { specHygieneIssues } of [
      await resolveSpec({ reader: external(), entry: "main.json", lint: true }),
      resolveSpecSync({ reader: externalSync, entry: "main.json", lint: true }),
    ]) {
      expect(
        specHygieneIssues.filter((i) => i.code === "duplicate-operation-id").map((i) => i.pointer),
      ).toEqual(["/paths/~1c/get/operationId"]);
    }
  });

  it("reports the copies when it is not given the regions", async () => {
    const { document } = await resolveSpec({ reader: external(), entry: "main.json" });
    expect(findings(document).map((i) => i.pointer)).toEqual([
      "/paths/~1b/get/operationId",
      "/paths/~1c/get/operationId",
    ]);
  });
});

describe("lintResolvedSpec: security-scheme-undeclared", () => {
  const ok = { "200": { description: "ok" } };
  const pointers = (spec: OpenAPIDocument) =>
    lintResolvedSpec(spec)
      .filter((i) => i.code === "security-scheme-undeclared")
      .map((i) => i.pointer);

  it("reports a requirement naming no declared scheme (#809)", () => {
    const spec = minimalSpec({
      security: [{ apiKey: [] }, {}],
      paths: {
        "/a": { get: { security: [{ apiKey: [], notDefinedAnywhere: [] }], responses: ok } },
      },
      components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "k" } } },
    });
    expect(lintResolvedSpec(spec)).toEqual([
      {
        code: "security-scheme-undeclared",
        pointer: "/paths/~1a/get/security/0/notDefinedAnywhere",
        message:
          'security requirement names "notDefinedAnywhere", which components.securitySchemes does not declare',
      },
    ]);
  });

  it("reads the document level, webhooks and callbacks, and needs an own key", () => {
    const spec = minimalSpec({
      security: [{ toString: [] }],
      webhooks: { hook: { post: { security: [{ missing: [] }], responses: ok } } },
    } as Partial<OpenAPIDocument>);
    expect(pointers(spec)).toEqual([
      "/security/0/toString",
      "/webhooks/hook/post/security/0/missing",
    ]);
  });

  it("in 3.2, resolves a fragment name and leaves any other unmatched name to the URI rules", () => {
    const spec = minimalSpec({
      openapi: "3.2.0",
      security: [
        { "#/components/securitySchemes/key": [] },
        { "#/components/securitySchemes/gone": [] },
        { "./other.yaml#/key": [] },
        { bare: [] },
      ],
      components: { securitySchemes: { key: { type: "http", scheme: "bearer" } } },
    });
    expect(pointers(spec)).toEqual(["/security/1/#~1components~1securitySchemes~1gone"]);
  });

  it("reads past unreadable security lists and requirements", () => {
    const spec = minimalSpec({
      security: { apiKey: [] },
      paths: { "/a": { get: { security: [null, "x"], responses: ok } } },
    } as unknown as Partial<OpenAPIDocument>);
    expect(pointers(spec)).toEqual([]);
  });

  it("checks definitions reached through references outside the named containers", () => {
    const spec = minimalSpec({
      paths: {
        "/q": { $ref: "#/x-item" },
        "/other": { get: { operationId: "same", responses: ok } },
        "/l": {
          get: {
            responses: { "200": { description: "ok", links: { next: { $ref: "#/x-link" } } } },
          },
        },
      },
      "x-item": {
        get: { operationId: "same", security: [{ missing: [] }], responses: ok },
        servers: [{ url: "https://{missing}" }],
      },
      "x-link": { operationId: "same", server: { url: "https://{gone}" } },
    } as unknown as Partial<OpenAPIDocument>);
    expect(lintResolvedSpec(spec).map((i) => [i.code, i.pointer])).toEqual([
      ["duplicate-operation-id", "/x-item/get/operationId"],
      ["security-scheme-undeclared", "/x-item/get/security/0/missing"],
      // The link is read where it is referenced; the referenced Path Item
      // is walked after the named containers.
      ["server-variable-undeclared", "/x-link/server/url"],
      ["server-variable-undeclared", "/x-item/servers/0/url"],
    ]);
  });

  it("checks a 3.2 fragment name an overlay added", async () => {
    const document = {
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      paths: { "/q": { get: { responses: ok } } },
    };
    const { specHygieneIssues } = await loadSpec({
      reader: createMemoryReader(new Map<string, unknown>([["main.json", document]])),
      entry: "main.json",
      provenance: true,
      lint: true,
      overlays: [
        { overrides: { "/q": { operations: { get: { security: [{ "#/missing": [] }] } } } } },
      ],
    } as Parameters<typeof loadSpec>[0]);
    expect(
      specHygieneIssues
        .filter((i) => i.code === "security-scheme-undeclared")
        .map((i) => i.pointer),
    ).toEqual(["/paths/~1q/get/security/0/#~1missing"]);
  });
});

describe("lintResolvedSpec: server-variable-undeclared", () => {
  const ok = { "200": { description: "ok" } };
  const pointers = (spec: OpenAPIDocument) =>
    lintResolvedSpec(spec)
      .filter((i) => i.code === "server-variable-undeclared")
      .map((i) => i.pointer);

  it("reports a URL placeholder the server's variables do not declare (#809)", () => {
    const spec = minimalSpec({
      servers: [
        {
          url: "https://{region}.example.com/{version}/{region}",
          variables: { version: { default: "v1" } },
        },
      ],
    } as unknown as Partial<OpenAPIDocument>);
    expect(lintResolvedSpec(spec)).toEqual([
      {
        code: "server-variable-undeclared",
        pointer: "/servers/0/url",
        message:
          'server url "https://{region}.example.com/{version}/{region}" uses "{region}" but the server\'s variables do not declare "region", so it has no value to substitute',
      },
    ]);
  });

  it("reads every place a Server Object occurs", () => {
    const server = { url: "https://{host}" };
    const spec = minimalSpec({
      paths: {
        "/a": {
          servers: [server],
          get: {
            servers: [server],
            responses: { "200": { description: "ok", links: { next: { server } } } },
          },
        },
      },
      webhooks: { hook: { post: { servers: [server], responses: ok } } },
      components: {
        responses: { R: { description: "r", links: { l: { server } } } },
        links: { L: { server } },
      },
    } as Partial<OpenAPIDocument>);
    expect(pointers(spec)).toEqual([
      "/paths/~1a/servers/0/url",
      "/paths/~1a/get/servers/0/url",
      "/paths/~1a/get/responses/200/links/next/server/url",
      "/webhooks/hook/post/servers/0/url",
      "/components/responses/R/links/l/server/url",
      "/components/links/L/server/url",
    ]);
  });

  it("stays quiet on declared variables and unreadable servers", () => {
    const spec = minimalSpec({
      servers: [
        { url: "https://{host}", variables: { host: { default: "h" } } },
        { url: "https://{host}", variables: [] },
        { url: 7 },
        null,
        { url: "https://example.com/{constructor}", variables: {} },
      ],
    } as unknown as Partial<OpenAPIDocument>);
    expect(pointers(spec)).toEqual(["/servers/4/url"]);
  });
});

describe("loadSpec lint: duplicate-operation-id across inlined copies", () => {
  const ok = { "200": { description: "ok" } };
  const sources = new Map<string, unknown>([
    [
      "main.json",
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: { "/a": { $ref: "item.json" }, "/b": { $ref: "item.json" } },
      },
    ],
    ["item.json", { get: { operationId: "shared", responses: ok } }],
  ]);

  it("does not report copies, and returns regions only when asked", async () => {
    const plain = await loadSpec({
      reader: createMemoryReader(sources),
      entry: "main.json",
      lint: true,
    });
    expect(plain.specHygieneIssues).toEqual([]);
    expect(plain.regions).toBeUndefined();
    const sync = loadSpecSync({
      reader: { read: (uri: string) => sources.get(uri), canRead: () => true },
      entry: "main.json",
      lint: true,
    });
    expect(sync.specHygieneIssues).toEqual([]);
    expect(sync.regions).toBeUndefined();
  });
});

describe("lint under loadSpec and resolveSpec, review follow-ups", () => {
  const ok = { "200": { description: "ok" } };

  it("leaves unresolved via empty when lint is on without provenance", async () => {
    const reader = createMemoryReader(
      new Map<string, unknown>([
        [
          "main.json",
          {
            openapi: "3.1.0",
            info: { title: "t", version: "1" },
            paths: { "/a": { get: { responses: { "200": { $ref: "missing.json#/r" } } } } },
          },
        ],
      ]),
    );
    const out = await loadSpec({ reader, entry: "main.json", lint: true, onUnresolved: "record" });
    expect(out.unresolved?.map((u) => u.via)).toEqual([[]]);
  });

  it("does not look a 3.2 fragment name up in the entry when another file wrote it", async () => {
    const sources = new Map<string, unknown>([
      [
        "main.json",
        {
          openapi: "3.2.0",
          info: { title: "t", version: "1" },
          paths: {
            "/a": { $ref: "common.json#/item" },
            "/b": { get: { security: [{ "#/gone": [] }], responses: ok } },
          },
        },
      ],
      [
        "common.json",
        {
          item: { get: { security: [{ "#/components/securitySchemes/k": [] }], responses: ok } },
          components: { securitySchemes: { k: { type: "http", scheme: "bearer" } } },
        },
      ],
    ]);
    const { specHygieneIssues } = await loadSpec({
      reader: createMemoryReader(sources),
      entry: "main.json",
      lint: true,
    });
    expect(
      specHygieneIssues
        .filter((i) => i.code === "security-scheme-undeclared")
        .map((i) => i.pointer),
    ).toEqual(["/paths/~1b/get/security/0/#~1gone"]);
  });
});

describe("lintResolvedSpec: server-variable-default-not-in-enum", () => {
  const withServers = (openapi: string, servers: unknown[]) =>
    minimalSpec({ openapi, servers } as unknown as Partial<OpenAPIDocument>);
  const outside = (spec: OpenAPIDocument) =>
    lintResolvedSpec(spec).filter((i) => i.code.startsWith("server-variable-default"));

  it("reports a default its enum does not list (#1055)", () => {
    const spec = withServers("3.1.0", [
      {
        url: "https://example.org/{version}",
        variables: { version: { default: "v2", enum: ["v1"] } },
      },
    ]);
    expect(lintResolvedSpec(spec)).toEqual([
      {
        code: "server-variable-default-not-in-enum",
        pointer: "/servers/0/variables/version/default",
        message: 'server variable "version" has default "v2", which its enum does not list',
      },
    ]);
  });

  it("uses the -oas30 code where 3.0 only recommends it, and the MUST code in 3.2", () => {
    const servers = [{ url: "https://{v}", variables: { v: { default: "b", enum: ["a"] } } }];
    expect(outside(withServers("3.0.3", servers)).map((i) => i.code)).toEqual([
      "server-variable-default-not-in-enum-oas30",
    ]);
    expect(outside(withServers("3.2.0", servers)).map((i) => i.code)).toEqual([
      "server-variable-default-not-in-enum",
    ]);
  });

  it("reads Link Object servers and accepts listed or unconstrained defaults", () => {
    const spec = minimalSpec({
      servers: [
        { url: "https://{a}", variables: { a: { default: "x", enum: ["x", "y"] } } },
        { url: "https://{a}", variables: { a: { default: "x" } } },
      ],
      components: {
        links: {
          L: { server: { url: "https://{a}", variables: { a: { default: "X", enum: ["x"] } } } },
        },
      },
    } as unknown as Partial<OpenAPIDocument>);
    expect(outside(spec).map((i) => i.pointer)).toEqual([
      "/components/links/L/server/variables/a/default",
    ]);
  });

  it("compares only a string default against an array enum", () => {
    const spec = withServers("3.1.0", [
      {
        url: "https://{a}{b}{c}{d}",
        variables: {
          a: { default: 1, enum: ["1"] },
          b: { default: "x", enum: "x" },
          c: null,
          d: { enum: ["x"] },
        },
      },
      { url: "https://{a}", variables: [{ default: "x", enum: [] }] },
    ]);
    expect(outside(spec)).toEqual([]);
  });

  it("reads a Link Object reached through a reference outside components", () => {
    const spec = minimalSpec({
      paths: {
        "/l": {
          get: {
            responses: { "200": { description: "ok", links: { next: { $ref: "#/x-link" } } } },
          },
        },
      },
      "x-link": {
        server: { url: "https://{v}", variables: { v: { default: "bad", enum: ["good"] } } },
      },
    } as unknown as Partial<OpenAPIDocument>);
    expect(outside(spec).map((i) => i.pointer)).toEqual(["/x-link/server/variables/v/default"]);
  });
});
