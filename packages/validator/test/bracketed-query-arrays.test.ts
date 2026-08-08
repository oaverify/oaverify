/**
 * `allowBracketedQueryArrays`: reading `?tags[]=a&tags[]=b` against a
 * parameter declared as `tags`. Covers the option-off path, the
 * precedence rule that keeps the literal declared name winning, the
 * reconciliation with `strictQueryParameters`, and the two query
 * sources agreeing.
 */
import type { HttpRequest, OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/index.js";

/** One required query parameter, name and schema per call. */
const specWith = (
  name: string,
  schema: unknown = { type: "array", items: { type: "string" } },
): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/w": {
        get: {
          parameters: [{ name, in: "query", required: true, schema }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

const get = (query: Record<string, string | string[]>): HttpRequest =>
  ({ method: "GET", path: "/w", query }) as unknown as HttpRequest;

const messages = (result: unknown): string[] =>
  ((result as { errors?: { message: string }[] }).errors ?? []).map((e) => e.message);

describe("allowBracketedQueryArrays off", () => {
  it("reports the parameter missing for a bracket-suffixed key", () => {
    const result = createValidator(specWith("tags")).validateRequest(get({ "tags[]": ["a", "b"] }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });

  it("still accepts a parameter declared literally as tags[]", () => {
    const result = createValidator(specWith("tags[]")).validateRequest(
      get({ "tags[]": ["a", "b"] }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("allowBracketedQueryArrays on", () => {
  const validator = () => createValidator(specWith("tags"), { allowBracketedQueryArrays: true });

  it("reads a bracket-suffixed key for an array-typed parameter", () => {
    expect(validator().validateRequest(get({ "tags[]": ["a", "b"] })).valid).toBe(true);
  });

  it("still reads the exact declared name", () => {
    expect(validator().validateRequest(get({ tags: ["a", "b"] })).valid).toBe(true);
  });

  it("deserializes a single bracketed value as an array, same as the plain spelling", () => {
    // `?tags[]=a` arrives as a bare string; the array parameter's
    // deserialization has to treat it the way it treats `?tags=a`.
    const bracketed = validator().validateRequest(get({ "tags[]": "a" }));
    const plain = validator().validateRequest(get({ tags: "a" }));
    expect(bracketed).toEqual(plain);
    expect(bracketed.valid).toBe(true);
  });

  it("does not read indexed bracket keys", () => {
    // Only the empty-bracket spelling is an alias; `tags[0]` is not.
    const result = validator().validateRequest(get({ "tags[0]": "a", "tags[1]": "b" }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });

  it("leaves a non-array parameter alone", () => {
    const result = createValidator(specWith("tags", { type: "string" }), {
      allowBracketedQueryArrays: true,
    }).validateRequest(get({ "tags[]": "a" }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });

  it("reports a genuinely absent parameter as missing", () => {
    const result = validator().validateRequest(get({ other: "x" }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });
});

describe("allowBracketedQueryArrays precedence", () => {
  it("reads the exact name and ignores the bracketed key when both are sent", () => {
    // The schema accepts only "good", so a passing result proves the
    // value came from `tags` rather than from `tags[]`. A bare
    // valid:true would not distinguish the two.
    const spec = specWith("tags", {
      type: "array",
      items: { type: "string", enum: ["good"] },
    });
    const result = createValidator(spec, { allowBracketedQueryArrays: true }).validateRequest(
      get({ tags: ["good"], "tags[]": ["bad"] }),
    );
    expect(result.valid).toBe(true);
  });

  it("does not merge the two spellings", () => {
    const spec = specWith("tags", {
      type: "array",
      items: { type: "string" },
      maxItems: 1,
    });
    const result = createValidator(spec, { allowBracketedQueryArrays: true }).validateRequest(
      get({ tags: ["one"], "tags[]": ["two"] }),
    );
    // A merge would make two items and trip maxItems.
    expect(result.valid).toBe(true);
  });

  it("keeps a literally declared tags[] bound to its own parameter", () => {
    const both = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/w": {
          get: {
            parameters: [
              {
                name: "tags",
                in: "query",
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "tags[]",
                in: "query",
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const validator = createValidator(both, { allowBracketedQueryArrays: true });

    expect(validator.validateRequest(get({ tags: ["a"], "tags[]": ["b"] })).valid).toBe(true);

    // `tags` gains no alias, because `tags[]` is a declared name. So
    // sending only `tags[]` leaves `tags` missing rather than letting
    // one key satisfy both parameters.
    const onlyBracketed = validator.validateRequest(get({ "tags[]": ["b"] }));
    expect(onlyBracketed.valid).toBe(false);
    expect(messages(onlyBracketed)).toEqual(['missing required query parameter "tags"']);
  });
});

describe("allowBracketedQueryArrays with strictQueryParameters", () => {
  it("accepts the bracketed spelling as a known key", () => {
    const result = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      strictQueryParameters: true,
    }).validateRequest(get({ "tags[]": ["a"] }));
    expect(result.valid).toBe(true);
  });

  it("treats the spelling as known even when the request used the plain name", () => {
    const result = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      strictQueryParameters: true,
      maxErrors: 10,
    }).validateRequest(get({ tags: ["a"], "tags[]": ["b"] }));
    expect(result.valid).toBe(true);
  });

  it("still flags a genuinely unknown key", () => {
    const result = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      strictQueryParameters: true,
    }).validateRequest(get({ tags: ["a"], junk: "x" }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['unknown query parameter "junk"']);
  });

  it("flags the bracketed spelling when the option is off", () => {
    const result = createValidator(specWith("tags"), {
      strictQueryParameters: true,
    }).validateRequest(get({ tags: ["a"], "tags[]": ["b"] }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['unknown query parameter "tags[]"']);
  });

  it("does not make a non-array parameter's bracketed spelling known", () => {
    const result = createValidator(specWith("tags", { type: "string" }), {
      allowBracketedQueryArrays: true,
      strictQueryParameters: true,
    }).validateRequest(get({ tags: "a", "tags[]": "b" }));
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['unknown query parameter "tags[]"']);
  });
});

describe("allowBracketedQueryArrays across both query sources", () => {
  it("gives the same answer for a path-embedded query string", () => {
    const validator = createValidator(specWith("tags"), { allowBracketedQueryArrays: true });
    const embedded = validator.validateRequest({
      method: "GET",
      path: "/w?tags[]=a&tags[]=b",
    } as HttpRequest);
    const supplied = validator.validateRequest(get({ "tags[]": ["a", "b"] }));
    expect(embedded).toEqual(supplied);
    expect(embedded.valid).toBe(true);
  });

  it("leaves a path-embedded bracketed query failing when the option is off", () => {
    const result = createValidator(specWith("tags")).validateRequest({
      method: "GET",
      path: "/w?tags[]=a&tags[]=b",
    } as HttpRequest);
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });
});

describe("allowBracketedQueryArrays leaves other shapes alone", () => {
  it("does not disturb a deepObject parameter", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/w": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                required: true,
                style: "deepObject",
                explode: true,
                schema: {
                  type: "object",
                  properties: { colour: { type: "string" } },
                  required: ["colour"],
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const off = createValidator(spec).validateRequest(get({ "filter[colour]": "red" }));
    const on = createValidator(spec, { allowBracketedQueryArrays: true }).validateRequest(
      get({ "filter[colour]": "red" }),
    );
    expect(on).toEqual(off);
    expect(on.valid).toBe(true);
  });

  it("does not add a bracketed spelling for header, cookie, or path parameters", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/w/{seg}": {
          get: {
            parameters: [
              {
                name: "seg",
                in: "path",
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "X-Tags",
                in: "header",
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "jar",
                in: "cookie",
                required: true,
                schema: { type: "array", items: { type: "string" } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(spec, {
      allowBracketedQueryArrays: true,
      maxErrors: 10,
    }).validateRequest({
      method: "GET",
      path: "/w/a,b",
      headers: { "x-tags[]": "a,b" },
      cookies: { "jar[]": "a,b" },
    } as unknown as HttpRequest);
    expect(result.valid).toBe(false);
    // The path parameter matched; the bracketed header and cookie did
    // not, because brackets are a query-string convention only.
    expect(messages(result).sort()).toEqual([
      'missing required cookie parameter "jar"',
      'missing required header parameter "X-Tags"',
    ]);
  });
});

describe("allowBracketedQueryArrays eligibility is schema-derived", () => {
  it("gives the alias to a parameter whose array schema arrives through $ref", () => {
    const viaRef = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { schemas: { Tags: { type: "array", items: { type: "string" } } } },
      paths: {
        "/w": {
          get: {
            parameters: [
              {
                name: "tags",
                in: "query",
                required: true,
                schema: { $ref: "#/components/schemas/Tags" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(viaRef, { allowBracketedQueryArrays: true }).validateRequest(
      get({ "tags[]": ["a", "b"] }),
    );
    expect(result.valid).toBe(true);
  });

  it("withholds the alias when a $ref resolves to a non-array schema", () => {
    const viaRef = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { schemas: { Tag: { type: "string" } } },
      paths: {
        "/w": {
          get: {
            parameters: [
              {
                name: "tags",
                in: "query",
                required: true,
                schema: { $ref: "#/components/schemas/Tag" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const result = createValidator(viaRef, { allowBracketedQueryArrays: true }).validateRequest(
      get({ "tags[]": "a" }),
    );
    expect(result.valid).toBe(false);
    expect(messages(result)).toEqual(['missing required query parameter "tags"']);
  });

  it("leaves a deepObject parameter's own bracketed keys to the object assembler", () => {
    // `filter[]` is consumed by deepObject assembly, which runs before
    // any scalar or array lookup. Turning this option on must not change
    // that, and the object-typed parameter gains no alias of its own.
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/w": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                required: true,
                style: "deepObject",
                explode: true,
                schema: { type: "object", properties: { colour: { type: "string" } } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const off = createValidator(spec).validateRequest(get({ "filter[]": "x" }));
    const on = createValidator(spec, { allowBracketedQueryArrays: true }).validateRequest(
      get({ "filter[]": "x" }),
    );
    expect(on).toEqual(off);
  });
});

describe("allowBracketedQueryArrays with returnValues", () => {
  it("reports an accepted bracketed key under the declared name", () => {
    const validator = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      returnValues: true,
    });
    const result = validator.validateRequest(get({ "tags[]": ["a", "b"] }));
    expect(result.valid).toBe(true);
    // The value channel is keyed by what the document declares, so a
    // caller reads `tags` whichever spelling arrived on the wire.
    expect(result.value.query["tags"]).toEqual(["a", "b"]);
    expect("tags[]" in result.value.query).toBe(false);
  });

  it("reports it under the declared name from a path-embedded query too", () => {
    const validator = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      returnValues: true,
    });
    const result = validator.validateRequest({
      method: "GET",
      path: "/w?tags[]=a&tags[]=b",
    } as HttpRequest);
    expect(result.valid).toBe(true);
    expect(result.value.query["tags"]).toEqual(["a", "b"]);
  });

  it("stays consistent with strictQueryParameters also on", () => {
    const validator = createValidator(specWith("tags"), {
      allowBracketedQueryArrays: true,
      returnValues: true,
      strictQueryParameters: true,
    });
    const result = validator.validateRequest(get({ "tags[]": ["a"] }));
    expect(result.valid).toBe(true);
    expect(result.value.query["tags"]).toEqual(["a"]);
  });
});
