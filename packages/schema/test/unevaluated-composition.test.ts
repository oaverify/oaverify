/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { ValidationError } from "@oaverify/internal-core";
import { compile } from "./helpers.js";

function leafCodes(err: ValidationError | undefined): string[] {
  if (err === undefined) return [];
  if (err.children === undefined || err.children.length === 0) return [err.code];
  return err.children.flatMap((c) => leafCodes(c));
}

describe("unevaluatedProperties across composition", () => {
  it("counts properties from an allOf branch as evaluated", () => {
    const v = compile({
      type: "object",
      allOf: [{ properties: { foo: { type: "string" } } }],
      unevaluatedProperties: false,
    });
    expect(v.validate({ foo: "ok" }).valid).toBe(true);
    const r = v.validate({ foo: "ok", bar: 1 });
    expect(r.valid).toBe(false);
    expect(leafCodes(r.error)).toContain("unevaluatedProperties");
  });

  it("counts properties from a passing anyOf branch as evaluated", () => {
    const v = compile({
      type: "object",
      anyOf: [
        { properties: { foo: { type: "string" } }, required: ["foo"] },
        { properties: { baz: { type: "integer" } }, required: ["baz"] },
      ],
      unevaluatedProperties: false,
    });
    expect(v.validate({ foo: "ok" }).valid).toBe(true);
    expect(v.validate({ baz: 1 }).valid).toBe(true);
    expect(v.validate({ foo: "ok", bar: 1 }).valid).toBe(false);
  });

  it("counts properties from the winning oneOf branch as evaluated", () => {
    const v = compile({
      type: "object",
      oneOf: [
        { properties: { foo: { type: "string" } }, required: ["foo"] },
        { properties: { baz: { type: "integer" } }, required: ["baz"] },
      ],
      unevaluatedProperties: false,
    });
    expect(v.validate({ foo: "ok" }).valid).toBe(true);
    expect(v.validate({ foo: "ok", bar: 1 }).valid).toBe(false);
  });

  it("counts properties declared behind a $ref as evaluated", () => {
    const v = compile({
      $defs: {
        Named: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      type: "object",
      $ref: "#/$defs/Named",
      unevaluatedProperties: false,
    });
    expect(v.validate({ name: "ok" }).valid).toBe(true);
    expect(v.validate({ name: "ok", extra: true }).valid).toBe(false);
  });

  it("propagates across two-deep nested allOf", () => {
    const v = compile({
      type: "object",
      allOf: [
        {
          allOf: [{ properties: { foo: { type: "string" } } }],
        },
      ],
      unevaluatedProperties: false,
    });
    expect(v.validate({ foo: "ok" }).valid).toBe(true);
    expect(v.validate({ foo: "ok", bar: 1 }).valid).toBe(false);
  });

  it("counts items from an allOf branch as evaluated", () => {
    const v = compile({
      type: "array",
      allOf: [{ prefixItems: [{ type: "string" }, { type: "integer" }] }],
      unevaluatedItems: false,
    });
    expect(v.validate(["a", 1]).valid).toBe(true);
    expect(v.validate(["a", 1, true]).valid).toBe(false);
  });

  it("counts every key as evaluated when a nested branch has unevaluatedProperties: true", () => {
    const v = compile({
      type: "object",
      properties: { foo: { type: "string" } },
      allOf: [{ unevaluatedProperties: true }],
      unevaluatedProperties: { type: "string", maxLength: 2 },
    });
    // Outer `unevaluatedProperties: {…}` would normally constrain
    // `bar` to maxLength 2, but the inner `unevaluatedProperties: true`
    // evaluates every key first, so the outer sees nothing unevaluated.
    expect(v.validate({ foo: "foo", bar: "bar" }).valid).toBe(true);
  });

  it("counts every index as evaluated when a nested branch has unevaluatedItems: true", () => {
    const v = compile({
      type: "array",
      allOf: [{ prefixItems: [{ type: "string" }] }, { unevaluatedItems: true }],
      unevaluatedItems: false,
    });
    expect(v.validate(["foo", 42, true]).valid).toBe(true);
  });

  it("preserves if annotations in the outer evaluated set when if passes", () => {
    const v = compile({
      type: "object",
      if: {
        properties: { foo: { const: "then" } },
        required: ["foo"],
      },
      then: {
        properties: { bar: { type: "string" } },
        required: ["bar"],
      },
      else: {
        properties: { baz: { type: "string" } },
        required: ["baz"],
      },
      unevaluatedProperties: false,
    });
    // `foo` is evaluated by `if`; `bar` by `then`. Both must be seen by
    // the outer `unevaluatedProperties: false`.
    expect(v.validate({ foo: "then", bar: "bar" }).valid).toBe(true);
    const r = v.validate({ foo: "then", bar: "bar", extra: "no" });
    expect(r.valid).toBe(false);
    expect(leafCodes(r.error)).toContain("unevaluatedProperties");
  });

  it("preserves if annotations when if has no sibling then/else", () => {
    const v = compile({
      type: "object",
      if: {
        patternProperties: { foo: { type: "string" } },
      },
      unevaluatedProperties: false,
    });
    expect(v.validate({ foo: "a" }).valid).toBe(true);
    expect(v.validate({ bar: "a" }).valid).toBe(false);
  });

  it("threads contains annotations through if into unevaluatedItems", () => {
    const v = compile({
      type: "array",
      if: { contains: { const: "a" } },
      then: {
        if: { contains: { const: "b" } },
        then: { if: { contains: { const: "c" } } },
      },
      unevaluatedItems: false,
    });
    expect(v.validate([]).valid).toBe(true);
    expect(v.validate(["a", "a"]).valid).toBe(true);
    expect(v.validate(["a", "b", "a"]).valid).toBe(true);
    expect(v.validate(["c", "a", "b", "c"]).valid).toBe(true);
    // Missing `a`: the outer `if` fails, no annotations flow in, so
    // every item becomes unevaluated.
    expect(v.validate(["b", "b"]).valid).toBe(false);
  });
});
