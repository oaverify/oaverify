import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { computeDiscriminatorRoutes } from "../src/keywords/discriminator-routes.js";
import { keywordDefinitions } from "../src/introspection.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

const compile = (schema: unknown) =>
  compileSchema(schema as SchemaOrBoolean, { dialect: openapi31Dialect, schemaLint: "warn" });

const Cat = {
  type: "object",
  required: ["type", "lives"],
  properties: { type: { const: "cat" }, lives: { type: "integer" } },
};
const Dog = {
  type: "object",
  required: ["type"],
  properties: { type: { const: "dog" } },
};

describe("discriminator routing", () => {
  describe("the ordering declineImplements depends on", () => {
    // `declineImplements` only works if `discriminator` compiles before
    // the `oneOf` / `anyOf` it implements. The compile loop skips a
    // keyword already marked seen, so if the composition sorted first it
    // would compile, and then the discriminator would emit routing on
    // top of it: both would validate. That failure is silent, so the
    // dependency is asserted rather than commented.
    it("puts discriminator before oneOf and anyOf in every dialect", () => {
      for (const dialect of [oas30Dialect, openapi31Dialect, jsonSchemaDialect]) {
        const order = [...keywordDefinitions(dialect).keys()];
        const discriminator = order.indexOf("discriminator");
        expect(discriminator).toBeGreaterThanOrEqual(0);
        expect(discriminator).toBeLessThan(order.indexOf("oneOf"));
        expect(discriminator).toBeLessThan(order.indexOf("anyOf"));
      }
    });

    it("does not run the composition as well when the discriminator routes", () => {
      // Both branches accept this payload. Routing alone accepts it;
      // the composition running too would fail `oneOf`'s exactly-one.
      const compiled = compile({
        $defs: { A: { type: "object" }, B: { type: "object" } },
        oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        discriminator: { propertyName: "t", mapping: { a: "#/$defs/A", b: "#/$defs/B" } },
      });
      expect(compiled.validate({ t: "a" }).valid).toBe(true);
    });
  });

  describe("computeDiscriminatorRoutes", () => {
    it("routes by branch $ref last segment, implicitly", () => {
      const { routes, usable } = computeDiscriminatorRoutes({ propertyName: "type" }, [
        { $ref: "#/components/schemas/Cat" },
        { $ref: "#/components/schemas/Dog" },
      ]);
      expect(usable).toBe(true);
      expect([...routes.entries()]).toEqual([
        ["Cat", 0],
        ["Dog", 1],
      ]);
    });

    it("routes an explicit mapping by whole $ref and by last segment", () => {
      const branches = [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }];
      const whole = computeDiscriminatorRoutes(
        { propertyName: "type", mapping: { cat: "#/components/schemas/Cat" } },
        branches,
      );
      expect(whole.routes.get("cat")).toBe(0);
      expect(whole.usable).toBe(true);

      const segment = computeDiscriminatorRoutes(
        { propertyName: "type", mapping: { dog: "elsewhere/Dog.yaml#/components/schemas/Dog" } },
        branches,
      );
      expect(segment.routes.get("dog")).toBe(1);
      expect(segment.usable).toBe(true);
    });

    it("is unusable when no branch carries a $ref", () => {
      // What a pre-bundled spec looks like: branches absorbed inline, so
      // there is nothing for a mapping value to match against.
      const { usable, routes } = computeDiscriminatorRoutes(
        { propertyName: "type", mapping: { cat: "models/cat.yml" } },
        [Cat, Dog],
      );
      expect(usable).toBe(false);
      expect(routes.size).toBe(0);
    });

    it("is unusable when only part of the mapping resolves", () => {
      // Routing the values that resolve and rejecting the rest would
      // reject payloads the author documented as valid.
      const { usable, deadMappingKeys } = computeDiscriminatorRoutes(
        {
          propertyName: "type",
          mapping: { cat: "#/components/schemas/Cat", dog: "models/gone.yml" },
        },
        [{ $ref: "#/components/schemas/Cat" }],
      );
      expect(usable).toBe(false);
      expect(deadMappingKeys).toEqual(["dog"]);
    });
  });

  describe("an unroutable discriminator falls back to the composition", () => {
    const unroutable = {
      anyOf: [Cat, Dog],
      discriminator: {
        propertyName: "type",
        mapping: { cat: "models/cat.yml", dog: "models/dog.yml" },
      },
    };

    it("accepts a payload the composition accepts", () => {
      // Previously rejected outright: the discriminator suppressed the
      // composition and then matched nothing, so nothing could validate.
      const compiled = compile(unroutable);
      expect(compiled.validate({ type: "cat", lives: 9 }).valid).toBe(true);
      expect(compiled.validate({ type: "dog" }).valid).toBe(true);
    });

    it("still rejects a payload the composition rejects", () => {
      const compiled = compile(unroutable);
      expect(compiled.validate({ type: "cat" }).valid).toBe(false); // lives missing
      expect(compiled.validate({ type: "fish" }).valid).toBe(false);
    });

    it("reports the dead mapping rather than ignoring it silently", () => {
      const issues = compile(unroutable).stats.schemaLintIssues.filter(
        (i) => i.code === "silent-rewrite/discriminator-unroutable",
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('"cat"');
      expect(issues[0]?.message).toContain('"dog"');
      expect(issues[0]?.message).toContain("validates every branch");
    });

    it("reports the no-$ref case with its own reason", () => {
      const issues = compile({
        anyOf: [Cat, Dog],
        discriminator: { propertyName: "type" },
      }).stats.schemaLintIssues.filter((i) => i.code === "silent-rewrite/discriminator-unroutable");
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain("no branch carries a $ref");
    });

    it("holds in predicate mode too", () => {
      const compiled = compileSchema(unroutable as SchemaOrBoolean, {
        dialect: openapi31Dialect,
        output: "predicate",
      });
      expect(compiled.validate({ type: "cat", lives: 9 })).toBe(true);
      expect(compiled.validate({ type: "cat" })).toBe(false);
    });

    it("keeps oneOf's exactly-one semantics when it falls back", () => {
      // The fallback is the composition as written, not a relaxation of
      // it: two matching branches under `oneOf` must still fail.
      const compiled = compile({
        oneOf: [{ type: "object" }, { type: "object" }],
        discriminator: { propertyName: "type", mapping: { a: "models/gone.yml" } },
      });
      expect(compiled.validate({ type: "a" }).valid).toBe(false);
    });
  });

  describe.each([oas30Dialect, openapi31Dialect, jsonSchemaDialect])(
    "non-object composition under $name",
    (dialect) => {
      for (const keyword of ["oneOf", "anyOf"] as const) {
        for (const output of ["flat", "tree", "predicate"] as const) {
          for (const maxErrors of output === "predicate" ? [Infinity] : [1, 2, Infinity]) {
            it(`${keyword}, ${output}, budget ${maxErrors}: preserves composition results`, () => {
              const schemas: SchemaObject[] = [
                {
                  $defs: { Cat, Dog },
                  [keyword]: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
                },
                {
                  $defs: { A: { type: "number" }, B: { type: "integer" } },
                  [keyword]: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
                },
                {
                  $defs: { A: { enum: [null, true, "yes", [1]] } },
                  [keyword]: [{ $ref: "#/$defs/A" }, { type: "number" }],
                },
              ];
              for (const schema of schemas) {
                const options = { dialect, output, maxErrors };
                const plain = compileSchema(schema, options);
                const routed = compileSchema(
                  { ...schema, discriminator: { propertyName: "type" } },
                  options,
                );
                for (const value of [42, 1.5, "yes", "no", null, true, false, [], [1], [2]]) {
                  expect(routed.validate(value)).toEqual(plain.validate(value));
                }
              }
            });
          }
        }
      }
    },
  );

  it.each(["flat", "tree", "predicate"] as const)(
    "preserves array annotations and nested paths in %s mode",
    (output) => {
      for (const keyword of ["oneOf", "anyOf"] as const) {
        const valueSchema: SchemaObject = {
          [keyword]: [{ $ref: "#/$defs/A" }, { type: "string" }],
          unevaluatedItems: false,
        };
        const schema: SchemaObject = {
          $defs: { A: { type: "array", prefixItems: [{ type: "number" }] } },
          properties: { value: valueSchema },
        };
        const options = { dialect: openapi31Dialect, output };
        const plain = compileSchema(schema, options);
        const routed = compileSchema(
          {
            ...schema,
            properties: {
              value: { ...valueSchema, discriminator: { propertyName: "type" } },
            },
          },
          options,
        );
        for (const value of [[1], [1, 2], ["bad"], "ok", 42]) {
          expect(routed.validate({ value })).toEqual(plain.validate({ value }));
        }
      }
    },
  );

  it("applies both compositions to non-objects when both are present", () => {
    const schema: SchemaOrBoolean = {
      $defs: { A: { type: "number" } },
      oneOf: [{ $ref: "#/$defs/A" }],
      anyOf: [{ minimum: 5 }],
      discriminator: { propertyName: "type" },
    };
    const compiled = compile(schema);
    expect(compiled.validate(3).valid).toBe(false);
    expect(compiled.validate(6).valid).toBe(true);
  });

  describe("a routable discriminator is unchanged", () => {
    const routable = {
      $defs: { Cat, Dog },
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
      discriminator: {
        propertyName: "type",
        mapping: { cat: "#/$defs/Cat", dog: "#/$defs/Dog" },
      },
    };

    it("routes to a single branch and reports that branch's error", () => {
      const compiled = compile(routable);
      expect(compiled.validate({ type: "cat", lives: 9 }).valid).toBe(true);

      const result = compiled.validate({ type: "cat" });
      expect(result.valid).toBe(false);
      // The point of the discriminator: one branch's error, not "none of
      // N schemas matched".
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0]?.message).toContain("lives");
    });

    it("still rejects a value that matches no branch", () => {
      // Spec-sanctioned: a value outside the mapping selects no schema,
      // and validation is expected to fail. Only an *author's* dead
      // mapping triggers the fallback.
      const result = compile(routable).validate({ type: "fish" });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors[0]?.code).toBe("discriminator");
    });

    it("produces no lint finding", () => {
      expect(
        compile(routable).stats.schemaLintIssues.filter((i) =>
          i.code.startsWith("silent-rewrite/discriminator"),
        ),
      ).toEqual([]);
    });
  });
});
