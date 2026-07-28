/**
 * User-registered keywords: compile-time registration, runtime dispatch
 * through the `deps.customKeywords` map, codegen shape parity (budget
 * gating when `maxErrors` is finite), and clear errors on conflicts.
 */

import { describe, expect, it } from "vitest";
import {
  applicatorVocabulary,
  compileSchema,
  coreVocabulary,
  validationVocabulary,
} from "../src/index.js";
import type { CustomKeywordValidator, Dialect } from "../src/index.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { failure } from "./helpers.js";

const baseDialect: Dialect = {
  id: "test-base",
  vocabularies: [coreVocabulary, validationVocabulary, applicatorVocabulary],
  rules: { refSuppressesSiblings: false },
};

describe("custom keywords", () => {
  it("registers a simple boolean validator", () => {
    const divisibleBy: CustomKeywordValidator = (data, schemaValue) =>
      typeof data !== "number" || data % (schemaValue as number) === 0;
    const compiled = compileSchema(
      { type: "integer", divisibleBy: 7 } as unknown as SchemaOrBoolean,
      {
        dialect: baseDialect,
        output: "tree",
        maxErrors: Number.POSITIVE_INFINITY,
        keywords: { divisibleBy },
      },
    );
    expect(compiled.validate(14).valid).toBe(true);
    expect(compiled.validate(21).valid).toBe(true);
    const bad = compiled.validate(10);
    expect(bad.valid).toBe(false);
    expect(failure(bad).error?.code).toBe("divisibleBy");
    expect(failure(bad).error?.message).toContain("divisibleBy");
  });

  it("passes data, schemaValue, and path to the validator", () => {
    const received: {
      data: unknown;
      schemaValue: unknown;
      path: readonly (string | number)[];
    }[] = [];
    const recorder: CustomKeywordValidator = (data, schemaValue, path) => {
      received.push({ data, schemaValue, path: [...path] });
      return true;
    };
    const compiled = compileSchema(
      {
        type: "object",
        properties: {
          a: { type: "string", myKw: { check: "a" } },
          b: { type: "string", myKw: { check: "b" } },
        },
      } as unknown as SchemaOrBoolean,
      {
        dialect: baseDialect,
        output: "tree",
        maxErrors: Number.POSITIVE_INFINITY,
        keywords: { myKw: recorder },
      },
    );
    compiled.validate({ a: "x", b: "y" });
    expect(received).toHaveLength(2);
    expect(received[0]?.schemaValue).toEqual({ check: "a" });
    expect(received[0]?.path).toEqual(["a"]);
    expect(received[1]?.path).toEqual(["b"]);
  });

  it("honors custom message and params on failure objects", () => {
    const fn: CustomKeywordValidator = (data) => {
      if (typeof data !== "string") return true;
      if (data.includes(" ")) {
        return { message: "no spaces allowed", params: { reason: "whitespace" } };
      }
      return true;
    };
    const compiled = compileSchema(
      { type: "string", noSpaces: true } as unknown as SchemaOrBoolean,
      {
        dialect: baseDialect,
        output: "tree",
        maxErrors: Number.POSITIVE_INFINITY,
        keywords: { noSpaces: fn },
      },
    );
    expect(compiled.validate("ok").valid).toBe(true);
    const bad = compiled.validate("has spaces");
    expect(bad.valid).toBe(false);
    expect(failure(bad).error?.message).toBe("no spaces allowed");
    expect(failure(bad).error?.params).toEqual({ reason: "whitespace" });
  });

  it("throws on a custom keyword that conflicts with a built-in", () => {
    expect(() =>
      compileSchema(
        { type: "string" },
        {
          dialect: baseDialect,
          keywords: { type: (() => true) as CustomKeywordValidator },
        },
      ),
    ).toThrow(/conflicts with a built-in keyword/);
  });

  it("counts custom-keyword failures against the maxErrors budget", () => {
    const always: CustomKeywordValidator = () => false;
    const compiled = compileSchema(
      {
        type: "array",
        items: { type: "string", alwaysBad: true },
      } as unknown as SchemaOrBoolean,
      { dialect: baseDialect, output: "tree", keywords: { alwaysBad: always }, maxErrors: 2 },
    );
    const res = compiled.validate(["a", "b", "c", "d", "e"]);
    expect(res.valid).toBe(false);
    expect(failure(res).truncated).toBe(true);
    // Exactly two leaves collected before the cap kicked in.
    const leaves: number = (function count(e): number {
      if (!e) return 0;
      if (e.children.length === 0) return 1;
      return e.children.reduce((acc: number, c) => acc + count(c), 0);
    })(failure(res).error);
    expect(leaves).toBe(2);
  });

  it("is optional: omitting keywords has zero impact", () => {
    const compiled = compileSchema({ type: "number" }, { dialect: baseDialect });
    expect(compiled.validate(1).valid).toBe(true);
    expect(compiled.validate("x").valid).toBe(false);
  });
});
