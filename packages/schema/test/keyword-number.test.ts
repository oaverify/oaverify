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
