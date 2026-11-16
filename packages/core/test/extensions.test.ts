import { expect, expectTypeOf, it } from "vitest";
import type {
  JsonValue,
  OpenAPIDocument,
  OperationObject,
  ReferenceObject,
  ResponseObject,
  ServerObject,
} from "../src/index.js";

it("accepts x- fields on the objects OpenAPI lets carry them (#1322)", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "t", version: "1", "x-info": 1 },
    servers: [
      {
        url: "https://{region}.example.com",
        variables: { region: { default: "eu", "x-variable": 1 } },
        "x-server": 1,
      },
    ],
    tags: [{ name: "pets", "x-tag": 1 }],
    paths: {
      "/pets": {
        "x-path-item": 1,
        get: {
          "x-operation": 1,
          externalDocs: { url: "https://example.com/docs", "x-external-docs": 1 },
          parameters: [{ name: "limit", in: "query", "x-parameter": 1 }],
          requestBody: {
            "x-request-body": 1,
            content: { "application/json": { schema: {}, "x-media-type": 1 } },
          },
          responses: {
            "200": {
              description: "ok",
              "x-response": 1,
              headers: { "X-Rate-Limit": { schema: { type: "integer" }, "x-header": 1 } },
            },
          },
        },
      },
    },
    components: {
      "x-components": 1,
      schemas: {
        Pet: { discriminator: { propertyName: "kind", "x-discriminator": 1 } },
      },
      securitySchemes: { key: { type: "apiKey", name: "k", in: "header", "x-scheme": 1 } },
      links: { next: { operationId: "listPets", "x-link": 1 } },
      examples: { one: { value: 1, "x-example": 1 } },
    },
  } satisfies OpenAPIDocument;
  expect(document.servers[0]?.["x-server"]).toBe(1);

  // A value of any JSON shape, and nothing else.
  const nested: ServerObject = { url: "u", "x-owner": { team: ["a", "b"], oncall: null } };
  expect(nested["x-owner"]).toEqual({ team: ["a", "b"], oncall: null });
  expectTypeOf<ServerObject["x-owner"]>().toEqualTypeOf<JsonValue | undefined>();
  // @ts-expect-error An extension value must be JSON.
  const notJson: ServerObject = { url: "u", "x-factory": () => 1 };
  expect(notJson.url).toBe("u");
});

it("keeps checking the declared fields beside an x- field (#1322)", () => {
  expectTypeOf<ServerObject["url"]>().toEqualTypeOf<string>();
  expectTypeOf<"bogus">().not.toExtend<keyof ServerObject>();

  // @ts-expect-error A field that is neither declared nor an extension.
  const unknownField: ServerObject = { url: "u", "x-a": 1, internal: true };
  expect(unknownField.url).toBe("u");

  // @ts-expect-error A declared field keeps its type.
  const wrongType: OperationObject = { "x-a": 1, deprecated: "yes" };
  expect(wrongType["x-a"]).toBe(1);

  const describe = (response: ResponseObject | ReferenceObject): string | undefined => {
    if ("$ref" in response) {
      expectTypeOf(response).toEqualTypeOf<ReferenceObject>();
      return response.$ref;
    }
    expectTypeOf(response).toEqualTypeOf<ResponseObject>();
    return response.description;
  };
  expect(describe({ description: "ok", "x-a": 1 })).toBe("ok");
  expect(describe({ $ref: "#/components/responses/Ok" })).toBe("#/components/responses/Ok");
});

it("does not let a value typed as a Reference Object carry an x- field (#1322)", () => {
  // @ts-expect-error OpenAPI 3.1 forbids extending a Reference Object.
  const reference: ReferenceObject = { $ref: "#/components/schemas/Pet", "x-a": 1 };
  expect(reference.$ref).toBe("#/components/schemas/Pet");
});

it("accepts $ref beside an x- field where a Response Object is also allowed (#1322)", () => {
  // TypeScript checks a literal's extra properties against every member
  // of the union, and ResponseObject declares the x- signature.
  const response = {
    $ref: "#/components/responses/Ok",
    "x-a": 1,
  } satisfies ResponseObject | ReferenceObject;
  expect(response.$ref).toBe("#/components/responses/Ok");
});
