/**
 * Integration tests for the validator's version-awareness:
 *
 * - 3.1 and 3.2 specs compile under the JSON Schema 2020-12 dialect.
 * - 3.0 specs compile under the OAS 3.0 dialect: string-only `type`
 *   with sibling `nullable`, boolean `exclusiveMaximum` / `exclusiveMinimum`,
 *   and `$ref`-suppresses-siblings semantics.
 * - The QUERY method (new in 3.2) routes and validates like any other.
 * - An explicit `vocabularies` option overrides the version dispatch.
 */

import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "@oaverify/internal-schema";
import { createValidator } from "./fixtures.js";

function spec32(): OpenAPIDocument {
  return {
    openapi: "3.2.0",
    info: { title: "Pets (3.2)", version: "1" },
    paths: {
      "/pets/search": {
        query: {
          operationId: "searchPets",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["filter"],
                  properties: { filter: { type: "string", minLength: 1 } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("3.2 support", () => {
  it("compiles a 3.2 spec with the 2020-12 dialect", () => {
    expect(() => createValidator(spec32())).not.toThrow();
  });

  it("routes the new QUERY method", () => {
    const v = createValidator(spec32());
    const ok = v.validateRequest({
      method: "QUERY",
      path: "/pets/search",
      contentType: "application/json",
      body: { filter: "cats" },
    });
    expect(ok).toBeNull();
  });

  it("validates QUERY request bodies", () => {
    const v = createValidator(spec32());
    const err = v.validateRequest({
      method: "QUERY",
      path: "/pets/search",
      contentType: "application/json",
      body: { filter: "" }, // minLength: 1
    });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("request");
  });

  it("validates QUERY responses", () => {
    const v = createValidator(spec32());
    const err = v.validateResponse(
      {
        method: "QUERY",
        path: "/pets/search",
        contentType: "application/json",
        body: { filter: "x" },
      },
      { status: 200, contentType: "application/json", body: [{}, {}] },
    );
    expect(err).toBeNull();
  });
});

describe("3.0 support", () => {
  function spec30(): OpenAPIDocument {
    return {
      openapi: "3.0.3",
      info: { title: "Pets (3.0)", version: "1" },
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string", minLength: 1 },
                      // OAS 3.0 nullability
                      tag: { type: "string", nullable: true },
                      // OAS 3.0 boolean exclusiveMaximum
                      priority: { type: "integer", maximum: 10, exclusiveMaximum: true },
                    },
                  },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    };
  }

  it("compiles a 3.0 spec without throwing", () => {
    expect(() => createValidator(spec30())).not.toThrow();
  });

  it("allows null on a nullable field", () => {
    const v = createValidator(spec30());
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: "Fido", tag: null },
    });
    expect(err).toBeNull();
  });

  it("rejects null on a non-nullable field", () => {
    const v = createValidator(spec30());
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: null },
    });
    expect(err).not.toBeNull();
  });

  it("honors boolean exclusiveMaximum (priority < 10, not ≤)", () => {
    const v = createValidator(spec30());
    // priority = 9 is fine
    expect(
      v.validateRequest({
        method: "POST",
        path: "/pets",
        contentType: "application/json",
        body: { name: "Fido", priority: 9 },
      }),
    ).toBeNull();
    // priority = 10 fails under 3.0's boolean-exclusive semantics
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: "Fido", priority: 10 },
    });
    expect(err).not.toBeNull();
  });

  it("ignores $ref siblings in 3.0 (reference-only schemas)", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "ref-sibling", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  // The description alongside $ref must be ignored in 3.0,
                  // and the type:number check must NOT apply: only the
                  // referenced schema validates.
                  schema: {
                    $ref: "#/components/schemas/StringThing",
                    description: "siblings of $ref are ignored in 3.0",
                    type: "number",
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: { StringThing: { type: "string" } } },
    };
    const v = createValidator(spec);
    // If siblings weren't suppressed, "hi" (a string) would fail the
    // type:number sibling check. Under 3.0 semantics, only the
    // referenced type:string applies; "hi" is valid.
    expect(
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: "hi",
      }),
    ).toBeNull();
  });

  it("drops nullable when it sits beside a $ref (3.0 sibling suppression)", () => {
    // eov #839: `{ $ref: X, nullable: true }` does NOT make the
    // referenced schema nullable; 3.0 suppresses siblings of $ref.
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      owner: { $ref: "#/components/schemas/User", nullable: true },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          User: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
    };
    const v = createValidator(spec);
    // Sibling `nullable` is ignored → null fails the referenced type:object.
    const err = v.validateRequest({
      method: "POST",
      path: "/x",
      contentType: "application/json",
      body: { owner: null },
    });
    expect(err).not.toBeNull();
  });

  it("nullable combines with string constraints: null ok, short strings fail", () => {
    // eov #912: nullable + minLength should treat null as a valid value
    // (bypassing length entirely) and still enforce minLength on strings.
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      label: { type: "string", nullable: true, minLength: 5 },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const v = createValidator(spec);
    expect(
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: { label: null },
      }),
    ).toBeNull();
    const err = v.validateRequest({
      method: "POST",
      path: "/x",
      contentType: "application/json",
      body: { label: "abc" },
    });
    expect(err).not.toBeNull();
  });

  it('rejects 3.1-style `type: ["string", "null"]` in a 3.0 spec', () => {
    // eov #802: the 3.1 short-hand is invalid in 3.0; authors must use
    // `nullable: true`. oas30TypeKeyword enforces string-only `type`.
    const spec: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      label: { type: ["string", "null"] as unknown as "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    // Compilation is lazy on the request-body schema, so the throw
    // happens on first validateRequest against the path.
    const v = createValidator(spec);
    expect(() =>
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: { label: "x" },
      }),
    ).toThrow(
      /keyword "type" at "properties\.label\.type" must be a single string in OpenAPI 3\.0/,
    );
  });

  describe("an explicit `dialect` option overrides the version dispatch", () => {
    // Asserting `not.toThrow()` on an empty-paths spec was the whole of
    // this case before #534, and it passed while the option was being
    // read and discarded. These compile a schema whose meaning differs
    // between dialects, so the verdict says which one actually ran.
    const specWithNullable = (openapi: string): OpenAPIDocument =>
      ({
        openapi,
        info: { title: "t", version: "1" },
        paths: {
          "/x": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      // OAS 3.0 spelling. Under 3.1 it is an unknown
                      // annotation and null fails `type: "string"`.
                      properties: { label: { type: "string", nullable: true } },
                    },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }) as OpenAPIDocument;

    // The shim returns `ValidationError | null`; null is a clean pass.
    const postNull = (v: ReturnType<typeof createValidator>) =>
      v.validateRequest({
        method: "POST",
        path: "/x",
        contentType: "application/json",
        body: { label: null },
      }) === null;

    it("applies the forced dialect's semantics, not the declared version's", () => {
      // Declared 3.1, forced to 3.0: `nullable` becomes load-bearing.
      expect(postNull(createValidator(specWithNullable("3.1.0"), { dialect: oas30Dialect }))).toBe(
        true,
      );
      // And the reverse, so this cannot pass by both dialects agreeing.
      expect(
        postNull(createValidator(specWithNullable("3.0.3"), { dialect: openapi31Dialect })),
      ).toBe(false);
    });

    it("leaves detection alone: `detectedVersion` still reports the document", () => {
      // The option decides what compiles, not what the spec says it is.
      const v = createValidator(specWithNullable("3.1.0"), { dialect: oas30Dialect });
      expect(v.detectedVersion).toBe("3.1");
    });

    it("does not warn: overriding a version that resolved cleanly is not an escape hatch", () => {
      const chunks: string[] = [];
      const v = createValidator(specWithNullable("3.1.0"), {
        dialect: oas30Dialect,
        warn: (msg) => chunks.push(msg),
      });
      expect(chunks).toEqual([]);
      expect(v.warnings).toEqual([]);
    });

    it("still dispatches on the declared version when no dialect is passed", () => {
      expect(postNull(createValidator(specWithNullable("3.0.3")))).toBe(true);
      expect(postNull(createValidator(specWithNullable("3.1.0")))).toBe(false);
    });
  });
});

