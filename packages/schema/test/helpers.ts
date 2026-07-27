import { compileSchema, type CompileOptions } from "../src/compiler/compiler.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

/**
 * Compile a schema with the default JSON Schema 2020-12 dialect and
 * return the validator. Used by keyword tests so they don't repeat the
 * options boilerplate.
 *
 * Pins `output: "tree"` and uncapped `maxErrors` so the large body of
 * keyword tests keeps asserting against the nested error tree and the
 * full error set. The v3 zero-config defaults (flat shape, `maxErrors:
 * 1`) are exercised by `default-output.test.ts`, `flat-mode.test.ts`,
 * and the conformance suite, not here. Either default is overridable.
 */
export function compile(
  schema: SchemaOrBoolean,
  overrides: Partial<CompileOptions> = {},
): ReturnType<typeof compileSchema> {
  // Only inject the tree default when the caller hasn't picked a mode,
  // so `compile(schema, { predicate: true })` / `{ flat: true }` /
  // `{ output: ... }` don't collide with a forced `output: "tree"`.
  const picksMode = "output" in overrides || "flat" in overrides || "predicate" in overrides;
  return compileSchema(schema, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
    ...(picksMode ? {} : { output: "tree" as const }),
    ...overrides,
  });
}
