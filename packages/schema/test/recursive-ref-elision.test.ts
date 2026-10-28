import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";

const wrappers = {
  $ref: "#/$defs/Node",
  $defs: {
    Node: { $ref: "#/$defs/Inner" },
    Inner: {
      oneOf: [{ type: "null" }, { type: "object", properties: { next: { $ref: "#/$defs/Node" } } }],
    },
  },
};

const union = {
  $ref: "#/$defs/Node",
  $defs: {
    Node: { oneOf: [{ $ref: "#/$defs/Leaf" }, { $ref: "#/$defs/Pair" }] },
    Leaf: { type: "string" },
    Pair: {
      type: "object",
      properties: { l: { $ref: "#/$defs/Node" }, r: { $ref: "#/$defs/Node" } },
    },
  },
};

describe("recursive pure-ref elision", () => {
  for (const output of ["predicate", "flat", "tree"] as const) {
    for (const maxErrors of output === "predicate"
      ? [Number.POSITIVE_INFINITY]
      : [1, Number.POSITIVE_INFINITY]) {
      it(`validates wrapper chains in ${output} with budget ${maxErrors}`, () => {
        const validator = compile(wrappers, { output, maxErrors });
        for (const [value, valid] of [
          [null, true],
          [{ next: { next: null } }, true],
          [{ next: 3 }, false],
        ] as const) {
          const result = validator.validate(value);
          expect(typeof result === "boolean" ? result : result.valid).toBe(valid);
        }
      });

      it(`validates a union of refs in ${output} with budget ${maxErrors}`, () => {
        const validator = compile(union, { output, maxErrors });
        for (const [value, valid] of [
          ["leaf", true],
          [{ l: "a", r: { l: "b", r: "c" } }, true],
          [{ l: "a", r: 3 }, false],
        ] as const) {
          const result = validator.validate(value);
          expect(typeof result === "boolean" ? result : result.valid).toBe(valid);
        }
      });
    }
  }
});