describe("category errors", () => {
  // Missing / non-string `openapi` field and non-3.x major versions
  // are category errors: "this doesn't look like an OpenAPI 3.x
  // document at all". Always throw unless `dialect` is set as the
  // universal escape hatch.

  function specWith(openapi: unknown): OpenAPIDocument {
    return {
      openapi: openapi as string,
      info: { title: "t", version: "1" },
      paths: {},
    };
  }

  it("throws when the openapi field is missing", () => {
    expect(() => createValidator(specWith(undefined))).toThrow(/openapi.*must be a string/);
  });

  it("throws when the openapi field is null", () => {
    expect(() => createValidator(specWith(null))).toThrow(/openapi.*must be a string/);
  });

  it("throws when the openapi field isn't semver-shaped", () => {
    expect(() => createValidator(specWith("yes"))).toThrow(/doesn't look like a semver version/);
  });

  it("throws on a Swagger 2.0 document (wrong major), hint points at swagger2openapi", () => {
    const err = (() => {
      try {
        createValidator(specWith("2.0.0"));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toMatch(/supports OpenAPI 3.x/);
    expect(err?.message).toMatch(/swagger2openapi/);
  });

  it("throws on a future major (4.0.0) without the swagger2openapi hint", () => {
    const err = (() => {
      try {
        createValidator(specWith("4.0.0"));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toMatch(/supports OpenAPI 3.x/);
    expect(err?.message).not.toMatch(/swagger2openapi/);
  });

  it("message for missing openapi mentions the `swagger` sibling-field convention as a hint", () => {
    // We don't *sniff* the `swagger` field; the check is just
    // "openapi must be a string." But the error text points the user
    // at the common sibling-format convention so they know where to
    // go next.
    const err = (() => {
      try {
        createValidator(specWith(undefined));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toMatch(/swagger2openapi/);
  });

  it("dialect option is the universal override: compiles a bare spec + emits a single warn", () => {
    const chunks: string[] = [];
    const v = createValidator(specWith(undefined), {
      dialect: jsonSchemaDialect,
      warn: (msg) => chunks.push(msg),
    });
    expect(v.detectedVersion).toBeUndefined();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/compiling anyway because `dialect` was set/);
  });

  it("dialect override also suppresses the wrong-major throw", () => {
    const chunks: string[] = [];
    expect(() =>
      createValidator(specWith("2.0.0"), {
        dialect: jsonSchemaDialect,
        warn: (msg) => chunks.push(msg),
      }),
    ).not.toThrow();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/supports OpenAPI 3.x/);
  });

  it("warnings accumulate onto validator.warnings even without a warn callback", () => {
    // The library never writes to stderr on its own; instead, every
    // would-warn event lands on validator.warnings so the caller can
    // inspect post-construction.
    const v = createValidator(specWith(undefined), { dialect: jsonSchemaDialect });
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatch(/compiling anyway because `dialect` was set/);
  });

  it("warnings and the warn callback both receive each warning", () => {
    const chunks: string[] = [];
    const v = createValidator(specWith("2.0.0"), {
      dialect: jsonSchemaDialect,
      warn: (msg) => chunks.push(msg),
    });
    expect(chunks).toHaveLength(1);
    expect(v.warnings).toHaveLength(1);
    expect(chunks[0]).toBe(v.warnings[0]);
  });
});

describe("unknown minor version (forward-compat within 3.x)", () => {
  // Valid 3.x major with an unknown minor (e.g. 3.7.0). Not a
  // category error; this is the one case `onUnknownVersion` governs.

  function specWith(openapi: string): OpenAPIDocument {
    return {
      openapi,
      info: { title: "t", version: "1" },
      paths: {},
    };
  }

  it("default onUnknownVersion='fallback31' silently accepts 3.7.0", () => {
    const v = createValidator(specWith("3.7.0"));
    expect(v.detectedVersion).toBeUndefined();
  });

  it("onUnknownVersion='throw' rejects 3.7.0 with a message that mentions `dialect`", () => {
    expect(() => createValidator(specWith("3.7.0"), { onUnknownVersion: "throw" })).toThrow(
      /unknown 3.x minor/,
    );
    expect(() => createValidator(specWith("3.7.0"), { onUnknownVersion: "throw" })).toThrow(
      /dialect/,
    );
  });

  it("onUnknownVersion='warn' populates validator.warnings even without a callback", () => {
    const v = createValidator(specWith("3.7.0"), { onUnknownVersion: "warn" });
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatch(/unknown 3.x minor/);
  });

  it("onUnknownVersion='warn' routes through options.warn and falls back to 3.1", () => {
    const chunks: string[] = [];
    createValidator(specWith("3.7.0"), {
      onUnknownVersion: "warn",
      warn: (msg) => chunks.push(msg),
    });
    expect(chunks.join("")).toMatch(/unknown 3.x minor/);
    expect(chunks.join("")).toMatch(/falling back to the 3.1 dialect/);
  });

  it("dialect override skips onUnknownVersion entirely", () => {
    const chunks: string[] = [];
    const v = createValidator(specWith("3.7.0"), {
      dialect: jsonSchemaDialect,
      onUnknownVersion: "throw", // should be ignored
      warn: (msg) => chunks.push(msg),
    });
    expect(v.detectedVersion).toBeUndefined();
    // No warn here; `dialect` on a valid-shaped 3.x spec is just a
    // normal override, not a category-error suppression.
    expect(chunks).toHaveLength(0);
  });
});

describe("detectedVersion", () => {
  it("exposes the detected bucket when the field is a known 3.x version", () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
    };
    expect(createValidator(spec).detectedVersion).toBe("3.1");
  });
});
