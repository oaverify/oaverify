/**
 * Document pointers on schema lint findings, end to end through the
 * HTTP validator (#517).
 *
 * The compiler can address a finding within the schema it was handed;
 * only the validator knows where that schema sits in the document. This
 * is where the two meet, and it is where defect 3c lived: a body schema
 * that is a bare root `$ref` is unwrapped before compiling, so a pointer
 * built from the use site names a node that holds only the `$ref` and
 * does not resolve.
 */
import { resolveJsonPointer, type OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

const lint = (doc: OpenAPIDocument) => {
  const v = createValidator(doc, { schemaLint: "strict" });
  v.precompile();
  return v.stats.schemaLintIssues;
};

/** Every pointer a finding reports has to resolve against the document. */
const expectResolves = (doc: OpenAPIDocument, pointer: string | undefined) => {
  expect(pointer).toBeDefined();
  expect(() => resolveJsonPointer(doc, pointer as string)).not.toThrow();
};

describe("schema lint pointers through the validator", () => {
  it("addresses an inline request body schema at its use site", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/things": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { a: { minLenght: 3 } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe(
      "/paths/~1things/post/requestBody/content/application~1json/schema/properties/a",
    );
    expectResolves(doc, issue?.pointer);
  });

  it("addresses a ref-rooted request body at the target, not the use site (#517 3c)", () => {
    // The defect, reduced from evidence/appstatusv1.yaml. The use site
    // holds only `$ref`, so `.../schema/properties/cusip` resolves to
    // nothing; the compiled schema is the target.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          SearchRequest: {
            type: "object",
            properties: { cusip: { type: "string", minLenght: 9 } },
          },
        },
      },
      paths: {
        "/searches": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SearchRequest" },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe("/components/schemas/SearchRequest/properties/cusip");
    expectResolves(doc, issue?.pointer);

    // The naive derivation, which is what makes this defect silent.
    expect(() =>
      resolveJsonPointer(
        doc,
        "/paths/~1searches/post/requestBody/content/application~1json/schema/properties/cusip",
      ),
    ).toThrow();
  });

  it("follows a root ref chain to the schema actually compiled", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          Outer: { $ref: "#/components/schemas/Inner" },
          Inner: { type: "object", properties: { a: { minLenght: 1 } } },
        },
      },
      paths: {
        "/t": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Outer" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe("/components/schemas/Inner/properties/a");
    expectResolves(doc, issue?.pointer);
  });

  it("addresses a parameter through the path-item / operation merge", () => {
    // The merge dedups on (in, name) and the operation-level entry wins,
    // so an index recovered after the merge would name the wrong one.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "shadowed", in: "query", schema: { type: "string", minLenght: 1 } },
          ],
          get: {
            parameters: [
              { name: "shadowed", in: "query", schema: { type: "string", maxLenght: 2 } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issues = lint(doc);
    // The operation-level entry replaced the path-level one, so only
    // its typo is reachable.
    const codes = issues.map((i) => i.keyword);
    expect(codes).toContain("maxLenght");
    expect(codes).not.toContain("minLenght");

    const issue = issues.find((i) => i.keyword === "maxLenght");
    expect(issue?.pointer).toBe("/paths/~1t/get/parameters/0/schema");
    expectResolves(doc, issue?.pointer);
  });

  it("addresses a $ref'd parameter at its component", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      components: {
        parameters: {
          Page: { name: "page", in: "query", schema: { type: "integer", minimun: 1 } },
        },
      },
      paths: {
        "/t": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Page" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe("/components/parameters/Page/schema");
    expectResolves(doc, issue?.pointer);
  });

  it("addresses response bodies and response headers", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: {
                  "X-Rate-Limit": { schema: { type: "integer", minimun: 0 } },
                },
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { a: { nope: 1 } } },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issues = lint(doc);
    const body = issues.find((i) => i.keyword === "nope");
    expect(body?.pointer).toBe(
      "/paths/~1t/get/responses/200/content/application~1json/schema/properties/a",
    );
    expectResolves(doc, body?.pointer);

    const header = issues.find((i) => i.keyword === "minimun");
    expect(header?.pointer).toBe("/paths/~1t/get/responses/200/headers/X-Rate-Limit/schema");
    expectResolves(doc, header?.pointer);
  });

  describe("$ref chains through spec objects", () => {
    // The gap that let a non-resolving pointer ship: the branch taught
    // `unwrapRootRef` to follow a *schema* chain to its end, and did not
    // carry that to Parameter / Request Body / Response / Header, whose
    // pointers were built from the first hop while `resolveRef` followed
    // the whole chain. Only the last hop names the object resolved.
    it("addresses a chained $ref'd parameter at the end of the chain", () => {
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: {
          parameters: {
            Alias: { $ref: "#/components/parameters/Real" },
            Real: { name: "page", in: "query", schema: { type: "integer", minimun: 1 } },
          },
        },
        paths: {
          "/t": {
            get: {
              parameters: [{ $ref: "#/components/parameters/Alias" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument;

      const issue = lint(doc).find((i) => i.code === "unknown-keyword");
      expect(issue?.pointer).toBe("/components/parameters/Real/schema");
      expect(issue?.anchor).toBe("definition");
      expectResolves(doc, issue?.pointer);
      // The first hop holds no `schema`, so a one-hop reading throws.
      expect(() => resolveJsonPointer(doc, "/components/parameters/Alias/schema")).toThrow();
    });

    it("addresses a chained $ref'd request body at the end of the chain", () => {
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: {
          requestBodies: {
            Alias: { $ref: "#/components/requestBodies/Real" },
            Real: {
              content: {
                "application/json": { schema: { type: "object", properties: { a: { nope: 1 } } } },
              },
            },
          },
        },
        paths: {
          "/t": {
            post: {
              requestBody: { $ref: "#/components/requestBodies/Alias" },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument;

      const issue = lint(doc).find((i) => i.code === "unknown-keyword");
      expect(issue?.pointer).toBe(
        "/components/requestBodies/Real/content/application~1json/schema/properties/a",
      );
      expectResolves(doc, issue?.pointer);
    });

    it("addresses a chained $ref'd response at the end of the chain", () => {
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: {
          responses: {
            Alias: { $ref: "#/components/responses/Real" },
            Real: {
              description: "e",
              content: {
                "application/json": { schema: { type: "object", properties: { a: { nope: 1 } } } },
              },
            },
          },
        },
        paths: {
          "/t": { get: { responses: { "500": { $ref: "#/components/responses/Alias" } } } },
        },
      } as unknown as OpenAPIDocument;

      const issue = lint(doc).find((i) => i.code === "unknown-keyword");
      expect(issue?.pointer).toBe(
        "/components/responses/Real/content/application~1json/schema/properties/a",
      );
      expectResolves(doc, issue?.pointer);
    });
  });

  describe("anchor, decided in the validator", () => {
    // None of this was covered before: `reachedThroughRef` could have
    // returned `false` unconditionally and every test stayed green,
    // while every finding in a shared component claimed that editing it
    // affected nothing else.
    it("calls an inline schema's finding a node", () => {
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            get: {
              parameters: [{ name: "q", in: "query", schema: { nope: 1 } }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument;
      expect(lint(doc).find((i) => i.code === "unknown-keyword")?.anchor).toBe("node");
    });

    it("calls a $ref'd component's finding a definition", () => {
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: { parameters: { P: { name: "q", in: "query", schema: { nope: 1 } } } },
        paths: {
          "/t": {
            get: {
              parameters: [{ $ref: "#/components/parameters/P" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument;
      expect(lint(doc).find((i) => i.code === "unknown-keyword")?.anchor).toBe("definition");
    });

    it("calls a header inside a $ref'd response a definition, though the header is inline", () => {
      // The anchor must not downgrade: the Header Object is written
      // inline, but every operation referencing the Response shares it.
      const doc = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: {
          responses: {
            Err: {
              description: "e",
              headers: { "X-Rate-Limit": { schema: { type: "integer", minimun: 0 } } },
              content: {
                "application/json": { schema: { type: "object", properties: { a: { nope: 1 } } } },
              },
            },
          },
        },
        paths: {
          "/t": { get: { responses: { "500": { $ref: "#/components/responses/Err" } } } },
        },
      } as unknown as OpenAPIDocument;

      const issues = lint(doc);
      const header = issues.find((i) => i.keyword === "minimun");
      const body = issues.find((i) => i.keyword === "nope");
      expect(header?.anchor).toBe("definition");
      expect(body?.anchor).toBe("definition");
      expect(header?.pointer).toBe("/components/responses/Err/headers/X-Rate-Limit/schema");
      expectResolves(doc, header?.pointer);
    });
  });

  it("addresses a content-bearing parameter through its single media type", () => {
    // A parameter with `content` holds its schema one level deeper than
    // one with `schema`, so the pointer needs the media-type segment.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { a: { nope: 1 } } },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe(
      "/paths/~1t/get/parameters/0/content/application~1json/schema/properties/a",
    );
    expectResolves(doc, issue?.pointer);
  });

  it("escapes a path template rather than letting its slashes split the pointer", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a/b/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { nope: 1 } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issue = lint(doc).find((i) => i.code === "unknown-keyword");
    expect(issue?.pointer).toBe("/paths/~1a~1b~1{id}/get/parameters/0/schema");
    expectResolves(doc, issue?.pointer);
  });
});
