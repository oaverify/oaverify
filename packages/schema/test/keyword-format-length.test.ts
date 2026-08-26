import { builtInFormats } from "@oaverify/internal-formats";
import { describe, expect, it } from "vitest";
import { compileSchema } from "../src/compiler/compiler.js";
import { openapi31Dialect } from "../src/keywords/vocabulary.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * `maxFormatLength` (#960).
 *
 * Several format grammars are `(?:X{4})*` over an unbounded matching run,
 * which pushes a frame onto V8's regex backtrack stack per iteration. That
 * stack is a fixed 64 MB region separate from the JS call stack, so a long
 * enough *valid* value threw `RangeError` out of `validate()` rather than
 * returning a verdict. Measured on `byte`: 4,473,516 characters returned,
 * 4,477,422 threw.
 *
 * The fix caps the length a string format is asserted against. Above the cap
 * the assertion is skipped and the value is accepted, which is the
 * annotation-only behaviour 2020-12 specifies as its default, rather than
 * being called invalid on no evidence.
 */

const DEFAULT_CAP = 1_048_576;

const compile = (
  schema: Record<string, unknown>,
  options: Record<string, unknown> = {},
): ReturnType<typeof compileSchema> =>
  compileSchema(
    schema as SchemaOrBoolean,
    {
      dialect: openapi31Dialect,
      formats: builtInFormats as never,
      ...options,
    } as never,
  );

/**
 * The boolean verdict, whatever result shape the options produced.
 * `compileSchema`'s return type is a union over its output modes, and this
 * file varies options, so the union does not narrow at the call site.
 */
const verdict = (v: ReturnType<typeof compile>, value: string | number): boolean => {
  const r = v.validate(value as never) as boolean | { valid: boolean };
  return typeof r === "boolean" ? r : r.valid;
};

/** Valid unwrapped base64, `n` characters long. */
const base64 = (n: number): string => "A".repeat(n);

describe("maxFormatLength: the value that used to crash", () => {
  it("returns a verdict where it threw RangeError", () => {
    const v = compile({ type: "string", format: "byte" });
    // 4,477,422 is the measured threshold: one character under this
    // returned, this threw. Both are now verdicts.
    expect(() => v.validate(base64(4_477_422))).not.toThrow();
    expect(verdict(v, base64(4_477_422))).toBe(true);
    expect(verdict(v, base64(8_000_000))).toBe(true);
  });

  it("still asserts everything at or below the cap", () => {
    const v = compile({ type: "string", format: "byte" });
    expect(verdict(v, base64(DEFAULT_CAP))).toBe(true);
    // One `!` makes it not base64. Under the cap that is still caught.
    expect(verdict(v, `!${base64(DEFAULT_CAP - 1)}`)).toBe(false);
    expect(verdict(v, "!!!!")).toBe(false);
  });

  it("stops asserting above the cap, rather than rejecting", () => {
    const v = compile({ type: "string", format: "byte" });
    // The honest cost of the design: a malformed value too large to check
    // is accepted. A false accept, which this repo orders below a false
    // reject, and the alternative refuses legitimate uploads.
    expect(verdict(v, `!${base64(DEFAULT_CAP)}`)).toBe(true);
  });
});

describe("maxFormatLength: configuration", () => {
  it("takes an explicit cap", () => {
    const v = compile({ type: "string", format: "byte" }, { maxFormatLength: 8 });
    expect(verdict(v, "!!!!")).toBe(false);
    // Nine characters is over the cap, so it is not asserted.
    expect(verdict(v, "!!!!!!!!!")).toBe(true);
  });

  it("asserts at any length when set to Infinity", () => {
    const v = compile(
      { type: "string", format: "byte" },
      { maxFormatLength: Number.POSITIVE_INFINITY },
    );
    expect(verdict(v, `!${base64(DEFAULT_CAP)}`)).toBe(false);
  });

  it("rejects a cap that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => compile({ type: "string", format: "byte" }, { maxFormatLength: bad }),
        String(bad),
      ).toThrow(/maxFormatLength/);
    }
  });
});

describe("maxFormatLength: what it does not touch", () => {
  it("leaves numeric formats alone, since a number has no length", () => {
    const v = compile({ type: "integer", format: "int32" }, { maxFormatLength: 1 });
    expect(verdict(v, 3_000_000_000)).toBe(false);
    expect(verdict(v, 42)).toBe(true);
  });

  it("emits byte-identical source when the cap is Infinity", () => {
    // The guard is a compile-time constant, so an uncapped compile must
    // produce exactly the source it produced before the option existed.
    const capped = compile({ type: "string", format: "byte" }, { retainSource: true });
    const uncapped = compile(
      { type: "string", format: "byte" },
      { retainSource: true, maxFormatLength: Number.POSITIVE_INFINITY },
    );
    const sourceOf = (v: unknown): string => (v as { source?: string }).source ?? "";
    expect(sourceOf(uncapped)).not.toBe("");
    expect(sourceOf(uncapped)).not.toContain(".length <=");
    expect(sourceOf(capped)).toContain(`.length <= ${DEFAULT_CAP}`);
  });

  it("does not change a verdict for any value under the cap", () => {
    // The relation the option must not break: below the cap, capped and
    // uncapped agree on everything.
    const capped = compile({ type: "string", format: "byte" });
    const uncapped = compile(
      { type: "string", format: "byte" },
      { maxFormatLength: Number.POSITIVE_INFINITY },
    );
    const probes = ["", "AAAA", "AA==", "A", "!!!!", "aGVsbG8=", base64(1000), `!${base64(999)}`];
    for (const p of probes) {
      expect(verdict(capped, p), JSON.stringify(p).slice(0, 20)).toBe(verdict(uncapped, p));
    }
  });
});
