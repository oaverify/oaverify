/**
 * OpenAPI 3.0 -> JSON Schema 2020-12 normalization.
 *
 * The classifier and spine work on a 2020-12-shaped schema. OpenAPI 3.1
 * and 3.2 are 2020-12-native and need no rewrite; OpenAPI 3.0 uses a
 * constrained dialect with three deviations this pass rewrites (mirroring
 * `@oaverify/internal-schema`'s `oas30Dialect` semantics, so the streaming verdict
 * matches the in-memory one):
 *
 *   1. `nullable: true` widens `type: "X"` to `type: ["X", "null"]`.
 *   2. boolean `exclusiveMaximum` / `exclusiveMinimum` fold into the
 *      2020-12 numeric form (`exclusiveMaximum: <the maximum value>`).
 *   3. a `$ref` suppresses every sibling keyword (the node is only the
 *      reference).
 *
 * The rewrite is pure (returns a new tree) and recurses every schema-
 * valued position, including `$defs` / `definitions`, so a self-contained
 * document normalizes wholesale before classification.
 *
 * @packageDocumentation
 */

import { setSpecKey, type SchemaObject, type SchemaOrBoolean } from "@oaverify/internal-core";
import type { Dialect } from "@oaverify/internal-schema";
import {
  refSiblingIsDiscarded,
  subschemaFamilyOf,
  transformSubschemaValue,
} from "@oaverify/internal-schema/internals";

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

// Normalize the schema-bearing positions of a carried OpenAPI `components`
// container. A body schema's internal `$ref` resolves against this container
// (`#/components/schemas/Name`), so its targets need the same 3.0 -> 2020-12
// rewrite as the inline body; without this, `nullable` / boolean `exclusive*`
// inside a referenced component survive un-normalized. The other component
// sub-objects (responses, parameters, ...) pass through: a pointer can name a
// schema inside one, but they are not schema containers, so that schema keeps
// what it was written with.
function mapComponentSchemas(
  components: Record<string, unknown>,
  rewrite: (schema: SchemaOrBoolean) => SchemaOrBoolean,
): Record<string, unknown> {
  const schemas = components.schemas;
  if (!isObjectSchema(schemas)) return components;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(schemas)) {
    setSpecKey(out, name, rewrite(sub as SchemaOrBoolean));
  }
  return { ...components, schemas: out };
}

// Fold a boolean exclusive bound into its 2020-12 numeric form.
function foldExclusive(out: Record<string, unknown>, bound: "maximum" | "minimum"): void {
  const exKey = bound === "maximum" ? "exclusiveMaximum" : "exclusiveMinimum";
  const ex = out[exKey];
  if (typeof ex !== "boolean") return;
  if (ex && typeof out[bound] === "number") {
    out[exKey] = out[bound]; // exclusive bound takes the numeric value
    delete out[bound];
  } else {
    delete out[exKey]; // `false` (or no numeric bound): drop the modifier, keep the inclusive bound
  }
}

/**
 * Normalize an OpenAPI 3.0 schema (tree) into 2020-12 shape. Idempotent
 * on already-2020-12 schemas (3.1 / 3.2 pass through unchanged: they have
 * no `nullable`, numeric `exclusive*`, and `$ref` with honored siblings).
 *
 * @public
 */
export function normalizeOas30(schema: SchemaOrBoolean): SchemaOrBoolean {
  if (!isObjectSchema(schema)) return schema;

  // A 3.0 `$ref` is the whole schema: drop every sibling.
  if (typeof schema.$ref === "string") return { $ref: schema.$ref };

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === "nullable") continue; // folded into `type` below
    if (key === "components" && isObjectSchema(val))
      setSpecKey(out, key, mapComponentSchemas(val as Record<string, unknown>, normalizeOas30));
    else {
      const family = subschemaFamilyOf(key);
      setSpecKey(
        out,
        key,
        family === undefined ? val : transformSubschemaValue(family, val, normalizeOas30),
      );
    }
  }

  // nullable: true -> add "null" to the type.
  if (schema.nullable === true) {
    const t = out.type;
    if (typeof t === "string") out.type = [t, "null"];
    else if (Array.isArray(t) && !t.includes("null")) out.type = [...t, "null"];
    // nullable with no `type` is a no-op (no type constraint to widen).
  }

  foldExclusive(out, "maximum");
  foldExclusive(out, "minimum");
  return out as SchemaObject;
}

/**
 * Drop the keywords the compiler discards beside a `$ref`, as
 * `refSiblingIsDiscarded` decides. The one exception is a root `components`,
 * which is where the operation helpers carry reference targets.
 *
 * Reaches the same nodes {@link normalizeOas30} does: subschema positions and
 * `components.schemas`. A reference target elsewhere (`#/x-lib/S`) keeps its
 * siblings, because a node there can also be data, such as an `enum` member, and
 * rewriting it would change that data. Each source object is rewritten once,
 * so a hand-built cycle or shared node keeps its shape.
 */
function discardRefSiblings(schema: SchemaOrBoolean): SchemaOrBoolean {
  const rewritten = new Map<object, SchemaObject>();
  const rewrite = (node: SchemaOrBoolean): SchemaOrBoolean => {
    if (!isObjectSchema(node)) return node;
    const done = rewritten.get(node);
    if (done !== undefined) return done;
    const out: Record<string, unknown> = {};
    rewritten.set(node, out as SchemaObject);
    for (const [key, val] of Object.entries(node)) {
      if (node === schema && key === "components" && isObjectSchema(val)) {
        setSpecKey(out, key, mapComponentSchemas(val as Record<string, unknown>, rewrite));
        continue;
      }
      if (refSiblingIsDiscarded(node as Record<string, unknown>, key, true)) continue;
      const family = subschemaFamilyOf(key);
      setSpecKey(
        out,
        key,
        family === undefined ? val : transformSubschemaValue(family, val, rewrite),
      );
    }
    return out as SchemaObject;
  };
  return rewrite(schema);
}

/**
 * The schema the classifier and spine see for a configuration. `openApiVersion:
 * "3.0"` normalizes to 2020-12. Otherwise a dialect that suppresses `$ref`
 * siblings loses them here, because the classifier and the spine both read
 * every keyword on a node and neither consults the dialect for this.
 */
export function schemaForEngine(
  schema: SchemaOrBoolean,
  openApiVersion: string | undefined,
  dialect: Dialect,
): SchemaOrBoolean {
  if (openApiVersion === "3.0") return normalizeOas30(schema);
  return dialect.rules.refSuppressesSiblings ? discardRefSiblings(schema) : schema;
}
