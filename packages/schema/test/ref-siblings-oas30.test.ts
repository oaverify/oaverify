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
    $ref: "#/$defs/S",
    ...sibling,
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

  // Two cases this deliberately does NOT fix, pinned so the limit is
  // visible rather than discovered later. A discarded sibling whose own
  // shape is wrong, and a bad keyword inside one, both stay fatal.
  //
  // The structural walk cannot be gated the way the value checks are:
  // it is what stops `resolve` meeting a malformed node, and with
  // `{$ref, properties: null}` skipped it dies at `Object.keys(null)`
  // with a raw TypeError instead of a located message. Closing these
  // means hardening the resolver first.
  it("still rejects a discarded sibling whose own shape is wrong", () => {
    expect(() =>
      compileSchema(withSibling({ items: [{ type: "string" }] }), { dialect: oas30Dialect }),
    ).toThrow(/items/);
  });

  it("still rejects a bad keyword inside a discarded sibling", () => {
    expect(() =>
      compileSchema(withSibling({ properties: { a: { type: "application/json" } } }), {
        dialect: oas30Dialect,
      }),
    ).toThrow(/type/);
  });

  // Codegen decides "is this ref-only" with `"$ref" in schema`, so this
  // pass has to as well. Deciding it on `typeof === "string"` left a
  // non-string `$ref` with codegen dropping the siblings while this pass
  // still judged them.
  it("treats a non-string $ref the way codegen does", () => {
    expect(() =>
      compileSchema({ $ref: 42, type: "application/json" } as unknown as SchemaOrBoolean, {
        dialect: oas30Dialect,
      }),
    ).not.toThrow(/type/);
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

  // The skip is scoped to the dialect that discards siblings. Under 3.1
  // a sibling is honoured, so its value has to be judged as before.
  it("still throws for the same schema under 3.1, where siblings apply", () => {
    expect(() =>
      compileSchema(withSibling({ type: "application/json" }), { dialect: openapi31Dialect }),
    ).toThrow(/type/);
  });

  // The skip is scoped to a `$ref` being present. The same malformed
  // keyword on its own is still fatal, so this is not a general
  // weakening of the well-formedness pass.
  //
  // Deliberately not asserted: that an *allowed* sibling is still
  // judged. None of `$ref` / `description` / `summary` defines
  // `validateKeywordValue`, so there is nothing to judge and a test
  // saying otherwise would be testing a path that does not exist.
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
