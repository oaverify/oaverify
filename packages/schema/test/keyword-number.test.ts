import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("numeric keywords", () => {
  it("multipleOf rejects non-multiples and passes non-numbers", () => {
    const v = compile({ multipleOf: 3 });
    expect(v.validate(9).valid).toBe(true);
    expect(v.validate(10).valid).toBe(false);
    expect(v.validate("nope").valid).toBe(true);
    const r = v.validate(10);
    expect(failure(r).error.code).toBe("multipleOf");
    expect(failure(r).error.params).toMatchObject({ multipleOf: 3, actual: 10 });
  });

  it("multipleOf tolerates IEEE-754 rounding on decimal divisors", () => {
    const v = compile({ multipleOf: 0.01 });
    // 2.34 / 0.01 === 234.00000000000003 under IEEE-754; still a valid multiple.
    expect(v.validate(2.34).valid).toBe(true);
    expect(v.validate(0.1).valid).toBe(true);
    expect(v.validate(0.3).valid).toBe(true);
    expect(v.validate(2.345).valid).toBe(false);

    const v2 = compile({ multipleOf: 0.1 });
    expect(v2.validate(0.2).valid).toBe(true);
    expect(v2.validate(0.3).valid).toBe(true);
    expect(v2.validate(0.25).valid).toBe(false);
  });

  it("multipleOf answers an overflowing quotient by remainder, both ways", () => {
    // #709. Both official cases divide 1e308 by a divisor small enough
    // that the quotient overflows to Infinity, making q - round(q) NaN
    // and every `> tol` comparison false. The verdicts differ, so a
    // blanket reject is as wrong as the old blanket accept.
    // multipleOf.json, "float division = inf": invalid.
    const bad = compile({ type: "integer", multipleOf: 0.123456789 });
    expect(bad.validate(1e308).valid).toBe(false);
    expect(failure(bad.validate(1e308)).error.code).toBe("multipleOf");
    // optional/float-overflow.json: 1e308 is a genuine multiple of 0.5.
    expect(compile({ type: "integer", multipleOf: 0.5 }).validate(1e308).valid).toBe(true);
    expect(compile({ type: "integer", multipleOf: 0.25 }).validate(1e308).valid).toBe(true);
  });

  it("multipleOf tolerance never reaches a whole unit of the quotient", () => {
    // #709: the tolerance scales with |q|, so past |q| ~ 1.4e14 it grew
    // wider than the distance to the nearest integer and admitted
    // everything. 1e15 is not a multiple of 3 (digit sum 1).
    expect(compile({ multipleOf: 3 }).validate(1e15).valid).toBe(false);
    expect(compile({ multipleOf: 7 }).validate(1e16).valid).toBe(false);
    // Genuine large multiples still pass.
    expect(compile({ multipleOf: 3 }).validate(3e15).valid).toBe(true);
    expect(compile({ multipleOf: 1 }).validate(1e15).valid).toBe(true);
  });

  it("multipleOf still accepts the worst legitimate IEEE-754 drift", () => {
    // The widest drift found sweeping real divisors: 16384.3 / 0.1 lands
    // ~2.9e-11 off an integer. The cap must sit far above it.
    expect(compile({ multipleOf: 0.1 }).validate(16384.3).valid).toBe(true);
    expect(compile({ multipleOf: 1e-7 }).validate(0.3).valid).toBe(true);
  });

  it("multipleOf tolerance scales with value magnitude", () => {
    // 143.48 / 0.01 === 14347.999999999998; |q - round(q)| ≈ 1.82e-12,
    // above the flat 1e-12 tolerance. A relative-magnitude check must
    // still accept it as a valid 0.01 multiple.
    const v = compile({ multipleOf: 0.01 });
    expect(v.validate(143.48).valid).toBe(true);
    expect(v.validate(999.99).valid).toBe(true);
    expect(v.validate(1234567.89).valid).toBe(true);
    // And still reject genuine non-multiples at that scale.
    expect(v.validate(143.485).valid).toBe(false);
  });

  it("maximum / exclusiveMaximum enforce upper bounds", () => {
    const max = compile({ maximum: 10 });
    expect(max.validate(10).valid).toBe(true);
    expect(max.validate(11).valid).toBe(false);
    expect(failure(max.validate(11)).error.code).toBe("maximum");

    const ex = compile({ exclusiveMaximum: 10 });
    expect(ex.validate(9).valid).toBe(true);
    expect(ex.validate(10).valid).toBe(false);
    expect(failure(ex.validate(10)).error.code).toBe("exclusiveMaximum");
  });

  it("minimum / exclusiveMinimum enforce lower bounds", () => {
    const min = compile({ minimum: 0 });
    expect(min.validate(0).valid).toBe(true);
    expect(min.validate(-1).valid).toBe(false);
    expect(failure(min.validate(-1)).error.code).toBe("minimum");

    const ex = compile({ exclusiveMinimum: 0 });
    expect(ex.validate(1).valid).toBe(true);
    expect(ex.validate(0).valid).toBe(false);
    expect(failure(ex.validate(0)).error.code).toBe("exclusiveMinimum");
  });

  it("numeric bounds leave non-numbers alone", () => {
    const v = compile({ minimum: 0, maximum: 100 });
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate(null).valid).toBe(true);
  });
});
