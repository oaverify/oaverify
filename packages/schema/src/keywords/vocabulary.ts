import { maxItemsKeyword, minItemsKeyword, uniqueItemsKeyword } from "./array-validation.js";
import {
  allOfKeyword,
  anyOfKeyword,
  dependenciesKeyword,
  dependentRequiredKeyword,
  dependentSchemasKeyword,
  ifThenElseKeyword,
  notKeyword,
  oneOfKeyword,
} from "./composition.js";
import { constKeyword, enumKeyword } from "./equality.js";
import { containsKeyword, itemsKeyword, prefixItemsKeyword } from "./items.js";
import {
  exclusiveMaximumKeyword,
  exclusiveMinimumKeyword,
  maximumKeyword,
  minimumKeyword,
  multipleOfKeyword,
} from "./number.js";
import {
  maxPropertiesKeyword,
  minPropertiesKeyword,
  requiredKeyword,
} from "./object-validation.js";
import {
  additionalPropertiesKeyword,
  patternPropertiesKeyword,
  propertiesKeyword,
  propertyNamesKeyword,
} from "./properties.js";
import {
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
} from "./meta-data.js";
import {
  anchorKeyword,
  commentKeyword,
  defsKeyword,
  dynamicAnchorKeyword,
  dynamicRefKeyword,
  idKeyword,
  refKeyword,
  schemaDialectKeyword,
} from "./ref.js";
import { discriminatorKeyword } from "./discriminator.js";
import { unevaluatedItemsKeyword, unevaluatedPropertiesKeyword } from "./unevaluated.js";
import {
  oas30ExclusiveMaximumKeyword,
  oas30ExclusiveMinimumKeyword,
  oas30MaximumKeyword,
  oas30MinimumKeyword,
  oas30NullableKeyword,
  oas30TypeKeyword,
} from "./oas30.js";
import {
  formatAssertionKeyword,
  formatKeyword,
  maxLengthKeyword,
  minLengthKeyword,
  patternKeyword,
} from "./string.js";
import { typeKeyword } from "./type.js";
import type { Dialect, Vocabulary } from "./types.js";
export type { Dialect, DialectRules } from "./types.js";
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
} from "./vocabulary-uris.js";
import {
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
} from "./vocabulary-uris.js";

/**
 * The JSON Schema 2020-12 core vocabulary: `$ref`, `$dynamicRef`, `$id`,
 * `$defs`, anchors, etc. No runtime behavior except `$ref` / `$dynamicRef`.
 *
 * @public
 */
export const coreVocabulary: Vocabulary = {
  uri: CORE_VOCAB,
  keywords: [
    refKeyword,
    dynamicRefKeyword,
    anchorKeyword,
    dynamicAnchorKeyword,
    idKeyword,
    defsKeyword,
    schemaDialectKeyword,
    commentKeyword,
  ],
};

/**
 * The built-in validation vocabulary: `type`, `enum`, `const`, numeric
 * bounds, string bounds, array bounds, and `required`. Applicator keywords
 * live in a separate vocabulary.
 *
 * @public
 */
export const validationVocabulary: Vocabulary = {
  uri: CORE_VALIDATION_VOCAB,
  keywords: [
    typeKeyword,
    enumKeyword,
    constKeyword,
    multipleOfKeyword,
    maximumKeyword,
    exclusiveMaximumKeyword,
    minimumKeyword,
    exclusiveMinimumKeyword,
    maxLengthKeyword,
    minLengthKeyword,
    patternKeyword,
    maxItemsKeyword,
    minItemsKeyword,
    uniqueItemsKeyword,
    maxPropertiesKeyword,
    minPropertiesKeyword,
    requiredKeyword,
  ],
};

/**
 * The built-in applicator vocabulary: composition keywords that recurse into
 * subschemas.
 *
 * @public
 */
export const applicatorVocabulary: Vocabulary = {
  uri: APPLICATOR_VOCAB,
  keywords: [
    discriminatorKeyword,
    allOfKeyword,
    anyOfKeyword,
    oneOfKeyword,
    notKeyword,
    ifThenElseKeyword,
    dependentSchemasKeyword,
    dependentRequiredKeyword,
    dependenciesKeyword,
    prefixItemsKeyword,
    itemsKeyword,
    containsKeyword,
    propertiesKeyword,
    patternPropertiesKeyword,
    additionalPropertiesKeyword,
    propertyNamesKeyword,
  ],
};

/**
 * The built-in unevaluated vocabulary: `unevaluatedProperties` /
 * `unevaluatedItems`.
 *
 * @public
 */
export const unevaluatedVocabulary: Vocabulary = {
  uri: UNEVALUATED_VOCAB,
  keywords: [unevaluatedPropertiesKeyword, unevaluatedItemsKeyword],
};

/**
 * The built-in format-annotation vocabulary. Non-assertive per the spec
 * default; use {@link formatAssertionVocabulary} to make `format`
 * actually reject data.
 *
 * @public
 */
export const formatVocabulary: Vocabulary = {
  uri: FORMAT_VOCAB,
  keywords: [formatKeyword],
};

