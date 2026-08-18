import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { normalizeOas30 } from "../src/openapi/normalize.js";

/**
 * The 3.0 -> 2020-12 rewrite has to reach inside a mixed map the same
 * way it reaches inside `dependentSchemas`; an un-normalized `nullable`
 * below one is a wrong verdict, not a cosmetic gap (#859).
 */
const at = (out: SchemaOrBoolean, keyword: string): Record<string, unknown> => {
  const map = (out as Record<string, unknown>)[keyword] as Record<string, unknown>;
  return map.x as Record<string, unknown>;
};

describe("OAS 3.0 normalization under mixed-map positions (#859)", () => {
  it.each(["dependentSchemas", "dependencies"])("folds nullable under %s", (keyword) => {
    const out = normalizeOas30({
      type: "object",
      [keyword]: { x: { type: "string", nullable: true } },
    } as SchemaOrBoolean);

    expect(at(out, keyword).type).toEqual(["string", "null"]);
  });

  it.each(["dependentSchemas", "dependencies"])(
    "folds a boolean exclusive bound under %s",
    (keyword) => {
      const out = normalizeOas30({
        type: "object",
        [keyword]: { x: { type: "number", maximum: 10, exclusiveMaximum: true } },
      } as SchemaOrBoolean);

      expect(at(out, keyword).exclusiveMaximum).toBe(10);
      expect(at(out, keyword).maximum).toBeUndefined();
    },
  );

  it("leaves a dependencies array entry as a property-name list", () => {
    const out = normalizeOas30({
      type: "object",
      dependencies: { x: ["y"] },
    } as SchemaOrBoolean) as Record<string, unknown>;

    expect((out.dependencies as Record<string, unknown>).x).toEqual(["y"]);
  });
});
