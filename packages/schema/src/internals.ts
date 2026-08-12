/**
 * Internal re-exports for `@oaverify/core/schema/internals`. Exposes
 * the codegen mechanics, runtime helpers, resolve internals, and
 * subschema-position constants that sit below the public extension
 * recipe. Reachable when you really need them (tests, advanced
 * plugins, tooling that walks or rewrites schemas) but deliberately
 * separated from the main `@oaverify/core/schema` barrel so the
 * public surface matches what keyword authors actually need.
 *
 * Nothing here is covered by semver guarantees. Compare against the
 * main barrel in `./index.ts` before importing from here.
 *
 * @packageDocumentation
 */

// Codegen mechanics: used by keyword authors that need to emit
// non-boilerplate JS (path joining, string quoting, raw JS injection,
// and the safe-literal helpers that coerce schema-supplied values
// before interpolating them into generated source).
export {
  booleanLiteral,
  checkStringArray,
  CodeGen,
  NAMES,
  Scope,
  nonNegativeIntegerLiteral,
  numberLiteral,
  pathJoinExpr,
  positiveNumberLiteral,
  quoteString,
  rawExpr,
  stringArrayValue,
  type CodeEmitter,
  type NameGenerator,
  type PathSegmentLike,
  type RawExpression,
} from "./codegen/index.js";

// Runtime helpers: the objects bundled into `deps` and fed to every
// generated validator. Callers building custom compilers or dialect
// harnesses can reach for these; normal consumers don't.
export {
  createDeps,
  deepEqual,
  typeOf,
  wrapErrors,
  type CompiledRegex,
  type CreateDepsOptions,
  type RegexCompiler,
  type ValidatorDeps,
} from "./compiler/runtime.js";

// Resolve internals. `resolve` / `createRefResolver` are in the main
// barrel (they're how the validator wires the compiler up); the
// registry is strictly internal.
export { SchemaRegistry } from "./resolve/index.js";

// The `unknownFormats: "error"` check, so an engine that compiles
// lazily can run it at construction instead of mid-stream.
export { assertFormatsRegistered } from "./compiler/unknown-formats.js";
export { buildKeywordMap } from "./introspection.js";

// Keyword-context factory. Keyword authors receive a context (via
// `compile(ctx)`); only the compiler (and tests that exercise a
// keyword in isolation) need to build one.
export { createKeywordContext, type KeywordContextInputs } from "./keywords/context.js";

// Subschema-position constants: the raw sets of schema-valued keys.
// Prefer the public `walkSubschemas` helper when a read-walk suffices;
// reach for these only when you need to transform / rewrite.
export {
  isSubschemaKey,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "./subschema-positions.js";
