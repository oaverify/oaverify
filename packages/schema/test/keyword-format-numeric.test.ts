import { builtInFormats, validateInt32, validateInt64 } from "@oaverify/internal-formats";
import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";
import type { BuiltInErrorParams, SchemaOrBoolean } from "@oaverify/internal-core";

// Type-level pin: a number-typed format's assertion failure carries a
// numeric `actual`, so the declared params contract must admit it.
const numericActual: BuiltInErrorParams["format"] = { format: "int32", actual: 3000000000 };
void numericActual;

const oas = (
  schema: Record<string, unknown>,
  formats: Record<string, unknown> = builtInFormats,
): ReturnType<typeof compileSchema> =>
  compileSchema(schema as SchemaOrBoolean, {
    dialect: oas30Dialect,
    formats: formats as never,
    output: "flat",
    maxErrors: Number.POSITIVE_INFINITY,
  });

const ok = (v: ReturnType<typeof compileSchema>, data: unknown): boolean =>
  (v.validate as (d: unknown) => { valid: boolean })(data).valid;

const errorsOf = (
  v: ReturnType<typeof compileSchema>,
  data: unknown,
): { code: string; params?: unknown }[] =>
  (v.validate as (d: unknown) => { errors?: { code: string; params?: unknown }[] })(data).errors ??
  [];

