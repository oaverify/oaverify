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

/**
 * Positions holding a `string -> ...` map whose values are a subschema
 * for some entries and something else for others.
 *
 * `dependencies` (draft-07, still accepted under a 2020-12 dialect) is
 * the only one: an array value carries `dependentRequired` semantics
 * and names properties, an object or boolean value is a subschema. So
 * `{ "a": ["b"], "c": { "type": "string" } }` is one map with an entry
 * of each kind.
 *
 * Kept out of {@link SUBSCHEMA_MAP_POSITIONS} rather than added to it,
 * because that set promises every value is a subschema and callers rely
 * on the promise: `assertWellFormedSchema` rejects a value there that
 * is not an object, which would refuse the legal array form, and the
 * validator's direction transform would rewrite `["b"]` as though it
 * were a schema.
 *
 * A caller walking these must test each value and skip the arrays.
 *
 * @internal
 */
export const SUBSCHEMA_MIXED_MAP_POSITIONS = ["dependencies"] as const;

/**
 * Every key in the three uniform sets above, for membership tests.
 *
 * Deliberately excludes {@link SUBSCHEMA_MIXED_MAP_POSITIONS}; see
 * {@link isSubschemaKey}.
 */
const ALL_SUBSCHEMA_KEYS: ReadonlySet<string> = new Set<string>([
  ...SUBSCHEMA_SINGLE_POSITIONS,
  ...SUBSCHEMA_ARRAY_POSITIONS,
  ...SUBSCHEMA_MAP_POSITIONS,
]);

/**
 * Is every value at `key` a subschema, rather than arbitrary data?
 *
 * False for a mixed position: `dependencies` holds a subschema at some
 * entries and an array of property names at others, so a caller cannot
 * act on the key alone and has to look at each value. Answering `true`
 * here would hand that caller the wrong answer for half the entries,
 * which is worse than not answering. See
 * {@link SUBSCHEMA_MIXED_MAP_POSITIONS}.
 *
 * @internal
 */
export function isSubschemaKey(key: string): boolean {
  return ALL_SUBSCHEMA_KEYS.has(key);
}
