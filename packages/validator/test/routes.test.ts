import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * `Validator.routes` is startup-time introspection over the same route
 * table the validator matches against: every declared `{ method,
 * pathPattern }` pair, frozen at `createValidator` time. Consumers use
 * it to mount per-route middleware, build coverage reports, or assert
 * two specs are route-disjoint before `combineValidators` stacks them.
 */

function spec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "routes", version: "1" },
    paths: {
      "/pets": {
        get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
        post: { operationId: "createPet", responses: { "201": { description: "ok" } } },
      },
      "/pets/{id}": {
        get: { operationId: "getPet", responses: { "200": { description: "ok" } } },
      },
    },
  };
}

describe("Validator.routes", () => {
  it("lists every declared (method, pathPattern) pair, uppercased", () => {
    const v = createValidator(spec());
    expect(
      [...v.routes].sort((a, b) =>
        (a.method + a.pathPattern).localeCompare(b.method + b.pathPattern),
      ),
    ).toEqual([
      { method: "GET", pathPattern: "/pets" },
      { method: "GET", pathPattern: "/pets/{id}" },
      { method: "POST", pathPattern: "/pets" },
    ]);
  });

  it("does not list the implicit HEAD that a GET resource answers", () => {
    const v = createValidator(spec());
    expect(v.routes.some((r) => r.method === "HEAD")).toBe(false);
  });

  it("is empty for a spec with no paths", () => {
    const v = createValidator({ openapi: "3.1.0", info: { title: "empty", version: "1" } });
    expect(v.routes).toEqual([]);
  });

  it("is frozen", () => {
    const v = createValidator(spec());
    expect(Object.isFrozen(v.routes)).toBe(true);
  });
});
