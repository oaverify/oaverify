import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { walkDocumentSchemas } from "../src/document-walk.js";
import { createValidator } from "../src/validator.js";

const ok = { "200": { description: "ok" } };

function doc(paths: Record<string, unknown>, version = "3.1.0"): OpenAPIDocument {
  return { openapi: version, info: { title: "t", version: "1" }, paths } as OpenAPIDocument;
}

describe("an x- key under paths is a specification extension, not a path (#1342)", () => {
  const document = doc({
    "/real": { get: { responses: ok } },
    "x-vendor": {
      get: {
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: ok,
      },
    },
  });

  it("is not routed", () => {
    const validator = createValidator(document);
    for (const path of ["/x-vendor", "x-vendor"]) {
      expect(validator.getOperation({ method: "GET", path })).toBeNull();
      expect(validator.matchRoute({ method: "GET", path }).kind).toBe("no-match");
      const result = validator.validateRequest({ method: "GET", path, headers: {}, query: {} });
      expect(result.valid).toBe(false);
      expect(result.valid ? [] : result.errors.map((error) => error.code)).toEqual(["route"]);
    }
    expect(validator.getOperation({ method: "GET", path: "/real" })).not.toBeNull();
  });

  it("still routes a path whose template merely starts with /x-", () => {
    const validator = createValidator(doc({ "/x-vendor": { get: { responses: ok } } }));
    expect(validator.getOperation({ method: "GET", path: "/x-vendor" })).not.toBeNull();
  });

  it("does not take part in route conflicts", () => {
    expect(() =>
      createValidator(
        doc({ "x-a/{id}": { get: { responses: ok } }, "x-a/{name}": { get: { responses: ok } } }),
      ),
    ).not.toThrow();
  });

  it("is not held to the parameter locations a served operation needs", () => {
    expect(() =>
      createValidator(
        doc({
          "x-vendor": {
            get: { parameters: [{ name: "q", in: "nowhere" }], responses: ok },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("draws the line at the x- prefix exactly", () => {
    const paths: Record<string, unknown> = {};
    const keys = ["x-", "x-vendor/{id}", "X-vendor", " x-vendor", "/x-vendor", ""];
    for (const key of keys) paths[key] = { get: { operationId: key, responses: ok } };
    const validator = createValidator(doc(paths));
    const routed = keys.filter(
      (key) => validator.getOperation({ method: "GET", path: key.replace("{id}", "1") }) !== null,
    );
    expect(routed).toEqual(["X-vendor", " x-vendor", "/x-vendor", ""]);
  });

  it("is still walked for schemas, so the checks and guards fed by the walk cover what they did", () => {
    const roots: string[] = [];
    walkDocumentSchemas(
      doc({
        "x-vendor": {
          get: { parameters: [{ name: "q", in: "query", schema: { type: "string" } }] },
        },
      }),
      { onSchemaRoot: (_schema, pointer) => roots.push(pointer) },
    );
    expect(roots).toEqual(["/paths/x-vendor/get/parameters/0/schema"]);
  });

  it("keeps OAS 3.0 $ref-sibling handling as the resolver has it", () => {
    // Under 3.0 the siblings of a schema `$ref` are discarded, so a
    // reference into them has nothing to address. That holds inside an
    // `x-` key too, for an internal reference as for an external one.
    const document = {
      ...doc(
        {
          "x-vendor": {
            get: {
              parameters: [
                {
                  name: "q",
                  in: "query",
                  schema: {
                    $ref: "#/components/schemas/S",
                    properties: { n: { type: "integer" } },
                  },
                },
              ],
              responses: ok,
            },
          },
          "/real": {
            get: {
              parameters: [
                {
                  name: "n",
                  in: "query",
                  schema: { $ref: "#/paths/x-vendor/get/parameters/0/schema/properties/n" },
                },
              ],
              responses: ok,
            },
          },
        },
        "3.0.3",
      ),
      components: { schemas: { S: { type: "object" } } },
    } as OpenAPIDocument;
    const validator = createValidator(document);
    expect(() =>
      validator.validateRequest({ method: "GET", path: "/real", headers: {}, query: { n: "1" } }),
    ).toThrow(/no addressable members/);
  });
});
