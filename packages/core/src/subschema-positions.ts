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
 * ## Which export a walker should reach for
 *
 * {@link subschemaEntries} to visit, {@link forEachSubschema} on a hot
 * path, {@link transformSubschemaValue} to rewrite,
 * {@link subschemaFamilyOf} to classify a key the walker is already
 * holding. Not the position constants: consuming those means one loop
 * per family, and omitting a loop is invisible. Four walkers in two
 * packages wrote three loops and omitted the fourth, which cost a
 * validation bypass (`readOnly` unenforced under `dependencies`) among
 * other defects. `scripts/check-subschema-walkers.mjs` now fails the
 * build on a direct use, with the exemptions stated there.
 *
 * @packageDocumentation
 */

import { setSpecKey } from "./own-key.js";
import type { SchemaOrBoolean } from "./types.js";

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
 * Being excluded from {@link isSubschemaKey} has a consequence worth
 * stating: a caller that decides "is this a schema position" from that
 * predicate alone does not reach these entries. `packages/spec`'s two
 * resolvers do, so an external `$ref` written inside `dependencies` is
 * not hoisted and the document it names is never loaded. That gap
 * predates this set and is not closed by it; closing it means teaching
 * those resolvers the mixed shape, since the predicate cannot answer
 * for a position whose values disagree with each other.
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

/**
 * Which shape a subschema position holds its subschemas in.
 *
 * A walker cannot act on a position without knowing this: `not` holds
 * one schema, `allOf` an array, `properties` a map, and `dependencies`
 * a map whose values disagree with each other.
 *
 * @internal
 */
export type SubschemaFamily = "single" | "array" | "map" | "mixed-map";

const FAMILY_BY_KEY: ReadonlyMap<string, SubschemaFamily> = new Map<string, SubschemaFamily>([
  ...SUBSCHEMA_SINGLE_POSITIONS.map((k) => [k, "single"] as const),
  ...SUBSCHEMA_ARRAY_POSITIONS.map((k) => [k, "array"] as const),
  ...SUBSCHEMA_MAP_POSITIONS.map((k) => [k, "map"] as const),
  ...SUBSCHEMA_MIXED_MAP_POSITIONS.map((k) => [k, "mixed-map"] as const),
]);

/**
 * The family `key` holds subschemas in, or `undefined` if it holds no
 * subschemas at all.
 *
 * Unlike {@link isSubschemaKey} this answers for a mixed position, and
 * says which kind it is, so the caller knows it has to test each value.
 * A key-driven walker (one iterating the schema's own keys rather than
 * the position table) classifies with this instead of hand-writing a
 * set. The two `packages/spec` resolvers still hand-write one, in the
 * 5th and 6th copy of this knowledge; they are the intended next
 * caller, and until they move the gap described on
 * {@link SUBSCHEMA_MIXED_MAP_POSITIONS} stays open.
 *
 * @internal
 */
export function subschemaFamilyOf(key: string): SubschemaFamily | undefined {
  return FAMILY_BY_KEY.get(key);
}

/**
 * One subschema found inside a schema object, with where it sat.
 *
 * @internal
 */
