import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";

describe("compileSchema with external schemas", () => {
  it("resolves an absolute $ref to a pre-registered external schema", () => {
    const external = new Map([
      ["https://example.com/Name", { type: "string", minLength: 1 } as unknown as SchemaOrBoolean],
    ]);
    const v = compile(
      {
        type: "object",
        properties: { name: { $ref: "https://example.com/Name" } },
        required: ["name"],
      },
      { external },
    );
    expect(v.validate({ name: "ok" }).valid).toBe(true);
    expect(v.validate({ name: "" }).valid).toBe(false);
  });

  it("resolves a chain where one external refers to another", () => {
    const external = new Map<string, unknown>([
      ["https://example.com/Tag", { type: "string", minLength: 1 } as Record<string, unknown>],
      [
        "https://example.com/Pet",
        {
          type: "object",
          properties: { tag: { $ref: "https://example.com/Tag" } },
          required: ["tag"],
        } as Record<string, unknown>,
      ],
    ]);
    const v = compile(
      { $ref: "https://example.com/Pet" },
      { external: external as Map<string, never> },
    );
    expect(v.validate({ tag: "fido" }).valid).toBe(true);
    expect(v.validate({ tag: "" }).valid).toBe(false);
    expect(v.validate({}).valid).toBe(false);
  });

  it("resolves #anchor fragments against a registered external schema", () => {
    const external = new Map<string, unknown>([
      [
        "https://example.com/defs",
        {
          $defs: {
            Tag: { $anchor: "Tag", type: "string", minLength: 1 },
          },
        } as Record<string, unknown>,
      ],
    ]);
    const v = compile(
      { $ref: "https://example.com/defs#Tag" },
      { external: external as Map<string, never> },
    );
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate("").valid).toBe(false);
    expect(v.validate(1).valid).toBe(false);
  });

  it("scopes $anchor by enclosing $id: same anchor name in different scopes", () => {
    // Two subschemas both declare `$anchor: "x"` under different $ids; refs
    // must resolve to the scope-local anchor, not the last one written.
    const schema = {
      $id: "https://example.com/root",
      $defs: {
        A: {
          $id: "https://example.com/A",
          $defs: { Sub: { $anchor: "x", type: "string", minLength: 1 } },
          $ref: "https://example.com/A#x",
        },
        B: {
          $id: "https://example.com/B",
          $defs: { Sub: { $anchor: "x", type: "integer", minimum: 10 } },
          $ref: "https://example.com/B#x",
        },
      },
      oneOf: [{ $ref: "https://example.com/A" }, { $ref: "https://example.com/B" }],
    };
    const v = compile(schema as Record<string, unknown>);
    expect(v.validate("hi").valid).toBe(true);
    expect(v.validate(42).valid).toBe(true);
    expect(v.validate(1).valid).toBe(false);
    expect(v.validate("").valid).toBe(false);
  });
});
