import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

/**
 * OAS 3.0 discards every `$ref` sibling but `description` and `summary`,
 * and the compiler honours that: `refOnly` in `compileSchemaInto` skips
 * them, and the lint pass reports each one as silently dropped.
 *
 * The well-formedness pass did not know, so it judged the *value* of a
 * keyword nothing would read. That made the discard fatal for some
 * values and a warning for others, which is the same slot answering two
 * ways:
 *
 *   {$ref, type: "application/json"}  ->  threw; check exited 4
 *   {$ref, type: "string"}            ->  warned; check exited 0
 *
 * A real spec hit it: guru-cloudmersive.com_ocr-3.0.0.yaml.
 */

const withSibling = (sibling: Record<string, unknown>): SchemaOrBoolean =>
  ({
    allOf: [
      {
        $ref: "#/$defs/S",
        ...sibling,
      },
    ],
    $defs: { S: { type: "string" } },
  }) as SchemaOrBoolean;

describe("a $ref sibling under OAS 3.0", () => {
  it("does not throw on a sibling whose value is invalid", () => {
    expect(() =>
      compileSchema(withSibling({ type: "application/json" }), { dialect: oas30Dialect }),
    ).not.toThrow();
  });

  // The sibling here would flip both verdicts if it were honoured: the
  // target says `type: string`, the sibling says `type: number`. So
  // these assertions hold only because the sibling really is dropped,
  // which an agreeing pair of `type: string` values would not have
  // shown.
  it("drops the sibling rather than applying it", () => {
    const compiled = compileSchema(withSibling({ type: "number" }), { dialect: oas30Dialect });
    expect(compiled.validate("ok").valid).toBe(true);
    expect(compiled.validate(42).valid).toBe(false);
  });

  it("reaches the same verdict whether the discarded sibling is valid or not", () => {
    const bad = compileSchema(withSibling({ type: "application/json" }), {
      dialect: oas30Dialect,
    });
    const good = compileSchema(withSibling({ type: "number" }), { dialect: oas30Dialect });
    for (const value of ["ok", 42]) {
      expect(bad.validate(value).valid).toBe(good.validate(value).valid);
    }
  });

  it("does not reject a discarded sibling whose own shape is wrong", () => {
    expect(() =>
      compileSchema(withSibling({ items: [{ type: "string" }] }), { dialect: oas30Dialect }),
    ).not.toThrow();
  });

  it.each([
    ["single schema holder", { items: null }],
    ["array schema entry", { allOf: [null] }],
    ["map schema entry", { properties: { a: null } }],
    ["mixed map schema entry", { dependencies: { a: null } }],
    ["nested keyword value", { properties: { a: { type: "application/json" } } }],
  ])("does not reject discarded %s structure", (_name, sibling) => {
    expect(() => compileSchema(withSibling(sibling), { dialect: oas30Dialect })).not.toThrow();
  });

  // Codegen decides "is this ref-only" with `"$ref" in schema`, so this
  // pass has to as well. Deciding it on `typeof === "string"` left a
  // non-string `$ref` with codegen dropping the siblings while this pass
  // still judged them.
  it("rejects a non-string $ref without judging discarded siblings first", () => {
    expect(() =>
      compileSchema({ $ref: 42, type: "application/json" } as unknown as SchemaOrBoolean, {
        dialect: oas30Dialect,
      }),
    ).toThrow(/keyword "\$ref" requires a URI-reference string/);
  });

  it("still reports the sibling as silently dropped", () => {
    const { stats } = compileSchema(withSibling({ type: "application/json" }), {
      dialect: oas30Dialect,
      schemaLint: "warn",
    });
    expect(stats.schemaLintIssues.map((i) => i.code)).toContain(
      "silent-rewrite/ref-siblings-oas30",
    );
  });

  it("does not run schema lint inside discarded sibling content", () => {
    const { stats } = compileSchema(
      withSibling({
        required: ["missing"],
        properties: { child: { unknownKeyword: true, required: ["alsoMissing"] } },
        pattern: "\\c",
        enum: [1],
        type: "string",
      }),
      {
        dialect: oas30Dialect,
        schemaLint: "strict",
      },
    );
    const codes = stats.schemaLintIssues.map((issue) => issue.code);
    expect(codes).toContain("silent-rewrite/ref-siblings-oas30");
    expect(codes).not.toContain("unknown-keyword");
    expect(codes).not.toContain("silent-rewrite/required-not-in-properties");
    expect(codes).not.toContain("silent-rewrite/pattern-not-unicode-mode");
    expect(codes).not.toContain("unsatisfiable/enum-type-mismatch");
  });

  it('does not reject an unknown format discarded by unknownFormats: "error"', () => {
    expect(() =>
      compileSchema(withSibling({ format: "iban" }), {
        dialect: oas30Dialect,
        unknownFormats: "error",
      }),
    ).not.toThrow();
  });

  it('does not reject an unknown format inside a discarded sibling under unknownFormats: "error"', () => {
    expect(() =>
      compileSchema(withSibling({ properties: { a: { type: "string", format: "iban" } } }), {
        dialect: oas30Dialect,
        unknownFormats: "error",
      }),
    ).not.toThrow();
  });

  it('still rejects an unknown format in the $ref target under unknownFormats: "error"', () => {
    expect(() =>
      compileSchema(
        {
          allOf: [{ $ref: "#/$defs/S", format: "discarded" }],
          $defs: { S: { type: "string", format: "iban" } },
        } as SchemaOrBoolean,
        {
          dialect: oas30Dialect,
          unknownFormats: "error",
        },
      ),
    ).toThrow(/format "iban"\. unknownFormats/);
  });

  it("does not resolve anchors that exist only inside discarded sibling subtrees", () => {
    expect(() =>
      compileSchema(
        {
          allOf: [
            {
              $ref: "#/$defs/S",
              properties: { ignored: { $anchor: "ignored", type: "number" } },
            },
          ],
          $defs: { S: { $ref: "#ignored" } },
        } as SchemaOrBoolean,
        { dialect: oas30Dialect },
      ),
    ).toThrow(/unknown anchor: #ignored/);
  });

  it("does not resolve JSON Pointers through discarded sibling subtrees", () => {
    expect(() =>
      compileSchema(
        {
          allOf: [
            {
              $ref: "#/$defs/S",
              properties: { ignored: { type: "number" } },
            },
          ],
          $defs: { S: { $ref: "#/allOf/0/properties/ignored" } },
        } as SchemaOrBoolean,
        { dialect: oas30Dialect },
      ),
    ).toThrow(/OAS 3\.0 \$ref sibling/);
  });

  // The skip is scoped to the dialect that discards siblings. Under 3.1
  // a sibling is honoured, so its value has to be judged as before.
  it("still throws for the same schema under 3.1, where siblings apply", () => {
    expect(() =>
      compileSchema(withSibling({ type: "application/json" }), { dialect: openapi31Dialect }),
    ).toThrow(/type/);
  });

  it("still rejects malformed sibling structure under 3.1, where siblings apply", () => {
    expect(() =>
      compileSchema(withSibling({ items: [{ type: "string" }] }), { dialect: openapi31Dialect }),
    ).toThrow(/items/);
    expect(() =>
      compileSchema(withSibling({ properties: { a: { type: "application/json" } } }), {
        dialect: openapi31Dialect,
      }),
    ).toThrow(/properties\.a\.type/);
  });

  it('still rejects an unknown sibling format under 3.1 with unknownFormats: "error"', () => {
    expect(() =>
      compileSchema(withSibling({ format: "iban" }), {
        dialect: openapi31Dialect,
        unknownFormats: "error",
      }),
    ).toThrow(/format "iban"/);
  });

  // The skip is scoped to a `$ref` being present. The same malformed
  // keyword on its own is still fatal, so this is not a general
  // weakening of the well-formedness pass.
  //
  // Deliberately not asserted: that `description` or `summary` is still
  // judged. Neither defines `validateKeywordValue`; `$ref` is covered
  // above because it is the schema's reference, not a discarded sibling.
  it("still judges the same keyword when no $ref discards it", () => {
    expect(() =>
      compileSchema(withSibling({ enum: "not-an-array" }), { dialect: oas30Dialect }),
    ).not.toThrow();
    expect(() =>
      compileSchema({ enum: "not-an-array" } as unknown as SchemaOrBoolean, {
        dialect: oas30Dialect,
      }),
    ).toThrow(/enum/);
  });
});
