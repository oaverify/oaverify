import type { ReferenceObject } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { resolveOperationRef } from "../src/operation-cache.js";

/**
 * Direct tests for the operation-level `$ref` resolver that
 * createValidator uses for requestBody / response / parameter / header
 * references. Previously this was a closure inside createValidator and
 * only reachable through full-spec integration tests.
 */

describe("resolveOperationRef", () => {
  const spec = {
    components: {
      parameters: {
        Tenant: { name: "X-Tenant", in: "header", required: true },
        WhoA: { $ref: "#/components/parameters/WhoB" },
        WhoB: { $ref: "#/components/parameters/WhoA" },
      },
      responses: {
        Ok: { description: "ok" },
      },
    },
  };

  it("returns the input unchanged when it isn't a $ref", () => {
    const plain = { name: "Id" };
    expect(resolveOperationRef(spec, plain)).toBe(plain);
  });

  it("returns undefined for undefined input", () => {
    expect(resolveOperationRef<object>(spec, undefined)).toBeUndefined();
  });

  it("resolves a single-hop internal $ref", () => {
    const result = resolveOperationRef<object>(spec, {
      $ref: "#/components/parameters/Tenant",
    });
    expect(result).toEqual({ name: "X-Tenant", in: "header", required: true });
  });

  it("drops siblings on the reference itself (OAS semantics)", () => {
    const value = {
      $ref: "#/components/parameters/Tenant",
      description: "IGNORED per OAS",
    } as ReferenceObject & { description: string };
    const result = resolveOperationRef<object>(spec, value);
    expect(result).not.toHaveProperty("description");
  });

  it("throws on external refs (not yet inlined)", () => {
    expect(() =>
      resolveOperationRef(spec, {
        $ref: "./other.yaml#/components/parameters/Tenant",
      } as ReferenceObject),
    ).toThrow(/external ref/);
  });

  it("guards against cycles with a hop limit", () => {
    expect(() =>
      resolveOperationRef(spec, {
        $ref: "#/components/parameters/WhoA",
      } as ReferenceObject),
    ).toThrow(/cycle|32 hops/);
  });
});
