import type { SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * Known JSON Schema 2020-12 (+ OpenAPI) positions that hold a single
 * subschema. Used by any tree-walker that needs to descend only through
 * schema-valued fields, not arbitrary user data in `enum` / `const` /
 * `default` / `examples`.
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
 * map. Callers that treat `properties` specially (e.g. validator's
 * direction transform) should filter it out themselves; it's included
 * here so generic walkers see the complete set of schema positions.
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
 * Visitor callback shape for {@link walkSubschemas}. Receives each
 * visited subschema plus the dotted-path string leading to it (relative
 * to the walk root; empty string for the root itself). Returning
 * `false` from the visitor prunes the subtree; any other value (or
 * `void`) continues the walk.
 *
 * @public
 */
export type SubschemaVisitor = (schema: SchemaOrBoolean, path: string) => void | boolean;

/**
 * Walk every subschema reachable from `root`, in pre-order, descending
 * through every schema-valued key the JSON Schema 2020-12 vocabulary
 * (plus the keys OpenAPI adds on top) declares. Boolean schemas and
 * `$ref` nodes are visited but not descended.
 *
 * Intended for tooling (linters, introspection, tree rewriters) that
 * would otherwise re-derive the set of schema-valued keys and risk
 * drifting from the vocabulary. Callers that need to *rewrite* schemas
 * in place can instead reach for the underlying
 * `SUBSCHEMA_*_POSITIONS` constants exported from
 * `@oaverify/core/schema/internals`.
 *
 * @public
 */
export function walkSubschemas(root: SchemaOrBoolean, visit: SubschemaVisitor): void {
  const go = (node: SchemaOrBoolean, path: string): void => {
    const keep = visit(node, path);
    if (keep === false) return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    for (const k of SUBSCHEMA_SINGLE_POSITIONS) {
      const v = n[k];
      if (v !== undefined) go(v as SchemaOrBoolean, path === "" ? k : `${path}.${k}`);
    }
    for (const k of SUBSCHEMA_ARRAY_POSITIONS) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i += 1) {
          go(v[i] as SchemaOrBoolean, path === "" ? `${k}[${i}]` : `${path}.${k}[${i}]`);
        }
      }
    }
    for (const k of SUBSCHEMA_MAP_POSITIONS) {
      const v = n[k];
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          go(vv as SchemaOrBoolean, path === "" ? `${k}.${kk}` : `${path}.${k}.${kk}`);
        }
      }
    }
  };
  go(root, "");
}
