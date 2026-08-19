import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { httpRequestFromFetch } from "../src/from-fetch.js";
import { createValidator } from "../src/validator.js";

/**
 * The Fetch adapter and the `Cookie` header (#827), and a repeated
 * cookie name (#826).
 *
 * `httpRequestFromFetch` built `method`, `path`, `query`, `headers`,
 * `contentType` and `body` and left `cookies` unset. The validator reads
 * cookie parameters from that field only, so on Next.js, Hono, Bun and
 * Deno a declared cookie parameter was invisible: a required one failed
 * as missing, an optional one was never checked, and an `apiKey` scheme
 * `in: cookie` could not be satisfied. The header was in `headers` the
 * whole time, so the information reached the adapter and was dropped at
 * the boundary.
 *
 * This is the one adapter that parses the header itself, so it is the
 * one that can carry a repeated name. Express and Fastify pass through
 * whatever `cookie-parser` or `@fastify/cookie` produced, and those keep
 * one value per name.
 */

const req = async (cookie: string | undefined) =>
  (
    await httpRequestFromFetch(
      new Request("https://x.test/t", cookie === undefined ? {} : { headers: { cookie } }),
    )
  ).httpRequest;

const spec = (schema: unknown, name = "session"): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/t": {
        get: {
          parameters: [
            { name, in: "cookie", required: true, style: "cookie", explode: true, schema },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

describe("httpRequestFromFetch populates cookies", () => {
  it("satisfies a declared cookie parameter", async () => {
    const r = createValidator(spec({ type: "string" })).validateRequest(await req("session=abc"));
    expect(r.valid).toBe(true);
  });

  it("leaves cookies unset when the request sends no Cookie header", async () => {
    expect((await req(undefined)).cookies).toBeUndefined();
  });

  it("satisfies an apiKey scheme declared in: cookie", async () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { securitySchemes: { k: { type: "apiKey", in: "cookie", name: "sid" } } },
      security: [{ k: [] }],
      paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
    } as unknown as OpenAPIDocument;
    const v = createValidator(doc, { validateSecurity: "shape" });
    expect(v.validateRequest(await req("sid=abc")).valid).toBe(true);
    expect(v.validateRequest(await req("other=abc")).valid).toBe(false);
  });
});

describe("the splitting rules", () => {
  // RFC 6265 4.2.1 gives the grammar; the rest is a receiving-side
  // choice, so each rule is a case rather than an inference from one
  // example. Decoding matches the query values in the same request, and
  // deviates from `style: cookie`, which says no escaping is applied;
  // see the note on `HttpRequest.cookies`.
  const cases: Array<[string, string, Record<string, string | string[]> | undefined]> = [
    ["one crumb", "a=1", { a: "1" }],
    ["several crumbs", "a=1; b=2", { a: "1", b: "2" }],
    ["surrounding whitespace is trimmed", "  a = 1 ;  b=2  ", { a: "1", b: "2" }],
    ["splits at the first = only", "a=b=c", { a: "b=c" }],
    ["a crumb with no = names nothing", "a=1; nope; b=2", { a: "1", b: "2" }],
    ["an empty value is a value", "a=; b=2", { a: "", b: "2" }],
    ["an empty name is dropped", "=1; b=2", { b: "2" }],
    ["nothing parseable leaves the field unset", "nope", undefined],
    ["values are percent-decoded", "a=%20b%3Dc", { a: " b=c" }],
    // The deviation, pinned so it is a decision rather than a surprise:
    // OpenAPI 3.2's `style: cookie` says no escaping is applied, and the
    // adapter cannot see the style.
    [
      "a style: cookie escape is decoded anyway",
      "greeting=Hello%2C%20world",
      { greeting: "Hello, world" },
    ],
    ["names are not decoded", "a%20b=1", { "a%20b": "1" }],
    ["a value that will not decode passes through", "a=100%; b=%zz", { a: "100%", b: "%zz" }],
    ["a DQUOTE-wrapped value is unwrapped", 'a="abc"', { a: "abc" }],
    ["an unbalanced quote is kept", 'a="abc', { a: '"abc' }],
    ["decoding runs after the crumb split", "a=x%3By", { a: "x;y" }],
    ["a repeated name collects in header order", "p=blue; p=black", { p: ["blue", "black"] }],
    ["three of the same name", "p=1; p=2; p=3", { p: ["1", "2", "3"] }],
  ];

  for (const [label, header, expected] of cases) {
    it(label, async () => {
      expect((await req(header)).cookies).toEqual(expected);
    });
  }
});

describe("a cookie named after an inherited member", () => {
  // `prototype-members.test.ts` pins this for a caller-built request.
  // The Fetch adapter builds the record itself, so the invariant has to
  // hold on the way in too: no reader-side own-property check can repair
  // a record whose prototype was already rewritten.
  it("reads a cookie named `constructor` as its own value", async () => {
    const r = await req("constructor=abc");
    expect((r.cookies as Record<string, unknown>)["constructor"]).toBe("abc");
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [
              { name: "constructor", in: "cookie", required: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(createValidator(doc).validateRequest(r).valid).toBe(true);
  });

  it("does not let a repeated `__proto__` forge a parameter", async () => {
    // Assigning through a plain `out[name]` set the record's prototype
    // to an array, so a required `length` parameter resolved to its
    // element count and a request that sent no such cookie validated.
    const r = await req("__proto__=a; __proto__=b");
    expect(Object.keys(r.cookies ?? {})).toEqual(["__proto__"]);
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [
              { name: "length", in: "cookie", required: true, schema: { type: "integer" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(createValidator(doc).validateRequest(r).valid).toBe(false);
  });
});

describe("a repeated cookie name reaches the schema", () => {
  it("validates an exploded array under style: cookie", async () => {
    // The case #826 names: `minItems` above 1 used to reject a
    // conforming request, because the parameter arrived one element long
    // however many crumbs were sent.
    const doc = spec({ type: "array", items: { type: "string" }, minItems: 2 }, "p");
    const r = createValidator(doc).validateRequest(await req("p=blue; p=black"));
    expect(r.valid).toBe(true);
  });

  it("still rejects a single crumb against minItems: 2", async () => {
    const doc = spec({ type: "array", items: { type: "string" }, minItems: 2 }, "p");
    expect(createValidator(doc).validateRequest(await req("p=blue")).valid).toBe(false);
  });

  it("takes the first crumb where one value is called for", async () => {
    // A security credential is one value, matching what the query branch
    // beside it does with a repeated query parameter. An empty first
    // crumb is the case that distinguishes taking the first from passing
    // the array through: the array is neither undefined nor "", so the
    // scheme would read as satisfied.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: { securitySchemes: { k: { type: "apiKey", in: "cookie", name: "sid" } } },
      security: [{ k: [] }],
      paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
    } as unknown as OpenAPIDocument;
    const v = createValidator(doc, { validateSecurity: "shape" });
    expect(v.validateRequest(await req("sid=a; sid=b")).valid).toBe(true);
    expect(v.validateRequest(await req("sid=; sid=b")).valid).toBe(false);
  });
});
