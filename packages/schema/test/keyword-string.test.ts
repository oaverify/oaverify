import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("string keywords", () => {
  it("maxLength / minLength count code points (emoji = 1)", () => {
    const max = compile({ maxLength: 3 });
    expect(max.validate("abc").valid).toBe(true);
    expect(max.validate("abcd").valid).toBe(false);
    expect(max.validate("🦀🦀🦀").valid).toBe(true);

    const min = compile({ minLength: 3 });
    expect(min.validate("abc").valid).toBe(true);
    expect(min.validate("ab").valid).toBe(false);
    expect(min.validate("🦀🦀").valid).toBe(false);
  });

  it("maxLength treats a single surrogate-pair code point as length 1", () => {
    // Regression for #12: str.length would return 2 for this.
    const v = compile({ maxLength: 1 });
    expect(v.validate("👨").valid).toBe(true);
    expect(v.validate("ab").valid).toBe(false);
  });

  it("maxLength rejects a large string without allocating a code-point array", () => {
    // Regression for #143. The legacy `[...s].length` implementation
    // materialised one string-per-code-point for the whole input before
    // the length check could refuse it (trivially OOM-able). Validate
    // the fix: a multi-megabyte string against a 10-char cap returns a
    // failure quickly and without crashing.
    const big = "a".repeat(5_000_000);
    const v = compile({ maxLength: 10 });
    const start = Date.now();
    const res = v.validate(big);
    const elapsed = Date.now() - start;
    expect(res.valid).toBe(false);
    // Generous ceiling: the for...of walk is O(N) in time but O(1) in
    // memory. 2 s is orders of magnitude above the expected runtime
    // (~50 ms on modern hardware) and still catches a regression to
    // the allocating implementation.
    expect(elapsed).toBeLessThan(2000);
  });

  it("maxLength decides each .length band correctly (skip-pass / walk / skip-fail)", () => {
    const v = compile({ maxLength: 3 });
    // length <= limit: cannot exceed (skip-pass band).
    expect(v.validate("ab").valid).toBe(true);
    expect(v.validate("abc").valid).toBe(true);
    // limit < length <= 2*limit: walk band. ASCII overshoots; surrogate
    // pairs (length 4-6, 2-3 code points) can still pass.
    expect(v.validate("abcd").valid).toBe(false);
    expect(v.validate("🦀🦀🦀").valid).toBe(true); // length 6, 3 code points
    // length > 2*limit: must exceed (skip-fail band).
    expect(v.validate("aaaaaaa").valid).toBe(false);
  });

  it("minLength decides each .length band correctly (skip-fail / walk / skip-pass)", () => {
    const v = compile({ minLength: 3 });
    // length < limit: must be below (skip-fail band).
    expect(v.validate("ab").valid).toBe(false);
    // limit <= length < 2*limit-1: walk band.
    expect(v.validate("ab🦀").valid).toBe(true); // length 4, 3 code points
    expect(v.validate("🦀🦀").valid).toBe(false); // length 4, 2 code points
    // length >= 2*limit-1: cannot be below (skip-pass band).
    expect(v.validate("🦀🦀🦀").valid).toBe(true); // length 6, 3 code points
  });

  it("reports the exact code-point count in `actual` even when the bound short-circuits on .length", () => {
    // maxLength failure decided by the skip-fail band (length > 2*limit)
    // must still surface the true code-point count, not s.length.
    const max = compile({ maxLength: 2 });
    const res = max.validate("🦀🦀🦀"); // length 6, 3 code points
    expect(res.valid).toBe(false);
    expect(failure(res).error.code).toBe("maxLength");
    expect(failure(res).error.params).toMatchObject({ maxLength: 2, actual: 3 });

    const min = compile({ minLength: 5 });
    const res2 = min.validate("ab"); // length 2 < 5, skip-fail band
    expect(res2.valid).toBe(false);
    expect(failure(res2).error.params).toMatchObject({ minLength: 5, actual: 2 });
  });

  it("maxLength: 0 admits only the empty string", () => {
    const v = compile({ maxLength: 0 });
    expect(v.validate("").valid).toBe(true);
    expect(v.validate("a").valid).toBe(false);
  });

  it("pattern matches against an ECMA-262 regex (unicode)", () => {
    const v = compile({ pattern: "^[a-z]+$" });
    expect(v.validate("abc").valid).toBe(true);
    expect(v.validate("abc1").valid).toBe(false);
    expect(failure(v.validate("abc1")).error.code).toBe("pattern");
  });

  it("pattern leaves non-strings alone", () => {
    const v = compile({ pattern: "^x$" });
    expect(v.validate(1).valid).toBe(true);
  });

  it("pattern falls back to no-flag when `u` rejects stray escapes", () => {
    // Real-world case: DigitalOcean's spec uses patterns like
    //   ^[a-zA-Z0-9_\-\:]+$
    // which fail under the `u` flag (stray \- / \:) but are accepted
    // in non-Unicode mode. Validators should not reject these specs.
    const v = compile({ pattern: "^[a-zA-Z0-9_\\-\\:]+$" });
    expect(v.validate("abc-123:xyz").valid).toBe(true);
    expect(v.validate("abc!").valid).toBe(false);
  });

  it("pattern keeps Unicode-only features when `u` does parse", () => {
    // \p{L} is only meaningful under the `u` flag; without it, the
    // regex would match literal 'p{L}'. Verifies we try `u` first.
    const v = compile({ pattern: "^\\p{L}+$" });
    expect(v.validate("héllo").valid).toBe(true);
    expect(v.validate("abc123").valid).toBe(false);
  });

  it("pattern with a malformed regex throws at compile time (fail-fast on bad spec)", () => {
    expect(() => compile({ pattern: "(" })).toThrow(/Invalid regular expression/);
  });

  it("format is annotation-only by default (spec default)", () => {
    // Without the format-assertion vocabulary opt-in, bad values pass.
    const v = compile({ format: "email" }, { formats: { email: (s) => /@/.test(s) } });
    expect(v.validate("not an email").valid).toBe(true);
  });

  it("format asserts when the openapi31 dialect is used", async () => {
    const schema = await import("../src/index.js");
    const v = schema.compileSchema(
      { format: "email" },
      {
        dialect: schema.openapi31Dialect,
        output: "tree",
        formats: { email: (s) => /@/.test(s) },
      },
    );
    expect(v.validate("x@y").valid).toBe(true);
    expect(v.validate("nope").valid).toBe(false);
    expect(failure(v.validate("nope")).error.code).toBe("format");

    const noValidator = schema.compileSchema(
      { format: "whatever" },
      { dialect: schema.openapi31Dialect },
    );
    expect(noValidator.validate("anything").valid).toBe(true);
  });
});
