import {
  compileSchema,
  type CompiledPredicate,
  type CompiledSchema,
  type CompiledTreeSchema,
  type CompileOptions,
} from "../src/compiler/compiler.js";
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
 *
 * Overloaded rather than returning the bare union: without this every
 * `.error` / `.valid` access in a keyword test is a type error, because
 * the union spans all three output shapes. The overloads let callers
 * that take the tree default get the tree type, which is what nearly
 * all of them want.
 */
export function compile(
  schema: SchemaOrBoolean | Record<string, unknown>,
  overrides?: Partial<CompileOptions> & { output?: undefined },
): CompiledTreeSchema;
export function compile(
  schema: SchemaOrBoolean | Record<string, unknown>,
  overrides: Partial<CompileOptions> & { output: "predicate" },
): CompiledPredicate;
export function compile(
  schema: SchemaOrBoolean | Record<string, unknown>,
  overrides: Partial<CompileOptions> & { output: "flat" },
): CompiledSchema;
export function compile(
  schema: SchemaOrBoolean | Record<string, unknown>,
  overrides?: Partial<CompileOptions>,
): CompiledSchema | CompiledTreeSchema | CompiledPredicate;
export function compile(
  schema: SchemaOrBoolean | Record<string, unknown>,
  overrides: Partial<CompileOptions> = {},
): CompiledSchema | CompiledTreeSchema | CompiledPredicate {
  // Only inject the tree default when the caller hasn't picked a mode,
  // so `compile(schema, { output: ... })` doesn't collide with a forced
  // `output: "tree"`.
  const picksMode = "output" in overrides;
  return compileSchema(
    schema as SchemaOrBoolean,
    {
      dialect: jsonSchemaDialect,
      maxErrors: Number.POSITIVE_INFINITY,
      ...(picksMode ? {} : { output: "tree" as const }),
      ...overrides,
    } as CompileOptions,
  );
}

/**
 * Narrow a validation result to its failure branch.
 *
 * `TreeValidationResult` and `ValidationResult` are discriminated
 * unions, and `expect(r.valid).toBe(false)` does not narrow them, so
 * `r.error` / `r.errors` is a type error at every assertion site. The
 * usual workaround, `r.error?.code`, types fine but quietly passes when
 * the result was valid: `undefined?.code` is `undefined`, and an
 * assertion against `undefined` can succeed for the wrong reason.
 *
 * This throws instead, so an unexpectedly-valid result fails the test
 * where it happens rather than further along.
 */
export function failure<T extends { valid: boolean }>(result: T): Extract<T, { valid: false }> {
  if (result.valid) {
    throw new Error("expected an invalid result, got a valid one");
  }
  return result as Extract<T, { valid: false }>;
}