describe("int32 / int64 assert under the OpenAPI dialects", () => {
  it("rejects the value that motivated the issue", () => {
    // The §2.1 asymmetry: `format: int32` and `format: date-time` sat in
    // one schema under one dialect, and only one of them bound.
    const v = oas({ type: "integer", format: "int32" });
    expect(ok(v, 1)).toBe(true);
    expect(ok(v, 3000000000)).toBe(false);
  });

  it("reports the format code and names the format", () => {
    const v = oas({ type: "integer", format: "int32" });
    const errors = errorsOf(v, 3000000000);
    expect(errors[0]?.code).toBe("format");
    expect(errors[0]?.params).toMatchObject({ format: "int32", actual: 3000000000 });
  });

  it("asserts int64 over the safe-integer range and rejects above it", () => {
    const v = oas({ type: "integer", format: "int64" });
    expect(ok(v, 3000000000)).toBe(true);
    expect(ok(v, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(ok(v, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("rejects a non-integer number", () => {
    expect(ok(oas({ format: "int32" }), 1.5)).toBe(false);
    expect(ok(oas({ format: "int64" }), 1.5)).toBe(false);
  });

  it("is a no-op on a value of another JSON type", () => {
    // A format constrains one type; anything else skips it, per JSON
    // Schema 2020-12 §6.3. Same rule that makes `date-time` inert on a
    // number.
    const v = oas({ format: "int32" });
    expect(ok(v, "3000000000")).toBe(true);
    expect(ok(v, null)).toBe(true);
    expect(ok(v, { a: 1 })).toBe(true);
    expect(ok(v, [1, 2])).toBe(true);
  });

  it("asserts under openapi31 as well as oas30", () => {
    const v = compileSchema({ format: "int32" } as SchemaOrBoolean, {
      dialect: openapi31Dialect,
      formats: builtInFormats as never,
      output: "flat",
    });
    expect((v.validate as (d: unknown) => { valid: boolean })(3000000000).valid).toBe(false);
  });

  it("is inert under the plain JSON Schema dialect", () => {
    // format-annotation mode emits no check at all, whatever is
    // registered.
    const v = compileSchema({ format: "int32" } as SchemaOrBoolean, {
      dialect: jsonSchemaDialect,
      formats: builtInFormats as never,
      output: "flat",
    });
    expect((v.validate as (d: unknown) => { valid: boolean })(3000000000).valid).toBe(true);
  });

  it("is inert for a direct compileSchema caller who registers nothing", () => {
    // The mirror of string formats: `compileSchema` asserts what the
    // caller registered, and registers nothing on its own. Surprising
    // enough to pin, so that changing it is a decision.
    const v = compileSchema({ format: "int32" } as SchemaOrBoolean, {
      dialect: oas30Dialect,
      output: "flat",
    });
    expect((v.validate as (d: unknown) => { valid: boolean })(3000000000).valid).toBe(true);
  });

  it("asserts inside an items loop, where the guard is inlined", () => {
    const v = oas({ type: "array", items: { type: "integer", format: "int32" } });
    expect(ok(v, [1, 2, 3])).toBe(true);
    expect(ok(v, [1, 3000000000])).toBe(false);
  });
});

describe("the per-format escape hatch", () => {
  it("`false` keeps the name and asserts nothing", () => {
    const v = oas({ format: "int64" }, { ...builtInFormats, int64: false });
    expect(ok(v, Number.MAX_SAFE_INTEGER + 1)).toBe(true);
  });

  it("`false` turns off one format and leaves its sibling asserting", () => {
    const formats = { ...builtInFormats, int64: false };
    expect(ok(oas({ format: "int64" }, formats), 1.5)).toBe(true);
    expect(ok(oas({ format: "int32" }, formats), 1.5)).toBe(false);
  });

  it("`false` works the same way on a string format", () => {
    // The property the escape hatch is for: one spelling, whatever the
    // format constrains.
    const v = oas({ format: "date-time" }, { ...builtInFormats, "date-time": false });
    expect(ok(v, "not-a-date")).toBe(true);
  });

  it("a replacement predicate wins over the built-in", () => {
    const v = oas(
      { format: "int32" },
      { ...builtInFormats, int32: { type: "number", validate: (n: number) => n === 7 } },
    );
    expect(ok(v, 7)).toBe(true);
    expect(ok(v, 8)).toBe(false);
  });

  it("a bare function is a string format even under a numeric built-in's name", () => {
    // No name-based type inference. The caller wrote a bare function,
    // so it constrains strings, and the numeric assertion is gone.
    const v = oas({ format: "int32" }, { ...builtInFormats, int32: (s: string) => s === "yes" });
    expect(ok(v, 3000000000)).toBe(true);
    expect(ok(v, "yes")).toBe(true);
    expect(ok(v, "no")).toBe(false);
  });

  it("`true` is refused, and the error names the format", () => {
    // `true` is the plausible wrong guess for "leave this one alone",
    // and it is the one spelling that would otherwise disable the
    // format silently. The key is in the message because that is what
    // the caller has to go and edit.
    expect(() => oas({ format: "int32" }, { ...builtInFormats, int32: true as never })).toThrow(
      /formats\["int32"\].*must be a function.*use false/s,
    );
  });
});

describe("unknownFormats sees one registry", () => {
  const strict = (schema: Record<string, unknown>, formats: Record<string, unknown>): unknown =>
    compileSchema(schema as SchemaOrBoolean, {
      dialect: oas30Dialect,
      formats: formats as never,
      unknownFormats: "error",
    });

  it("does not fire on a numeric format, which is registered", () => {
    expect(() => strict({ format: "int32" }, builtInFormats)).not.toThrow();
  });

  it("still fires on a vendor name", () => {
    expect(() => strict({ format: "twiml" }, builtInFormats)).toThrow(/"twiml"/);
  });

  it("does not fire on a format registered as `false`", () => {
    // Registered and asserting nothing is a decision someone made,
    // which is the question this option asks.
    expect(() => strict({ format: "int64" }, { ...builtInFormats, int64: false })).not.toThrow();
  });
});

describe("generated source", () => {
  const sourceOf = (schema: Record<string, unknown>, formats: Record<string, unknown>): string =>
    compileSchema(schema as SchemaOrBoolean, {
      dialect: oas30Dialect,
      formats: formats as never,
      retainSource: true,
    }).source;

  it("emits a string guard for a string format", () => {
    const src = sourceOf({ format: "date-time" }, builtInFormats);
    expect(src).toContain(`typeof data === "string"`);
    expect(src).not.toContain(`typeof data === "number"`);
  });

  it("emits a number guard, and only that, for a numeric format", () => {
    // The site costs one `typeof` either way. Numeric formats do not
    // pay for a string branch they can never take.
    const src = sourceOf({ format: "int32" }, builtInFormats);
    expect(src).toContain(`typeof data === "number"`);
    expect(src).not.toContain(`typeof data === "string"`);
  });

  it("emits no guard at all for a format registered as `false`", () => {
    const src = sourceOf({ format: "int64" }, { ...builtInFormats, int64: false });
    expect(src).not.toContain("must match format int64");
  });

  it("emits the string guard for a name registered nowhere", () => {
    // Load-bearing: `emitStandalone` compiles against a registry it
    // does not run against, so a name absent at compile time may be
    // present at run time and must still be looked up.
    const src = sourceOf({ format: "twiml" }, {});
    expect(src).toContain(`typeof data === "string"`);
    expect(src).toContain(`deps.formats.get("twiml")?.validate`);
  });

  it("costs a string format the same guard it always did, plus `?.validate`", () => {
    // The whole delta for a schema naming only string formats: one
    // property access in the module prelude, hoisted, evaluated once
    // when the factory binds deps. The per-call guard is unchanged.
    const src = sourceOf({ format: "date-time" }, builtInFormats);
    expect(src).toContain(`deps.formats.get("date-time")?.validate`);
    expect(src).toMatch(/typeof data === "string" && \w+ !== undefined && !\w+\(data\)/);
  });
});

describe("the registry entries are the tested predicates", () => {
  it("wires int32 and int64 to the exported validators", () => {
    expect(builtInFormats["int32"]).toEqual({ type: "number", validate: validateInt32 });
    expect(builtInFormats["int64"]).toEqual({ type: "number", validate: validateInt64 });
  });
});
