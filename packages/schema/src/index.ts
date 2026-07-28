/**
 * The public `@oaverify/core/schema` surface. Two audiences:
 *
 *   1. Compiler consumers: `compileSchema`, `CompiledSchema`,
 *      `CompileOptions`, dialects. The minimum needed to turn a schema
 *      into a validator.
 *   2. Keyword authors: `KeywordDefinition`, `KeywordCompileContext`,
 *      vocabulary URIs + vocab objects, the built-in keyword constants
 *      (useful for reusing or composing them into a custom dialect),
 *      the OAS 3.0 overrides.
 *
 * Codegen mechanics, runtime helpers, resolve internals, and the
 * subschema-position constants live behind
 * `@oaverify/core/schema/internals`. Reach for them when a custom
 * plugin genuinely needs them, accepting that they're not covered by
 * semver.
 *
 * @packageDocumentation
 */

// Compiler: turning schemas into validators.
export {
  compileSchema,
  schemaUsesUnevaluated,
  type CompiledFlatSchema,
  type CompiledPredicate,
  type CompiledRegex,
  type CompiledSchema,
  type CompiledTreeSchema,
  type CompileOptions,
  type CompileStats,
  type FlatValidationResult,
  type RegexCompiler,
  type SchemaLintIssue,
  type TreeValidationResult,
  type Validator,
  type ValidationResult,
} from "./compiler/index.js";

// Keyword authoring: types + context seen inside `compile(ctx)`.
export {
  createCustomKeywordDefinition,
  customKeywordVocabulary,
  type CustomKeywordFailure,
  type CustomKeywordValidator,
} from "./keywords/custom.js";
export type {
  CompileAndCallOptions,
  CompileRuntime,
  Dialect,
  DialectRules,
  ErrorKind,
  KeywordCompileContext,
  KeywordDefinition,
  ValidateSubschemaOptions,
  Vocabulary,
} from "./keywords/types.js";

// Vocabulary URIs + built-in vocabularies + dialects.
export {
  APPLICATOR_VOCAB,
  CONTENT_VOCAB,
  CORE_VALIDATION_VOCAB,
  CORE_VOCAB,
  FORMAT_ASSERTION_VOCAB,
  FORMAT_VOCAB,
  META_DATA_VOCAB,
  OAS30_VOCAB,
  OPENAPI_META_DATA_VOCAB,
  UNEVALUATED_VOCAB,
  applicatorVocabulary,
  contentVocabulary,
  coreVocabulary,
  defaultVocabularies,
  formatAssertionVocabulary,
  formatVocabulary,
  jsonSchemaDialect,
  metaDataVocabulary,
  oas30Dialect,
  oas30Vocabulary,
  openapi31Dialect,
  openapiMetaDataVocabulary,
  unevaluatedVocabulary,
  validationVocabulary,
} from "./keywords/vocabulary.js";

// Built-in keyword constants: reusable when composing a custom dialect.
export {
  maxItemsKeyword,
  minItemsKeyword,
  uniqueItemsKeyword,
} from "./keywords/array-validation.js";
export {
  allOfKeyword,
  anyOfKeyword,
  dependenciesKeyword,
  dependentRequiredKeyword,
  dependentSchemasKeyword,
  ifThenElseKeyword,
  notKeyword,
  oneOfKeyword,
} from "./keywords/composition.js";
export { constKeyword, enumKeyword } from "./keywords/equality.js";
export { containsKeyword, itemsKeyword, prefixItemsKeyword } from "./keywords/items.js";
export {
  contentEncodingKeyword,
  contentMediaTypeKeyword,
  contentSchemaKeyword,
  defaultKeyword,
  deprecatedKeyword,
  descriptionKeyword,
  exampleKeyword,
  examplesKeyword,
  externalDocsKeyword,
  readOnlyKeyword,
  titleKeyword,
  writeOnlyKeyword,
  xmlKeyword,
} from "./keywords/meta-data.js";
export {
  exclusiveMaximumKeyword,
  exclusiveMinimumKeyword,
  maximumKeyword,
  minimumKeyword,
  multipleOfKeyword,
} from "./keywords/number.js";
export {
  oas30ExclusiveMaximumKeyword,
  oas30ExclusiveMinimumKeyword,
  oas30MaximumKeyword,
  oas30MinimumKeyword,
  oas30NullableKeyword,
  oas30TypeKeyword,
} from "./keywords/oas30.js";
export {
  maxPropertiesKeyword,
  minPropertiesKeyword,
  requiredKeyword,
} from "./keywords/object-validation.js";
export {
  additionalPropertiesKeyword,
  patternPropertiesKeyword,
  propertiesKeyword,
  propertyNamesKeyword,
} from "./keywords/properties.js";
export {
  anchorKeyword,
  commentKeyword,
  defsKeyword,
  dynamicAnchorKeyword,
  dynamicRefKeyword,
  idKeyword,
  refKeyword,
  schemaDialectKeyword,
} from "./keywords/ref.js";
export {
  formatAssertionKeyword,
  formatKeyword,
  maxLengthKeyword,
  minLengthKeyword,
  patternKeyword,
} from "./keywords/string.js";
export { typeKeyword } from "./keywords/type.js";
export { discriminatorKeyword } from "./keywords/discriminator.js";
export { unevaluatedItemsKeyword, unevaluatedPropertiesKeyword } from "./keywords/unevaluated.js";

// Ref resolution: needed by `@oaverify/internal-validator` and any consumer wiring
// up a custom spec loader. The lower-level `SchemaRegistry` /
// `collectDynamicAnchors` primitives are in `./internals`.
export {
  createRefResolver,
  resolve,
  type RefResolver,
  type ResolvedGraph,
  type ResolveOptions,
} from "./resolve/index.js";

// Generic subschema walk: intended for linters / introspection /
// tooling. For rewriting use cases, the raw `SUBSCHEMA_*_POSITIONS`
// constants are in `./internals`.
export { walkSubschemas, type SubschemaVisitor } from "./subschema-positions.js";

// Keyword introspection: enumerate the built-in keyword set (with its
// classification flags) for a dialect. Reads keyword metadata; pairs
// with `schemaUsesUnevaluated` (above) and `walkSubschemas`.
export { keywordDefinitions } from "./introspection.js";
