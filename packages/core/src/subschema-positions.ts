/**
 * Which keys of a Schema Object hold subschemas, as pure data.
 *
 * Lives in `core` because three packages need to walk schemas without
 * descending into arbitrary user data: the compiler (`walkSubschemas`,
 * schema lint), the validator (the direction transform and the
 * document-level example check), and the spec resolver (which hoists
 * external schema targets and must know where a schema position is).
 * One copy means a keyword added to the language cannot be picked up by
 * one walker and missed by another.
 *
 * The distinction these encode is the whole point: `properties` holds
 * subschemas, `default` and `examples` hold whatever the author wrote.
 * A walker that cannot tell them apart will happily descend into an
 * example value and interpret a `$ref` key inside it as a reference.
 *
 * @packageDocumentation
 */

/**
 * Known JSON Schema 2020-12 (+ OpenAPI) positions that hold a single
 * subschema.
 *
 * @internal
 */
export const SUBSCHEMA_SINGLE_POSITIONS = [
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "items",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

/**
 * Known JSON Schema 2020-12 positions that hold an array of subschemas.
 *
 * @internal
 */
export const SUBSCHEMA_ARRAY_POSITIONS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/**
 * Known JSON Schema 2020-12 positions that hold a `string -> subschema`
 * map. Callers that treat `properties` specially (e.g. the validator's
 * direction transform) filter it out themselves; it is included here so
 * generic walkers see the complete set of schema positions.
 *
 * @internal
 */
export const SUBSCHEMA_MAP_POSITIONS = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
] as const;

/** Every key in the three sets above, for membership tests. */
const ALL_SUBSCHEMA_KEYS: ReadonlySet<string> = new Set<string>([
  ...SUBSCHEMA_SINGLE_POSITIONS,
  ...SUBSCHEMA_ARRAY_POSITIONS,
  ...SUBSCHEMA_MAP_POSITIONS,
]);

/**
 * Does `key` hold a subschema (or subschemas) rather than arbitrary
 * data?
 *
 * @internal
 */
export function isSubschemaKey(key: string): boolean {
  return ALL_SUBSCHEMA_KEYS.has(key);
}
