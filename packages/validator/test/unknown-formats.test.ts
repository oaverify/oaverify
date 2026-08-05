import { describe, expect, it } from "vitest";
import { createValidator } from "../src/index.js";

const spec = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/a": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { x: { type: "string", format: "iban" } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
} as never;

describe('createValidator with unknownFormats: "error"', () => {
  it("refuses the operation that names the format", () => {
    const validator = createValidator(spec, { unknownFormats: "error" });
    expect(() => validator.precompile()).toThrow(/no validator registered for format "iban"/);
  });

  it("compiles once the format is registered", () => {
    const validator = createValidator(spec, {
      unknownFormats: "error",
      formats: { iban: (s) => s.startsWith("GB") },
    });
    expect(() => validator.precompile()).not.toThrow();
  });

  it("leaves the built-in formats reachable", () => {
    const withBuiltIn = JSON.parse(JSON.stringify(spec));
    withBuiltIn.paths["/a"].post.requestBody.content[
      "application/json"
    ].schema.properties.x.format = "date-time";
    expect(() =>
      createValidator(withBuiltIn, { unknownFormats: "error" }).precompile(),
    ).not.toThrow(/* builtInFormats is merged in, so a standard name needs no registration */);
  });

  // The wrinkle worth knowing: compilation is lazy, so without an
  // explicit precompile the failure waits for the first request that
  // touches the operation. Documented on the option rather than worked
  // around, since forcing eager compilation would change startup cost
  // invisibly.
  it("does not throw at construction, only when the operation compiles", () => {
    expect(() => createValidator(spec, { unknownFormats: "error" })).not.toThrow();
  });

  it("collects rather than throws under precompile({ onMalformed: 'collect' })", () => {
    const validator = createValidator(spec, { unknownFormats: "error" });
    const failures = [...validator.precompile({ onMalformed: "collect" })];
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/no validator registered for format "iban"/);
  });
});

describe("a bare function over a numeric built-in", () => {
  const bare = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} };

  it("is refused, because it would silently assert nothing", () => {
    // A bare function is a string format, so under `int64` it never runs
    // and it displaces the built-in that would have. Losing both without
    // a word is the failure this refuses.
    expect(() =>
      createValidator(bare as never, { formats: { int64: () => true } } as never),
    ).toThrow(/formats\.int64 is a bare function/);
  });

  it("names both spellings that work", () => {
    expect(() =>
      createValidator(bare as never, { formats: { int32: () => true } } as never),
    ).toThrow(/\{ type: "number", validate \}|false to turn it off/);
  });

  it("accepts the full form, and false", () => {
    expect(() =>
      createValidator(
        bare as never,
        {
          formats: { int64: { type: "number", validate: () => true } },
        } as never,
      ),
    ).not.toThrow();
    expect(() =>
      createValidator(bare as never, { formats: { int64: false } } as never),
    ).not.toThrow();
  });

  it("leaves string built-ins and new names alone", () => {
    expect(() =>
      createValidator(bare as never, { formats: { email: () => true } } as never),
    ).not.toThrow();
    expect(() =>
      createValidator(bare as never, { formats: { "x-mine": () => true } } as never),
    ).not.toThrow();
  });
});
