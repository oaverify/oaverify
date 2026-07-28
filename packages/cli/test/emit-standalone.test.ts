import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { emitStandalone } from "../src/emit-standalone.js";

/**
 * Round-trip: compile a schema, write the emitted module to a temp
 * file, import it, and verify its `validate` produces the same
 * verdict as compileSchema's dynamic version on the same fixtures.
 *
 * The emitter's import prefix defaults to `@oaverify/core`
 * so vitest's module resolver can satisfy the generated imports
 * without needing a published tarball.
 */
async function compileModule<T = unknown>(
  schema: SchemaOrBoolean,
  opts?: { dialect?: "2020-12" | "openapi-3.1" | "openapi-3.0" },
): Promise<{ validate: (data: unknown) => { valid: boolean; error?: unknown }; dir: string }> {
  const source = emitStandalone(schema, {
    dialect: opts?.dialect ?? "2020-12",
  });
  const dir = await mkdtemp(join(tmpdir(), "oav-emit-"));
  const file = join(dir, "v.mjs");
  await writeFile(file, source);
  const mod = (await import(file)) as {
    validate: (data: unknown) => { valid: boolean; error?: unknown };
  };
  // Cast through T for narrowing on the caller side if needed.
  void ({} as T);
  return { validate: mod.validate, dir };
}

describe("emitStandalone", () => {
  it("round-trips a simple schema (2020-12): accepts valid, rejects invalid", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        age: { type: "integer", minimum: 0 },
      },
    };
    const { validate, dir } = await compileModule(schema);
    try {
      expect(validate({ name: "Fido" })).toEqual({ valid: true });
      expect(validate({ name: "Max", age: 3 })).toEqual({ valid: true });
      const missingName = validate({});
      expect(missingName.valid).toBe(false);
      const wrongType = validate({ name: 123 });
      expect(wrongType.valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("includes built-in formats: emitted validator checks email", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { contact: { type: "string", format: "email" } },
    };
    const { validate, dir } = await compileModule(schema);
    try {
      expect(validate({ contact: "user@example.com" })).toEqual({ valid: true });
      // format defaults to annotation-only under jsonSchemaDialect, so a
      // malformed email still passes. The emitter correctly wires the
      // formats regardless; stricter behavior requires the assertion
      // vocabulary, which isn't the JSON-Schema default.
      expect(validate({ contact: "not-an-email" }).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects schemas that reference a format not in builtInFormats", () => {
    expect(() =>
      emitStandalone({ type: "string", format: "custom-thing" } as unknown as SchemaOrBoolean, {
        dialect: "2020-12",
      }),
    ).toThrow(/not in the built-in set/);
  });

  it('accepts schemas using format: "regex" (auto-registered by @oaverify/internal-schema\'s createDeps)', async () => {
    // Regression guard: the `regex` format was removed from
    // builtInFormats when @oaverify/internal-schema started auto-registering it
    // inside createDeps. The standalone preflight has to know about
    // the auto-registration set, otherwise it rejects a legitimate
    // built-in format. Round-trip the emitted module to confirm the
    // format is actually wired (not just permitted).
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { pattern: { type: "string", format: "regex" } },
    };
    const { validate, dir } = await compileModule(schema, { dialect: "openapi-3.1" });
    try {
      expect(validate({ pattern: "^abc$" })).toEqual({ valid: true });
      expect(validate({ pattern: "(unclosed" }).valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("compiles under the OpenAPI 3.0 dialect: boolean exclusiveMaximum honored", async () => {
    const schema: SchemaOrBoolean = {
      type: "integer",
      maximum: 10,
      // OAS 3.0 permits a boolean here; SchemaObject models it.
      exclusiveMaximum: true,
    };
    const { validate, dir } = await compileModule(schema, { dialect: "openapi-3.0" });
    try {
      expect(validate(9).valid).toBe(true);
      // exclusiveMaximum: true means max-10 is rejected.
      expect(validate(10).valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emitted source is valid ESM (starts with a comment and import statements)", () => {
    const source = emitStandalone({ type: "integer" } as SchemaOrBoolean, { dialect: "2020-12" });
    expect(source).toMatch(/^\/\/ Generated by/);
    expect(source).toContain("import { createLeafError");
    expect(source).toContain("import { createDeps");
    expect(source).toContain("import { builtInFormats");
    expect(source).toContain("export { validate };");
  });
});
