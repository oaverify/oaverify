import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { checkDocumentExamples } from "../src/example-check.js";
import { createValidator } from "../src/validator.js";

const doc = (extra: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
    paths: {},
    ...extra,
  }) as unknown as OpenAPIDocument;

/** A minimal POST operation carrying one JSON media type object. */
const withJsonBody = (mediaType: Record<string, unknown>) =>
  doc({
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: { content: { "application/json": mediaType } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

describe("checkDocumentExamples", () => {
  describe("Schema Object examples (#541)", () => {
    it("reports an example its own schema rejects", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema: { type: "object", properties: { count: { type: "integer", example: "no" } } },
        }),
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        code: "example-invalid",
        pointer:
          "/paths/~1things/post/requestBody/content/application~1json/schema/properties/count/example",
      });
      expect(issues[0]?.message).toContain("must be integer");
    });

    it("reports each failing member of an examples array, by index", () => {
      const issues = checkDocumentExamples(
        withJsonBody({ schema: { type: "string", examples: ["ok", 42, "fine", null] } }),
      );

      expect(issues).toHaveLength(2);
      expect(issues[0]?.pointer).toMatch(/\/schema\/examples\/1$/);
      expect(issues[1]?.pointer).toMatch(/\/schema\/examples\/3$/);
    });

    it("inherits every keyword, not just type", () => {
      const cases = [
        { type: "string", enum: ["a", "b"], example: "c" },
        { type: "string", minLength: 4, example: "ab" },
        { type: "string", format: "uri", example: "not a uri" },
        { type: "object", required: ["id"], properties: { id: { type: "string" } }, example: {} },
      ];
      for (const schema of cases) {
        expect(
          checkDocumentExamples(withJsonBody({ schema })),
          JSON.stringify(schema),
        ).toHaveLength(1);
      }
    });

    it("is silent on examples that validate", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema: {
            type: "object",
            properties: { count: { type: "integer", example: 3, examples: [1, 2] } },
          },
        }),
      );
      expect(issues).toEqual([]);
    });

    it("skips a non-array examples (the 3.0 Example Object map shape)", () => {
      // Under 3.1 `examples` must be an array of literals. The map shape
      // appears anyway; its wrapper objects cannot satisfy the schema, so
      // validating them would report a confusing type error rather than
      // the real problem, which is document structure (#491).
      const issues = checkDocumentExamples(
        withJsonBody({ schema: { type: "string", examples: { standard: { value: "ABC" } } } }),
      );
      expect(issues).toEqual([]);
    });
  });

  describe("Media Type Object examples (#552)", () => {
    const schema = {
      type: "object",
      required: ["count"],
      properties: { count: { type: "integer" } },
    };

    it("reports a singular example against the sibling schema", () => {
      const issues = checkDocumentExamples(
        withJsonBody({ schema, example: { count: "not-an-integer" } }),
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe(
        "/paths/~1things/post/requestBody/content/application~1json/example",
      );
    });

    it("reports each failing entry of the examples map, by name", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema,
          examples: {
            wrong: { value: { count: "no" } },
            incomplete: { value: {} },
            good: { value: { count: 1 } },
          },
        }),
      );

      expect(issues).toHaveLength(2);
      expect(issues[0]?.pointer).toMatch(/\/examples\/wrong\/value$/);
      expect(issues[1]?.pointer).toMatch(/\/examples\/incomplete\/value$/);
    });

    it("skips an entry carrying externalValue, which oaverify does not fetch", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema,
          examples: { external: { externalValue: "https://example.com/e.json" } },
        }),
      );
      expect(issues).toEqual([]);
    });

    it("resolves a $ref'd media type schema", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/things": {
              post: {
                operationId: "createThing",
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Thing" },
                      example: { count: "no" },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
          components: { schemas: { Thing: schema } },
        }),
      );
      expect(issues).toHaveLength(1);
    });
  });

  describe("the direction transform must not reach this pass", () => {
    // The bug that moved this check out of `schemaLint`: body schemas
    // compile per direction, with `readOnly` rewritten to `false` on the
    // request leg, so a component example that is a correct response was
    // reported as invalid against the request variant.
    const readOnlyDoc = (components: Record<string, unknown>) =>
      doc({
        paths: {
          "/things": {
            post: {
              operationId: "createThing",
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
              },
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
                  },
                },
              },
            },
          },
        },
        components: { schemas: components },
      });

    it("does not report an example containing a readOnly property", () => {
      const issues = checkDocumentExamples(
        readOnlyDoc({
          Thing: {
            type: "object",
            properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
            example: { id: "abc123", name: "widget" },
          },
        }),
      );
      expect(issues).toEqual([]);
    });

    it("does not report a writeOnly property either", () => {
      const issues = checkDocumentExamples(
        readOnlyDoc({
          Thing: {
            type: "object",
            properties: { secret: { type: "string", writeOnly: true } },
            example: { secret: "s3cret" },
          },
        }),
      );
      expect(issues).toEqual([]);
    });

    it("does not report a readOnly property nested behind a $ref", () => {
      const issues = checkDocumentExamples(
        readOnlyDoc({
          Child: { type: "object", properties: { id: { type: "string", readOnly: true } } },
          Thing: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Child" } },
            example: { child: { id: "abc" } },
          },
        }),
      );
      expect(issues).toEqual([]);
    });
  });

  describe("locations", () => {
    it("reports a shared component once, at its own definition", () => {
      const ref = { $ref: "#/components/schemas/Thing" };
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              post: {
                operationId: "a",
                requestBody: { content: { "application/json": { schema: ref } } },
                responses: { "200": { description: "ok" } },
              },
            },
            "/b": {
              post: {
                operationId: "b",
                requestBody: { content: { "application/json": { schema: ref } } },
                responses: { "200": { description: "ok" } },
              },
            },
          },
          components: { schemas: { Thing: { type: "integer", example: "no" } } },
        }),
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe("/components/schemas/Thing/example");
    });

    it("escapes / and ~ in pointer tokens", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a~b/c": {
              post: {
                operationId: "weird",
                requestBody: {
                  content: { "application/json": { schema: { type: "integer", example: "no" } } },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );

      expect(issues[0]?.pointer).toBe(
        "/paths/~1a~0b~1c/post/requestBody/content/application~1json/schema/example",
      );
    });

    it("covers parameters, headers and component sections", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              parameters: [{ name: "p", in: "query", schema: { type: "integer", example: "no" } }],
              get: {
                operationId: "a",
                parameters: [
                  { name: "q", in: "query", schema: { type: "integer", example: "no" } },
                ],
                responses: {
                  "200": {
                    description: "ok",
                    headers: { "X-Count": { schema: { type: "integer", example: "no" } } },
                  },
                },
              },
            },
          },
          components: {
            parameters: {
              P: { name: "p", in: "query", schema: { type: "integer", example: "no" } },
            },
            headers: { H: { schema: { type: "integer", example: "no" } } },
            requestBodies: {
              B: {
                content: { "application/json": { schema: { type: "integer", example: "no" } } },
              },
            },
            responses: {
              R: {
                description: "ok",
                content: { "application/json": { schema: { type: "integer", example: "no" } } },
              },
            },
          },
        }),
      );

      expect(issues.map((i) => i.pointer).sort()).toEqual([
        "/components/headers/H/schema/example",
        "/components/parameters/P/schema/example",
        "/components/requestBodies/B/content/application~1json/schema/example",
        "/components/responses/R/content/application~1json/schema/example",
        "/paths/~1a/get/parameters/0/schema/example",
        "/paths/~1a/get/responses/200/headers/X-Count/schema/example",
        "/paths/~1a/parameters/0/schema/example",
      ]);
    });
  });

  describe("dialect", () => {
    it("uses the 3.0 dialect for a 3.0 document, so nullable is honoured", () => {
      // Under 3.0, `nullable: true` admits null. Compiling this example
      // under 2020-12 semantics would report a false positive.
      const issues = checkDocumentExamples({
        openapi: "3.0.3",
        info: { title: "t", version: "1.0.0" },
        paths: {
          "/a": {
            post: {
              operationId: "a",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "string", nullable: true, example: null },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument);

      expect(issues).toEqual([]);
    });
  });

  describe("Parameter and Header Object examples (#560)", () => {
    // These sit beside `schema` rather than inside it, the same shape a
    // Media Type Object has. Redocly reported one of these on asana that
    // oaverify missed, which is how the gap was found.
    it("reports a parameter's own example", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              get: {
                operationId: "a",
                parameters: [
                  { name: "limit", in: "query", schema: { type: "integer" }, example: "no" },
                ],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe("/paths/~1a/get/parameters/0/example");
    });

    it("reports a parameter's examples map, skipping externalValue", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              get: {
                operationId: "a",
                parameters: [
                  {
                    name: "limit",
                    in: "query",
                    schema: { type: "integer" },
                    examples: {
                      bad: { value: "no" },
                      good: { value: 5 },
                      remote: { externalValue: "https://example.com/e.json" },
                    },
                  },
                ],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );
      expect(issues.map((i) => i.pointer)).toEqual([
        "/paths/~1a/get/parameters/0/examples/bad/value",
      ]);
    });

    it("reports a response header's own example", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              get: {
                operationId: "a",
                responses: {
                  "200": {
                    description: "ok",
                    headers: { "X-Count": { schema: { type: "integer" }, example: "no" } },
                  },
                },
              },
            },
          },
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe("/paths/~1a/get/responses/200/headers/X-Count/example");
    });

    it("does not double-report when a parameter uses content instead of schema", () => {
      // A parameter carries `schema` or `content`, never both. With
      // `content`, the examples belong to the media type beneath it.
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              get: {
                operationId: "a",
                parameters: [
                  {
                    name: "filter",
                    in: "query",
                    content: {
                      "application/json": { schema: { type: "integer" }, example: "no" },
                    },
                  },
                ],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );
      expect(issues.map((i) => i.pointer)).toEqual([
        "/paths/~1a/get/parameters/0/content/application~1json/example",
      ]);
    });

    it("reports a header example inside an Encoding Object", () => {
      // `encoding.<property>.headers.<name>` is a legal Header Object
      // position. Caught in review: the branch covered parameters and
      // response headers and missed this one.
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/upload": {
              post: {
                operationId: "upload",
                requestBody: {
                  content: {
                    "multipart/form-data": {
                      schema: { type: "object", properties: { file: { type: "string" } } },
                      encoding: {
                        file: {
                          headers: { "X-Part": { schema: { type: "integer" }, example: "no" } },
                        },
                      },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );
      expect(issues.map((i) => i.pointer)).toEqual([
        "/paths/~1upload/post/requestBody/content/multipart~1form-data/encoding/file/headers/X-Part/example",
      ]);
    });

    it("is silent on a valid parameter example", () => {
      expect(
        checkDocumentExamples(
          doc({
            paths: {
              "/a": {
                get: {
                  operationId: "a",
                  parameters: [
                    { name: "limit", in: "query", schema: { type: "integer" }, example: 5 },
                  ],
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("containers the walk must not miss", () => {
    it("descends into operation callbacks", () => {
      const issues = checkDocumentExamples(
        doc({
          paths: {
            "/a": {
              post: {
                operationId: "a",
                responses: { "200": { description: "ok" } },
                callbacks: {
                  onEvent: {
                    "{$request.body#/url}": {
                      post: {
                        requestBody: {
                          content: {
                            "application/json": { schema: { type: "integer", example: "no" } },
                          },
                        },
                        responses: { "200": { description: "ok" } },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe(
        "/paths/~1a/post/callbacks/onEvent/{$request.body#~1url}/post/requestBody/content/application~1json/schema/example",
      );
    });

    it("descends into components.pathItems and components.callbacks", () => {
      // Distinct objects: the walk reports a shared schema once, by
      // identity, which is the dedup this pass relies on elsewhere.
      const badA = { type: "integer", example: "no" };
      const badB = { type: "integer", example: "no" };
      const issues = checkDocumentExamples(
        doc({
          components: {
            pathItems: {
              Item: {
                get: {
                  responses: {
                    "200": { description: "ok", content: { "application/json": { schema: badA } } },
                  },
                },
              },
            },
            callbacks: {
              Cb: {
                "{$request.body#/url}": {
                  post: {
                    requestBody: { content: { "application/json": { schema: badB } } },
                    responses: { "200": { description: "ok" } },
                  },
                },
              },
            },
          },
        }),
      );
      // One compile, one finding per distinct example location.
      expect(issues.map((i) => i.pointer).sort()).toEqual([
        "/components/callbacks/Cb/{$request.body#~1url}/post/requestBody/content/application~1json/schema/example",
        "/components/pathItems/Item/get/responses/200/content/application~1json/schema/example",
      ]);
    });

    it("descends into webhooks", () => {
      const issues = checkDocumentExamples(
        doc({
          webhooks: {
            thing: {
              post: {
                requestBody: {
                  content: { "application/json": { schema: { type: "integer", example: "no" } } },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toMatch(/^\/webhooks\/thing\/post\//);
    });
  });

  describe("stays consistent with the validator", () => {
    // A schema-resource-local fragment (`#/$defs/X` inside a component)
    // is not resolvable in an OpenAPI document: the Schema Object's base
    // is the document, so the pointer means the document root. The
    // validator throws on these, and `check` reports them as fatal
    // `malformed-schema`. This pass declining is what keeps it from
    // stacking a second, less useful finding on top of a fatal one.
    const referencing = (name: string) => ({
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: {
            content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    });

    it("declines where the validator itself cannot compile the schema", () => {
      const localDefs = doc({
        paths: referencing("Thing"),
        components: {
          schemas: {
            Thing: {
              $defs: { Count: { type: "integer" } },
              type: "object",
              properties: { count: { $ref: "#/$defs/Count" } },
              example: { count: "not-an-integer" },
            },
          },
        },
      });
      expect(checkDocumentExamples(localDefs)).toEqual([]);
      // The document is not silently accepted: compiling it reports a
      // malformed schema, which is what `check` surfaces as fatal.
      const failures = createValidator(localDefs).precompile({ onMalformed: "collect" });
      expect(failures.map((f) => f.message).join()).toMatch(/\$defs\/Count/);
    });

    it("declines a relative $ref under an $id, which the validator also rejects", () => {
      const relative = doc({
        paths: referencing("Root"),
        components: {
          schemas: {
            Root: {
              $id: "https://api.example/root.json",
              type: "object",
              properties: { a: { $ref: "defs.json", example: "not-an-integer" } },
            },
            Def: { $id: "https://api.example/defs.json", type: "integer" },
          },
        },
      });
      expect(checkDocumentExamples(relative)).toEqual([]);
      const failures = createValidator(relative).precompile({ onMalformed: "collect" });
      expect(failures.map((f) => f.message).join()).toMatch(/defs\.json/);
    });
  });

  describe("every reason, not only the first (#579)", () => {
    /** Wrong in four independent ways, as real examples usually are. */
    const fourWays = withJsonBody({
      schema: {
        type: "object",
        required: ["when", "form", "amount", "taxId"],
        properties: {
          when: { type: "string", format: "date" },
          form: { type: "string", enum: ["ACH", "CHECK"] },
        },
      },
      example: { when: 20260116, form: "EFT" },
    });

    it("reports all of them in one finding", () => {
      const issues = checkDocumentExamples(fourWays);

      expect(issues).toHaveLength(1);
      const message = issues[0]?.message ?? "";
      expect(message).toContain("when: must be string");
      expect(message).toContain("form: must be one of the allowed values");
      expect(message).toContain('must have required property "amount"');
      expect(message).toContain('must have required property "taxId"');
      expect(message).not.toContain("more");
    });

    it("caps the list and says how many it dropped", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema: {
            type: "object",
            required: ["a", "b", "c", "d", "e", "f", "g"],
          },
          example: {},
        }),
      );

      expect(issues).toHaveLength(1);
      // Five spelled out, the remaining two counted.
      expect(issues[0]?.message).toContain("; and 2 more");
      expect(issues[0]?.message).not.toContain('property "g"');
    });

    it("reports one reason per defect where branches restate it", () => {
      const issues = checkDocumentExamples(
        withJsonBody({
          schema: { anyOf: [{ type: "string" }, { type: "string", format: "date" }] },
          example: 42,
        }),
      );

      expect(issues).toHaveLength(1);
      const message = issues[0]?.message ?? "";
      expect(message.match(/must be string/g)).toHaveLength(1);
    });
  });

  it("declines a schema that will not compile rather than guessing", () => {
    const issues = checkDocumentExamples(
      withJsonBody({ schema: { $ref: "#/components/schemas/Missing", example: "anything" } }),
    );
    expect(issues).toEqual([]);
  });

  it("returns nothing for a document with no examples", () => {
    expect(checkDocumentExamples(withJsonBody({ schema: { type: "object" } }))).toEqual([]);
  });
});