/**
 * Opt-in format-assertion vocabulary. Place BEFORE {@link formatVocabulary}
 * in the vocabularies list so its assertive `format` keyword wins keyword
 * dispatch.
 *
 * @public
 */
export const formatAssertionVocabulary: Vocabulary = {
  uri: FORMAT_ASSERTION_VOCAB,
  keywords: [formatAssertionKeyword],
};

/**
 * The JSON Schema 2020-12 Meta-Data vocabulary. Pure annotations: these
 * keywords carry human- and tool-facing metadata and never reject data.
 * Registering them explicitly gives the compiler's inliner a single,
 * dialect-scoped source of truth for "which keys are safe to ignore".
 *
 * @public
 */
export const metaDataVocabulary: Vocabulary = {
  uri: META_DATA_VOCAB,
  keywords: [
    titleKeyword,
    descriptionKeyword,
    defaultKeyword,
    deprecatedKeyword,
    readOnlyKeyword,
    writeOnlyKeyword,
    examplesKeyword,
  ],
};

/**
 * OpenAPI-specific annotations layered on top of
 * {@link metaDataVocabulary}. Carries the singular `example`
 * (deprecated in 3.1 but widely used), `xml` (XML serialisation hints
 * on Schema Objects), and `externalDocs` (pointer to external docs).
 * All annotation-only.
 *
 * @public
 */
export const openapiMetaDataVocabulary: Vocabulary = {
  uri: OPENAPI_META_DATA_VOCAB,
  keywords: [exampleKeyword, xmlKeyword, externalDocsKeyword],
};

/**
 * The JSON Schema 2020-12 Content vocabulary: `contentEncoding`,
 * `contentMediaType`, `contentSchema`. The spec marks the content
 * vocabulary as not required to validate; oaverify treats all three as
 * pure annotations so schemas using them lint clean in strict mode.
 *
 * @public
 */
export const contentVocabulary: Vocabulary = {
  uri: CONTENT_VOCAB,
  keywords: [contentEncodingKeyword, contentMediaTypeKeyword, contentSchemaKeyword],
};

/**
 * The three default vocabularies (validation + applicator +
 * format-annotation) in the order the compiler expects. Consumers
 * normally pick a full {@link Dialect} instead; see
 * {@link jsonSchemaDialect}, {@link openapi31Dialect}, and
 * {@link oas30Dialect}.
 *
 * @public
 */
export const defaultVocabularies: readonly Vocabulary[] = [
  coreVocabulary,
  validationVocabulary,
  applicatorVocabulary,
  unevaluatedVocabulary,
  formatVocabulary,
  metaDataVocabulary,
  contentVocabulary,
];

/**
 * The OpenAPI 3.0 vocabulary overrides.
 *
 * Placed AHEAD of the standard validation + applicator vocabularies
 * in a 3.0 compile so its flavours of `type`, `maximum`, `minimum`,
 * and the modifier keywords (`nullable`, `exclusiveMaximum`,
 * `exclusiveMinimum`) win keyword dispatch over the 2020-12 variants.
 *
 * @public
 */
export const oas30Vocabulary: Vocabulary = {
  uri: OAS30_VOCAB,
  keywords: [
    oas30TypeKeyword,
    oas30NullableKeyword,
    oas30MaximumKeyword,
    oas30MinimumKeyword,
    oas30ExclusiveMaximumKeyword,
    oas30ExclusiveMinimumKeyword,
  ],
};

/**
 * JSON Schema 2020-12 dialect. `format` is treated as an annotation
 * (non-assertive) per the spec default.
 *
 * @public
 */
export const jsonSchemaDialect: Dialect = {
  id: "jsonSchema2020-12",
  vocabularies: defaultVocabularies,
  rules: { refSuppressesSiblings: false },
};

/**
 * OpenAPI 3.1 / 3.2 dialect. Uses the 2020-12 vocabulary stack with
 * `format` promoted to assertion (OpenAPI semantics).
 *
 * @public
 */
export const openapi31Dialect: Dialect = {
  id: "openapi3.1",
  vocabularies: [
    coreVocabulary,
    validationVocabulary,
    applicatorVocabulary,
    unevaluatedVocabulary,
    formatAssertionVocabulary,
    formatVocabulary,
    metaDataVocabulary,
    openapiMetaDataVocabulary,
    contentVocabulary,
  ],
  rules: { refSuppressesSiblings: false },
};

/**
 * OpenAPI 3.0 dialect. Uses the OAS 3.0 keyword flavours (string-only
 * `type` with sibling `nullable`, boolean `exclusiveMaximum` /
 * `exclusiveMinimum`) and the `$ref`-suppresses-siblings rule.
 * `unevaluatedProperties` / `unevaluatedItems` are not present in 3.0
 * so the unevaluated vocabulary is omitted.
 *
 * @public
 */
export const oas30Dialect: Dialect = {
  id: "oas3.0",
  vocabularies: [
    coreVocabulary,
    oas30Vocabulary,
    validationVocabulary,
    applicatorVocabulary,
    formatAssertionVocabulary,
    formatVocabulary,
    metaDataVocabulary,
    openapiMetaDataVocabulary,
    contentVocabulary,
  ],
  rules: { refSuppressesSiblings: true },
};
