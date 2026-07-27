/**
 * The keyword classification table: every built-in keyword's category,
 * which drives how the classifier folds it into a node's streaming
 * strategy. Keyed off `@oaverify/internal-schema`'s keyword identity.
 *
 * A CI drift test (keyword-drift.test.ts) asserts every keyword
 * `@oaverify/internal-schema` registers (across the JSON Schema and OpenAPI dialects)
 * has an entry here, so a new keyword cannot land upstream without the
 * engine consciously classifying it. The runtime compile path has its
 * own backstop: an unrecognized keyword in a schema is a REJECT, never a
 * silent pass (see classify.ts).
 *
 * @packageDocumentation
 */

/**
 * How a keyword contributes to its schema node's strategy.
 *
 *   - `scalar`: a forward, no-subschema constraint (`type`, `pattern`,
 *     numeric / length / count bounds, `required`, ...). STREAM.
 *   - `value-equality`: `enum` / `const`. STREAM when every candidate is
 *     a scalar; BUFFER when any is an object/array (exact equality needs
 *     materialization).
 *   - `member`: a per-property / per-item applicator (`properties`,
 *     `items`, `additionalProperties`, ...). Each applied subschema is
 *     classified at its own position; a BUFFER child materializes just
 *     that subtree and does NOT force the enclosing scope to buffer.
 *   - `contains`: STREAM when the contained predicate is forward; BUFFER
 *     when it is not (each item must be materialized and tested).
 *   - `composition`: `allOf` / `anyOf` / `oneOf` / `not` / `if`. TEE when
 *     every branch is forward; BUFFER when a branch is not (or under
 *     parity mode for `anyOf` / `oneOf`).
 *   - `buffer`: always materializes (`dependentSchemas`, `discriminator`:
 *     a late trigger key can constrain content already streamed past).
 *   - `dependencies`: draft-07 compat; an array entry behaves like
 *     `dependentRequired` (STREAM), a schema entry like
 *     `dependentSchemas` (BUFFER).
 *   - `ref`: `$ref` / `$dynamicRef`. The node takes the joined strategy
 *     of its target's ref cycle (SCC fixpoint).
 *   - `annotation`: no runtime assertion (`title`, `$defs`, `$id`,
 *     `content*`, ...). No effect on strategy.
 *   - `reject`: cannot be soundly streamed (`unevaluatedProperties` /
 *     `unevaluatedItems`, which need the cross-applicator merged
 *     evaluated-key set). A compile-time REJECT.
 *
 * @public
 */
export type KeywordCategory =
  | "scalar"
  | "value-equality"
  | "member"
  | "contains"
  | "composition"
  | "buffer"
  | "dependencies"
  | "ref"
  | "annotation"
  | "reject";

/**
 * Built-in keyword name -> {@link KeywordCategory}. Covers the JSON
 * Schema 2020-12, OpenAPI 3.1/3.2, and OpenAPI 3.0 keyword sets. Keywords
 * folded into another by `implements` (`minContains` / `maxContains` into
 * `contains`; `then` / `else` into `if`) are not listed: they never
 * dispatch on their own, so `@oaverify/internal-schema` does not register them
 * independently.
 *
 * @public
 */
export const KEYWORD_CATEGORY: Readonly<Record<string, KeywordCategory>> = {
  // Forward scalar constraints.
  type: "scalar",
  format: "scalar",
  pattern: "scalar",
  minLength: "scalar",
  maxLength: "scalar",
  minimum: "scalar",
  maximum: "scalar",
  exclusiveMinimum: "scalar",
  exclusiveMaximum: "scalar",
  multipleOf: "scalar",
  minItems: "scalar",
  maxItems: "scalar",
  minProperties: "scalar",
  maxProperties: "scalar",
  required: "scalar",
  dependentRequired: "scalar",
  // Forward-decidable for classification, but the spine materializes a
  // uniqueItems array (canonical hashing of items is not yet streamed).
  uniqueItems: "scalar",
  // OAS 3.0 `nullable` is folded into a `type` union by the dialect
  // normalization pass before classification; a forward type modifier.
  nullable: "scalar",

  // Value equality.
  enum: "value-equality",
  const: "value-equality",

  // Per-member / per-item applicators.
  properties: "member",
  patternProperties: "member",
  additionalProperties: "member",
  propertyNames: "member",
  items: "member",
  prefixItems: "member",

  // Array membership predicate.
  contains: "contains",

  // Composition.
  allOf: "composition",
  anyOf: "composition",
  oneOf: "composition",
  not: "composition",
  if: "composition",

  // Always-buffer applicators.
  dependentSchemas: "buffer",
  discriminator: "buffer",

  // draft-07 compatibility.
  dependencies: "dependencies",

  // References.
  $ref: "ref",
  $dynamicRef: "ref",

  // Annotations / metadata / structural-only (no runtime assertion).
  $anchor: "annotation",
  $dynamicAnchor: "annotation",
  $comment: "annotation",
  $defs: "annotation",
  $id: "annotation",
  $schema: "annotation",
  title: "annotation",
  description: "annotation",
  default: "annotation",
  deprecated: "annotation",
  readOnly: "annotation",
  writeOnly: "annotation",
  example: "annotation",
  examples: "annotation",
  externalDocs: "annotation",
  xml: "annotation",
  contentEncoding: "annotation",
  contentMediaType: "annotation",
  contentSchema: "annotation",

  // Not soundly streamable.
  unevaluatedProperties: "reject",
  unevaluatedItems: "reject",
};