export interface SubschemaEntry {
  /** The position key, e.g. `"allOf"` or `"dependencies"`. */
  key: string;
  family: SubschemaFamily;
  value: SchemaOrBoolean;
  /**
   * Index within an array position, or the property name within a map
   * position. Absent for a single position, which has no sub-address.
   */
  at?: string | number;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every subschema held directly by `schema`, one level down.
 *
 * This is the iteration a walker should use instead of looping the
 * position constants itself. Looping them is how a family gets missed:
 * four walkers in two packages each wrote a loop per family and each
 * omitted {@link SUBSCHEMA_MIXED_MAP_POSITIONS}, so a `readOnly`
 * property declared under `dependencies` was never enforced on the
 * request leg. Adding a fifth family here reaches every caller at once.
 *
 * `packages/spec`'s two resolvers are the one walker class this does
 * not yet reach: they classify by {@link isSubschemaKey}, which cannot
 * answer for a mixed position, so an external `$ref` under
 * `dependencies` is still not hoisted. See that predicate.
 *
 * The mixed-map rule lives here rather than at each call site: an array
 * value under `dependencies` names required properties and is not a
 * subschema, so it is skipped and never yielded.
 *
 * Yields nothing for a boolean schema or a non-object, which have no
 * positions to hold anything.
 *
 * Eager despite being a generator: it collects the whole node before
 * yielding, so a caller that stops early has already paid for the rest,
 * and one that mutates the node mid-iteration sees the snapshot. Use
 * {@link forEachSubschema} where either matters.
 *
 * @internal
 */
export function* subschemaEntries(schema: unknown): Generator<SubschemaEntry> {
  const out: SubschemaEntry[] = [];
  forEachSubschema(schema, (value, key, family, at) => {
    out.push(at === undefined ? { key, family, value } : { key, family, value, at });
  });
  yield* out;
}

/**
 * {@link subschemaEntries} without the per-entry object: the callback
 * receives the same four values as positional arguments.
 *
 * This is the form the compile path uses. `resolve`, the `unevaluated*`
 * and `$dynamicRef` pre-scans and `walkSubschemas` all walk every node
 * of every schema being compiled, so one generator plus one entry
 * object per subschema is measurable there: moving those callers to the
 * generator form and then to this one took `compileSchema` on a 4-wide,
 * 5-deep synthetic schema from 74.7ms to 90.8ms and back to 78.8ms
 * (best of 15, one machine, not a tracked benchmark). Prefer
 * {@link subschemaEntries} anywhere that is not hot; both dispatch on
 * the same table, so neither can miss a position family the other
 * reaches.
 *
 * Returning `false` from `visit` stops the walk, which is what lets a
 * predicate stop at its first hit rather than finishing the node.
 *
 * @internal
 */
export function forEachSubschema(
  schema: unknown,
  visit: (
    value: SchemaOrBoolean,
    key: string,
    family: SubschemaFamily,
    at?: string | number,
  ) => void | boolean,
): void {
  if (!isSchemaObject(schema)) return;

  for (const [key, family] of FAMILY_BY_KEY) {
    if (!Object.hasOwn(schema, key)) continue;
    const value = schema[key];

    switch (family) {
      case "single": {
        if (value === undefined) break;
        if (visit(value as SchemaOrBoolean, key, family) === false) return;
        break;
      }
      case "array": {
        if (!Array.isArray(value)) break;
        for (const [index, sub] of value.entries()) {
          // A hole (`[, {}]`) or an explicit `undefined` is not a
          // subschema; see the map branch below.
          if (sub === undefined) continue;
          if (visit(sub as SchemaOrBoolean, key, family, index) === false) return;
        }
        break;
      }
      case "map": {
        if (!isSchemaObject(value)) break;
        for (const [name, sub] of Object.entries(value)) {
          // A hole in the map is not a subschema. Passing it on would
          // hand every caller an `undefined` where it expects a schema.
          if (sub === undefined) continue;
          if (visit(sub as SchemaOrBoolean, key, family, name) === false) return;
        }
        break;
      }
      case "mixed-map": {
        if (!isSchemaObject(value)) break;
        for (const [name, sub] of Object.entries(value)) {
          // An array here names required properties (`dependentRequired`
          // semantics) and holds no schema to visit.
          if (sub === undefined || Array.isArray(sub)) continue;
          if (visit(sub as SchemaOrBoolean, key, family, name) === false) return;
        }
        break;
      }
    }
  }
}

/**
 * Rebuild the value sitting at a subschema position, applying
 * `transform` to each subschema inside it and preserving the position's
 * shape.
 *
 * The counterpart to {@link subschemaEntries} for a walker that rewrites
 * a schema rather than visiting it (the validator's direction transform,
 * the stream validator's OAS 3.0 normalizer). Both need the same family
 * dispatch, and neither should re-derive which shape a key holds.
 *
 * An array entry under a mixed position is returned as written: it names
 * property names, and rewriting it as though it were a schema is exactly
 * the corruption {@link SUBSCHEMA_MIXED_MAP_POSITIONS} warns about.
 *
 * Map keys come from spec content, so they are written back with
 * {@link setSpecKey} rather than a plain assignment.
 *
 * @internal
 */
export function transformSubschemaValue(
  family: SubschemaFamily,
  value: unknown,
  transform: (sub: SchemaOrBoolean, at?: string | number) => SchemaOrBoolean,
): unknown {
  switch (family) {
    case "single":
      return value === undefined ? value : transform(value as SchemaOrBoolean);
    case "array":
      return Array.isArray(value)
        ? value.map((sub, index) => transform(sub as SchemaOrBoolean, index))
        : value;
    case "map":
    case "mixed-map": {
      if (!isSchemaObject(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        // Under a mixed position an array entry is a property-name list,
        // not a schema; it passes through untouched.
        const keep = family === "mixed-map" && Array.isArray(sub);
        setSpecKey(out, name, keep ? sub : transform(sub as SchemaOrBoolean, name));
      }
      return out;
    }
  }
}
