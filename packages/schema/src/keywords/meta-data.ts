/**
 * The JSON Schema 2020-12 Meta-Data vocabulary. These keywords are
 * annotation-only: they carry human- or tool-facing metadata and emit
 * no runtime validation code. Registering them as first-class keyword
 * definitions (rather than tolerating them as unknown keys) gives the
 * compiler a single source of truth for the set, which the subschema
 * inliner and any future introspection consult via the shared
 * `annotation: true` flag.
 */

import { CONTENT_VOCAB, META_DATA_VOCAB, OPENAPI_META_DATA_VOCAB } from "./vocabulary-uris.js";
import type { KeywordDefinition } from "./types.js";

/**
 * `valueType` declares the type the keyword's value must have. Reported
 * through `schemaLint`, not well-formedness: a mistyped annotation
 * cannot change what the validator accepts, so it must not block
 * construction. See {@link KeywordDefinition.annotationValueType}.
 *
 * Omitted where any value is legal (`default`, `example`), which is a
 * statement about the keyword, not an omission. `examples` is not in
 * that group: its *members* are unconstrained, but 2020-12 requires the
 * keyword itself to hold an array.
 */
function annotationKeyword(
  name: string,
  vocabulary: string = META_DATA_VOCAB,
  valueType?: "string" | "boolean" | "object" | "array",
): KeywordDefinition {
  return {
    keyword: name,
    vocabulary,
    annotation: true,
    ...(valueType === undefined ? {} : { annotationValueType: valueType }),
    compile(): void {
      // intentionally empty: pure annotation
    },
  };
}

/**
 * `title`: a short human-readable label for the schema. Annotation-
 * only; emits no validation code. Bundled into
 * {@link metaDataVocabulary} and reachable alongside it from
 * `@oaverify/core/schema`.
 *
 * @public
 */
export const titleKeyword = annotationKeyword("title", META_DATA_VOCAB, "string");

/**
 * `description`: a longer human-readable explanation of the schema.
 * Annotation-only; emits no validation code. Pair with
 * {@link titleKeyword} for tooling that displays a label plus details.
 *
 * @public
 */
export const descriptionKeyword = annotationKeyword("description", META_DATA_VOCAB, "string");

/**
 * `default`: a suggested default value for the schema. Preserved as
 * metadata only; oaverify never injects defaults into request bodies or
 * response bodies (see the `useDefaults` discussion in
 * [`docs/comparison.md`](../../../../docs/comparison.md) if you need that behavior).
 *
 * @public
 */
export const defaultKeyword = annotationKeyword("default");

/**
 * `deprecated`: marks a schema (most often a single property) as
 * deprecated. Annotation-only: deprecated values are not rejected at
 * runtime. Tooling and generated clients use it to surface warnings.
 *
 * @public
 */
export const deprecatedKeyword = annotationKeyword("deprecated", META_DATA_VOCAB, "boolean");

/**
 * `readOnly`: flags a property the client MUST NOT send on request
 * bodies. Annotation-only inside the schema compiler; the validator's
 * request-side body transform consults it and rewrites such properties
 * to `false` on request-direction schemas. Companion to
 * {@link writeOnlyKeyword}.
 *
 * @public
 */
export const readOnlyKeyword = annotationKeyword("readOnly", META_DATA_VOCAB, "boolean");

/**
 * `writeOnly`: flags a property the server MUST NOT send on response
 * bodies. Annotation-only inside the schema compiler; the validator's
 * response-side body transform consults it and rewrites such properties
 * to `false` on response-direction schemas. Companion to
 * {@link readOnlyKeyword}.
 *
 * @public
 */
export const writeOnlyKeyword = annotationKeyword("writeOnly", META_DATA_VOCAB, "boolean");

/**
 * `examples`: an array of example values the schema author supplies
 * for documentation and tooling. Annotation-only; emits no validation
 * code. Supersedes OpenAPI 3.0's singular {@link exampleKeyword}.
 *
 * The members are unconstrained, but 2020-12 requires the keyword to
 * hold an array, so a non-array value is reported through `schemaLint`.
 * The shape that hits this in practice is a 3.0 Example Object map
 * (`examples: { name: { value: ... } }`) left unconverted in a document
 * upgraded to 3.1: inert, since nothing reading 2020-12 `examples` will
 * ever see those values, and invisible to the document meta-schema,
 * which stubs the Schema Object from 3.1 on (#555).
 *
 * @public
 */
export const examplesKeyword = annotationKeyword("examples", META_DATA_VOCAB, "array");

/**
 * OpenAPI-specific annotation: `example` (singular). Deprecated in
 * favor of `examples` per OpenAPI 3.1, still widely used in 3.0 specs.
 *
 * @public
 */
export const exampleKeyword = annotationKeyword("example", OPENAPI_META_DATA_VOCAB);

/**
 * OpenAPI Schema Object's `xml` annotation. Describes how a property
 * serialises to XML (element name, namespace, attribute placement).
 * Annotation-only for JSON validation; oaverify doesn't emit XML.
 * Spec-defined on the OpenAPI Schema Object across 3.0 / 3.1 / 3.2.
 *
 * @public
 */
export const xmlKeyword = annotationKeyword("xml", OPENAPI_META_DATA_VOCAB, "object");

/**
 * OpenAPI Schema Object's `externalDocs` annotation: pointer to
 * additional external documentation for this schema. Annotation-only.
 * Spec-defined fixed field on the Schema Object across 3.0 / 3.1 / 3.2.
 *
 * @public
 */
export const externalDocsKeyword = annotationKeyword(
  "externalDocs",
  OPENAPI_META_DATA_VOCAB,
  "object",
);

/**
 * JSON Schema 2020-12 `contentEncoding`: declares the encoding (e.g.
 * `base64`) used for a string value. The spec marks the content
 * vocabulary as not required to validate; oaverify treats it as
 * annotation-only.
 *
 * @public
 */
export const contentEncodingKeyword = annotationKeyword("contentEncoding", CONTENT_VOCAB, "string");

/**
 * JSON Schema 2020-12 `contentMediaType`: declares the media type
 * (e.g. `application/jwt`) of a string value's content. Annotation-only
 * companion to {@link contentEncodingKeyword}.
 *
 * @public
 */
export const contentMediaTypeKeyword = annotationKeyword(
  "contentMediaType",
  CONTENT_VOCAB,
  "string",
);

/**
 * JSON Schema 2020-12 `contentSchema`: schema describing the structure
 * of decoded content (after applying `contentEncoding` and parsing
 * `contentMediaType`). Annotation-only; oaverify doesn't decode + re-validate.
 *
 * @public
 */
export const contentSchemaKeyword = annotationKeyword("contentSchema", CONTENT_VOCAB);
