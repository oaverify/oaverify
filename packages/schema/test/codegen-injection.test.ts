/**
 * Codegen-injection regression tests.
 *
 * The compiler builds validator source by string-interpolating schema
 * values into generated JavaScript. Untrusted schemas can therefore
 * smuggle code through any keyword whose value lands raw in a JS
 * expression context (numerics) or in a generated template literal
 * (a few string fields). These tests exercise both classes:
 *
 *   1. Numeric keywords reject non-finite, non-integer, or string
 *      values at compile time with a clear `keyword "..."` error.
 *   2. String-bearing keywords whose value reaches a generated
 *      template literal (`discriminator.propertyName`,
 *      `dependencies` / `dependentRequired` keys) cannot inject by
 *      embedding ``${...}`` or backticks; the message is a quoted
 *      literal in the generated source.
 *   3. Negative space: schemas with adversarial strings in
 *      `pattern`, `format`, `enum`, `const`, and property names
 *      compile and run normally because those values flow through
 *      `quoteString` / `JSON.stringify`.
 *
 * The canary every numeric case checks: a payload that, if executed,
 * sets `globalThis.__oavInjection`. Compile must throw before the
 * generated function is ever built; the canary must remain unset.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "./helpers.js";
import { compileSchema } from "../src/index.js";
import { oas30Dialect } from "../src/keywords/vocabulary.js";

const G = globalThis as unknown as Record<string, unknown>;
const CANARY = "__oavInjection";

beforeEach(() => {
  delete G[CANARY];
});
afterEach(() => {
  delete G[CANARY];
});

function expectNoCanary(): void {
  expect(G[CANARY]).toBeUndefined();
}

// A side-effecting expression that, if reached, sets the canary.
// Wrapped so it returns a number / boolean for whichever slot it lands in.
const EXPR_NUMBER = `(globalThis.${CANARY} = "x", 5)`;
const EXPR_BOOLEAN = `(globalThis.${CANARY} = "x", true)`;

describe("codegen injection: numeric keywords reject non-numbers", () => {
  const numericKeywords: ReadonlyArray<{
    name: string;
    schema: (val: unknown) => Record<string, unknown>;
    /** "non-negative integer" or "finite number" - controls which payloads we expect to fail. */
    kind: "nonNegativeInteger" | "finite" | "positiveFinite";
  }> = [
    {
      name: "maxLength",
      schema: (v) => ({ type: "string", maxLength: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "minLength",
      schema: (v) => ({ type: "string", minLength: v }),
      kind: "nonNegativeInteger",
    },
    { name: "maximum", schema: (v) => ({ type: "number", maximum: v }), kind: "finite" },
    { name: "minimum", schema: (v) => ({ type: "number", minimum: v }), kind: "finite" },
    {
      name: "exclusiveMaximum",
      schema: (v) => ({ type: "number", exclusiveMaximum: v }),
      kind: "finite",
    },
    {
      name: "exclusiveMinimum",
      schema: (v) => ({ type: "number", exclusiveMinimum: v }),
      kind: "finite",
    },
    {
      name: "multipleOf",
      schema: (v) => ({ type: "number", multipleOf: v }),
      kind: "positiveFinite",
    },
    {
      name: "maxItems",
      schema: (v) => ({ type: "array", maxItems: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "minItems",
      schema: (v) => ({ type: "array", minItems: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "maxProperties",
      schema: (v) => ({ type: "object", maxProperties: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "minProperties",
      schema: (v) => ({ type: "object", minProperties: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "minContains",
      schema: (v) => ({ type: "array", contains: { type: "string" }, minContains: v }),
      kind: "nonNegativeInteger",
    },
    {
      name: "maxContains",
      schema: (v) => ({ type: "array", contains: { type: "string" }, maxContains: v }),
      kind: "nonNegativeInteger",
    },
  ];

  for (const { name, schema, kind } of numericKeywords) {
    describe(name, () => {
      it("rejects a syntactically-valid expression that sets a canary", () => {
        expect(() => compile(schema(EXPR_NUMBER) as never)).toThrow(
          new RegExp(`keyword "${name}"`),
        );
        expectNoCanary();
      });

      it("rejects a string masquerading as a number", () => {
        expect(() => compile(schema("5") as never)).toThrow(new RegExp(`keyword "${name}"`));
        expectNoCanary();
      });

      it("rejects NaN", () => {
        expect(() => compile(schema(Number.NaN) as never)).toThrow(new RegExp(`keyword "${name}"`));
      });

      it("rejects Infinity", () => {
        expect(() => compile(schema(Number.POSITIVE_INFINITY) as never)).toThrow(
          new RegExp(`keyword "${name}"`),
        );
      });

      it("rejects null", () => {
        expect(() => compile(schema(null) as never)).toThrow(new RegExp(`keyword "${name}"`));
      });

      it("rejects an object", () => {
        expect(() => compile(schema({ malicious: true }) as never)).toThrow(
          new RegExp(`keyword "${name}"`),
        );
      });

      if (kind === "nonNegativeInteger") {
        it("rejects negative integers", () => {
          expect(() => compile(schema(-1) as never)).toThrow(new RegExp(`keyword "${name}"`));
        });
        it("rejects fractional values", () => {
          expect(() => compile(schema(1.5) as never)).toThrow(new RegExp(`keyword "${name}"`));
        });
        it("accepts a valid non-negative integer", () => {
          expect(() => compile(schema(0) as never)).not.toThrow();
          expect(() => compile(schema(5) as never)).not.toThrow();
        });
      } else if (kind === "finite") {
        it("accepts finite numbers (including negatives and fractions)", () => {
          expect(() => compile(schema(-1.5) as never)).not.toThrow();
          expect(() => compile(schema(0) as never)).not.toThrow();
          expect(() => compile(schema(1e6) as never)).not.toThrow();
        });
      } else {
        it("rejects zero (positive finite required)", () => {
          expect(() => compile(schema(0) as never)).toThrow(new RegExp(`keyword "${name}"`));
        });
        it("rejects negative numbers (positive finite required)", () => {
          expect(() => compile(schema(-1) as never)).toThrow(new RegExp(`keyword "${name}"`));
        });
        it("accepts positive finite numbers", () => {
          expect(() => compile(schema(0.5) as never)).not.toThrow();
          expect(() => compile(schema(1e-7) as never)).not.toThrow();
        });
      }
    });
  }
});

describe("codegen injection: OAS 3.0 numeric keywords reject non-numbers", () => {
  it("oas30 maximum rejects expression payload", () => {
    expect(() =>
      compileSchema({ type: "number", maximum: EXPR_NUMBER } as never, {
        dialect: oas30Dialect,
      }),
    ).toThrow(/keyword "maximum"/);
    expectNoCanary();
  });

  it("oas30 minimum rejects expression payload", () => {
    expect(() =>
      compileSchema({ type: "number", minimum: EXPR_NUMBER } as never, {
        dialect: oas30Dialect,
      }),
    ).toThrow(/keyword "minimum"/);
    expectNoCanary();
  });

  it("oas30 maximum with exclusiveMaximum=true compiles normally", () => {
    expect(() =>
      compileSchema({ type: "number", maximum: 5, exclusiveMaximum: true } as never, {
        dialect: oas30Dialect,
      }),
    ).not.toThrow();
  });
});

describe("codegen injection: backtick-template fields cannot smuggle ${...}", () => {
  // Schemas where a string field flows into a generated template-literal
  // message. The fix routes the message through `quoteString`, which
  // produces a "..." JS string literal in generated source, so any ${...}
  // in the user value becomes literal characters - no runtime evaluation.
  it("discriminator.propertyName containing a runtime template expression", () => {
    const schema = {
      oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      discriminator: {
        propertyName: `\${(globalThis.${CANARY} = "discriminator")}`,
        mapping: { a: "#/$defs/A", b: "#/$defs/B" },
      },
      $defs: {
        A: { type: "object" },
        B: { type: "object" },
      },
    } as never;
    const v = compile(schema);
    // Trigger the message path: data is an object whose discriminator
    // property is not a string. The generated message includes the
    // adversarial propertyName as literal text, NOT as evaluated code.
    const result = v.validate({ [`\${(globalThis.${CANARY} = "discriminator")}`]: 42 });
    expect(result.valid).toBe(false);
    expectNoCanary();
  });

  it("dependencies (array form) keys/values cannot inject", () => {
    const adversarialKey = `key\${(globalThis.${CANARY} = "deps-key")}`;
    const adversarialDep = `dep\${(globalThis.${CANARY} = "deps-dep")}`;
    const schema = {
      type: "object",
      dependencies: {
        [adversarialKey]: [adversarialDep],
      },
    } as never;
    const v = compile(schema);
    const result = v.validate({ [adversarialKey]: 1 });
    expect(result.valid).toBe(false);
    expectNoCanary();
  });

  it("dependentRequired keys/values cannot inject", () => {
    const adversarialKey = `key\${(globalThis.${CANARY} = "depReq-key")}`;
    const adversarialDep = `dep\${(globalThis.${CANARY} = "depReq-dep")}`;
    const schema = {
      type: "object",
      dependentRequired: {
        [adversarialKey]: [adversarialDep],
      },
    } as never;
    const v = compile(schema);
    const result = v.validate({ [adversarialKey]: 1 });
    expect(result.valid).toBe(false);
    expectNoCanary();
  });
});

describe("codegen injection: boolean OAS 3.0 exclusive flag must be a boolean", () => {
  // The codegen now hardcodes `"true"` / `"false"` strings based on a
  // === true comparison. Any non-true value collapses to false, so an
  // adversarial expression-as-string in `exclusiveMaximum` is treated
  // as "not exclusive" rather than executed.
  it("exclusiveMaximum: <expression string> behaves as non-exclusive (no execution)", () => {
    const v = compileSchema(
      {
        type: "number",
        maximum: 5,
        exclusiveMaximum: EXPR_BOOLEAN as never,
      } as never,
      { dialect: oas30Dialect },
    );
    // Compile succeeded without executing the expression.
    expectNoCanary();
    // Behaves as non-exclusive (boundary is allowed).
    expect(v.validate(5).valid).toBe(true);
    expect(v.validate(6).valid).toBe(false);
  });
});

describe("negative space: string-encoded fields tolerate adversarial input", () => {
  // These fields all flow through `quoteString` / `JSON.stringify`. The
  // schema validator's behavior is unaffected by adversarial strings,
  // and the canary is never set.

  it("pattern with adversarial regex source", () => {
    const adversarial = "abc`; (globalThis.__oavInjection = 1); //";
    // Most chars are regex-literal; the test only asserts no execution.
    expect(() => compile({ type: "string", pattern: adversarial } as never)).not.toThrow();
    expectNoCanary();
  });

  it("format name containing template-literal syntax", () => {
    const v = compile({
      type: "string",
      format: `\${(globalThis.${CANARY} = "format")}`,
    } as never);
    // Unknown format → no validation, no error.
    expect(v.validate("anything").valid).toBe(true);
    expectNoCanary();
  });

  it("property names containing template-literal syntax", () => {
    const adversarialKey = `key\${(globalThis.${CANARY} = "prop")}`;
    const v = compile({
      type: "object",
      properties: { [adversarialKey]: { type: "string" } },
      required: [adversarialKey],
    } as never);
    expect(v.validate({}).valid).toBe(false);
    expect(v.validate({ [adversarialKey]: "ok" }).valid).toBe(true);
    expect(v.validate({ [adversarialKey]: 42 }).valid).toBe(false);
    expectNoCanary();
  });

  it("enum / const carrying objects with adversarial strings", () => {
    const adversarial = `\${(globalThis.${CANARY} = "enum")}`;
    const v = compile({ enum: [adversarial, "ok"] } as never);
    expect(v.validate("ok").valid).toBe(true);
    expect(v.validate("nope").valid).toBe(false);
    expectNoCanary();

    const v2 = compile({ const: adversarial } as never);
    expect(v2.validate(adversarial).valid).toBe(true);
    expect(v2.validate("other").valid).toBe(false);
    expectNoCanary();
  });
});
