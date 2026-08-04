import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/index.js";
import { jsonSchemaDialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

const asserting = { dialect: openapi31Dialect, unknownFormats: "error" } as const;

describe('unknownFormats: "error"', () => {
  it("refuses a format with no validator, naming it", () => {
    expect(() => compileSchema({ type: "string", format: "iban" } as never, asserting)).toThrow(
      /no validator registered for format "iban"/,
    );
  });

  it("compiles when the format is registered", () => {
    const compiled = compileSchema({ type: "string", format: "iban" } as never, {
      ...asserting,
      formats: { iban: (s) => s.startsWith("GB") },
    });
    expect(compiled.validate("GB33").valid).toBe(true);
    expect(compiled.validate("XX33").valid).toBe(false);
  });

  it("names every missing format at once, sorted", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", format: "zeta" },
        b: { type: "string", format: "alpha" },
      },
    };
    expect(() => compileSchema(schema as never, asserting)).toThrow(
      /format "alpha", "zeta"\. unknownFormats/,
    );
  });

  it("reports a name once however many positions use it", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", format: "iban" },
        b: { type: "string", format: "iban" },
      },
    };
    expect(() => compileSchema(schema as never, asserting)).toThrow(/format "iban"\. unknown/);
  });

  // The documented escape hatch: a vendor format stays legal by saying
  // out loud that it is an annotation.
  it("accepts a vendor format registered as the identity", () => {
    const compiled = compileSchema({ type: "string", format: "x-internal-id" } as never, {
      ...asserting,
      formats: { "x-internal-id": () => true },
    });
    expect(compiled.validate("anything").valid).toBe(true);
  });

  it("sees a format behind a $ref", () => {
    const schema = {
      $defs: { Inner: { type: "string", format: "iban" } },
      properties: { a: { $ref: "#/$defs/Inner" } },
    };
    expect(() => compileSchema(schema as never, asserting)).toThrow(/format "iban"/);
  });

  it("labels the failure when the caller named the compile", () => {
    expect(() =>
      compileSchema({ type: "string", format: "iban" } as never, {
        ...asserting,
        label: "POST /things request body",
      }),
    ).toThrow(/^POST \/things request body: no validator/);
  });
});

describe("it is scoped to dialects that assert format", () => {
  // Under the annotation-only default nothing is enforced by design, so
  // a missing validator has cost nothing and there is nothing to refuse.
  it("is inert under the annotation-only default", () => {
    const compiled = compileSchema({ type: "string", format: "iban" } as never, {
      dialect: jsonSchemaDialect,
      unknownFormats: "error",
    });
    expect(compiled.validate("anything").valid).toBe(true);
  });
});

describe("it is independent of the other switches", () => {
  it("still refuses with schemaLint off", () => {
    expect(() =>
      compileSchema({ type: "string", format: "iban" } as never, {
        ...asserting,
        schemaLint: "off",
      }),
    ).toThrow(/no validator registered/);
  });

  it('defaults to "ignore", leaving the format asserting nothing', () => {
    const compiled = compileSchema({ type: "string", format: "iban" } as never, {
      dialect: openapi31Dialect,
    });
    expect(compiled.validate("not an iban at all").valid).toBe(true);
  });

  it('is a no-op when set to "ignore" explicitly', () => {
    const compiled = compileSchema({ type: "string", format: "iban" } as never, {
      dialect: openapi31Dialect,
      unknownFormats: "ignore",
    });
    expect(compiled.validate("anything").valid).toBe(true);
  });
});
