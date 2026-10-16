import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, ParameterObject, ReferenceObject } from "@oaverify/internal-core";
import { effectiveParameters } from "../src/effective-parameters.js";
import { resolveOperationRef } from "../src/operation-cache.js";
import { createValidator } from "../src/validator.js";

describe("effective parameter declarations", () => {
  const inherited: ParameterObject = { name: "n", in: "query", schema: { type: "string" } };
  const override: ParameterObject = { name: "n", in: "query", schema: { type: "integer" } };
  const cookie: ParameterObject = { name: "n", in: "cookie" };
  const upper: ParameterObject = { name: "X-Trace", in: "header" };
  const lower: ParameterObject = { name: "x-trace", in: "header" };
  const ref = { $ref: "#/components/parameters/Alias" };
  const document = {
    components: {
      parameters: { Alias: { $ref: "#/components/parameters/Override" }, Override: override },
    },
  } as unknown as OpenAPIDocument;
  const resolveRef = <T>(value: T | ReferenceObject | undefined): T | undefined =>
    resolveOperationRef(document, value);

  it("retains the winning raw declaration and coordinates in first-occurrence order", () => {
    const result = effectiveParameters([inherited, cookie, upper], [null, lower, ref], resolveRef);
    expect(result).toEqual([
      { raw: ref, object: override, source: "operation", index: 2 },
      { raw: cookie, object: cookie, source: "pathItem", index: 1 },
      { raw: upper, object: upper, source: "pathItem", index: 2 },
      { raw: lower, object: lower, source: "operation", index: 1 },
    ]);
    expect(result[0]?.raw).toBe(ref);
    expect(result[0]?.object).toBe(override);
  });

  it("keeps the last duplicate and excludes ignored headers after resolution", () => {
    expect(
      effectiveParameters(
        [inherited],
        [inherited, override, { name: "accept", in: "header" }],
        resolveRef,
      ),
    ).toEqual([{ raw: override, object: override, source: "operation", index: 1 }]);
  });

  it("keeps two pairs apart when a name or location contains a NUL", () => {
    const pathLevel = { name: "b", in: "query\u0000a" };
    const opLevel = { name: "a\u0000b", in: "query" };
    expect(effectiveParameters([pathLevel], [opLevel], resolveRef).map((p) => p.raw)).toEqual([
      pathLevel,
      opLevel,
    ]);
  });

  it("compares in and name as strings", () => {
    const numeric = { name: 1, in: "query" };
    const text = { name: "1", in: "query" };
    expect(effectiveParameters([numeric], [text], resolveRef).map((p) => p.raw)).toEqual([text]);
  });

  it("propagates an unresolved reference even if a later parameter would override it", () => {
    expect(() =>
      effectiveParameters([{ $ref: "external.json#/Parameter" }], [override], resolveRef),
    ).toThrow('external ref "external.json#/Parameter" not resolved');
  });

  it.each([false, true])(
    "locates the winning schema during precompile (reference: %s)",
    (referenced) => {
      const bad = { name: "n", in: "query", schema: { type: "array", items: [1] } };
      const doc = {
        openapi: "3.1.0",
        info: { title: "Origins", version: "1" },
        paths: {
          "/t": {
            parameters: [inherited],
            get: {
              parameters: [null, referenced ? ref : bad],
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          parameters: { Alias: { $ref: "#/components/parameters/Override" }, Override: bad },
        },
      } as unknown as OpenAPIDocument;
      const failures = createValidator(doc).precompile({ onMalformed: "collect" });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        pointer: referenced
          ? "/components/parameters/Override/schema"
          : "/paths/~1t/get/parameters/1/schema",
        anchor: referenced ? "definition" : "node",
      });
    },
  );
});
