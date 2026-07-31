/**
 * Body schema pre-transforms applied before the JSON Schema compiler
 * sees the operation's body schema. Two concerns live here:
 *
 *   1. Direction (readOnly / writeOnly): properties forbidden in the
 *      current leg of the HTTP exchange are rewritten to `false` and
 *      stripped from `required`. See
 *      {@link transformBodySchemaForDirection}.
 *
 *   2. Opaque bodies: `format: "binary"` fields arrive as Buffers or
 *      framework-specific objects, not strings, so the transform
 *      replaces them with `{}` (an "accept anything" schema) in both
 *      directions. See {@link isBinaryStringSchema}.
 *
 * Concern (2) isn't about direction at all but is colocated here
 * because both operate by rewriting a body schema before compile.
 *
 * @packageDocumentation
 */

import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { type RefResolver } from "@oaverify/internal-schema";
import { pointerFromRefFragment, setSpecKey } from "@oaverify/internal-core";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-schema/internals";

/**
 * Which leg of the HTTP exchange a schema is being validated against.
 *
 * @internal
 */
export type BodyDirection = "request" | "response";

/**
 * Produce a direction-aware copy of a body schema.
 *
 * OpenAPI `readOnly` / `writeOnly` constrain the direction of travel for
 * a property:
 * - `readOnly: true`: server-generated; clients MUST NOT include it in
 *   request bodies, and it's exempt from `required` on the request side.
 * - `writeOnly: true`: client-only; servers MUST NOT include it in
 *   response bodies, and it's exempt from `required` on the response side.
 *
 * The JSON Schema compiler is direction-agnostic, so we pre-transform
 * the body schema per direction: properties the direction forbids are
 * replaced with `false` (rejecting their presence) and stripped from
 * `required` (exempting their absence).
 *
 * The transform is a local rewrite only; `$ref` nodes are preserved as
 * they are. To make composition-via-ref work (e.g.
 * `allOf: [{ $ref: "#/Timestamps" }, ...]` where `Timestamps` owns the
 * readOnly field), pair this with {@link createDirectionResolver}:
 * every `$ref` the compiler follows at validate-time goes through the
 * same local transform on its target, so the inherited `properties`
 * and `required` get projected as well. Leaving `$ref` intact keeps
 * OAS 3.0 sibling suppression and the discriminator's branch lookup
 * (both of which read `$ref` at compile time) working as before.
 *
 * @internal
 */
export function transformBodySchemaForDirection(
  schema: SchemaOrBoolean,
  direction: BodyDirection,
  refResolver: RefResolver,
  cache: Map<SchemaOrBoolean, SchemaOrBoolean>,
): SchemaOrBoolean {
  const unwrapped = unwrapRootRef(schema, refResolver).schema;
  return transformInner(unwrapped, direction, refResolver, cache);
}

/**
 * Where the schema that {@link transformBodySchemaForDirection} will
 * actually compile lives, given where the body's `schema:` keyword sits.
 *
 * These differ, and silently, which is defect 3c of #517. A body of
 * `{$ref: "#/components/schemas/Req"}` is unwrapped before compiling,
 * so every path in a resulting finding is relative to `Req` while the
 * use site holds only the `$ref`. A pointer built from the use site
 * therefore does not resolve: there is no `properties` under
 * `.../content/application~1json/schema`.
 *
 * Returns the target's pointer when a root ref was unwrapped and the
 * use site's otherwise. `undefined` in, `undefined` out: a caller with
 * no document frame gains one here no more than anywhere else.
 *
 * @internal
 */
export function bodySchemaCompiledPointer(
  schema: SchemaOrBoolean,
  refResolver: RefResolver,
  useSitePointer: string | undefined,
  useSiteAnchor: "node" | "definition" | undefined,
): { pointer?: string; anchor?: "node" | "definition" } {
  if (useSitePointer === undefined) return {};
  const { lastRef } = unwrapRootRef(schema, refResolver);
  if (lastRef === undefined) return { pointer: useSitePointer, anchor: useSiteAnchor ?? "node" };
  // An external or anchor target names no position in this document,
  // so the honest answer is no pointer rather than the use site's,
  // which addresses the `$ref` node and not what was compiled.
  //
  // A root ref that was followed means the compiled schema is shared
  // text, whatever the use site was.
  return { pointer: pointerFromRefFragment(lastRef), anchor: "definition" };
}

/**
 * Wrap a {@link RefResolver} so every target is direction-transformed.
 * Each unique target schema is transformed once per direction and
 * memoised inside the shared cache, so multiple `$ref`s pointing at the
 * same component see the same transformed object.
 *
 * @internal
 */
export function createDirectionResolver(
  base: RefResolver,
  direction: BodyDirection,
  cache: Map<SchemaOrBoolean, SchemaOrBoolean>,
): RefResolver {
  return {
    resolve(ref, fromBaseUri) {
      const target = base.resolve(ref, fromBaseUri);
      return transformInner(target, direction, base, cache);
    },
  };
}

/**
 * Follow `$ref` chains at the schema root so e.g.
 * `{ $ref: "#/components/schemas/User" }` resolves to the concrete
 * `User` object schema, which is what the direction transform needs
 * to walk. Cycles are guarded by a visited set.
 *
 * Only a `$ref` that carries nothing else is followed. Under 2020-12
 * (so OpenAPI 3.1) a `$ref` alongside other keywords means "the target
 * AND those keywords", and replacing the node with its target drops
 * them: `{ $ref: Pet, required: [name] }` at a body root silently
 * stopped enforcing `required`. Leaving such a node alone costs
 * nothing, because the compiler already applies `$ref` with siblings
 * correctly (it does so everywhere below the root), and the direction
 * transform still reaches the target through
 * {@link createDirectionResolver}.
 *
 * Under OAS 3.0 those siblings are dropped by the specification rather
 * than by us, and the compiler does that itself. Keeping the node also
 * lets `silent-rewrite/ref-siblings-oas30` see it and warn (#505).
 */
function unwrapRootRef(
  schema: SchemaOrBoolean,
  refResolver: RefResolver,
): { schema: SchemaOrBoolean; lastRef?: string } {
  const visited = new Set<SchemaOrBoolean>();
  let current = schema;
  // The chain can be several hops; only the last one names what is
  // compiled, which is what a pointer has to address.
  let lastRef: string | undefined;
  while (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current) &&
    typeof (current as { $ref?: unknown }).$ref === "string" &&
    isBareRef(current as Record<string, unknown>)
  ) {
    if (visited.has(current)) return { schema: current, lastRef };
    visited.add(current);
    const ref = (current as { $ref: string }).$ref;
    try {
      current = refResolver.resolve(ref);
    } catch {
      return { schema: current, lastRef };
    }
    lastRef = ref;
  }
  return { schema: current, lastRef };
}

/**
 * Keys that sit alongside `$ref` without changing what validates.
 * Everything else makes the node mean more than its target.
 */
const REF_ANNOTATION_SIBLINGS = new Set([
  "$ref",
  "title",
  "description",
  "summary",
  "example",
  "examples",
  "deprecated",
  "$comment",
]);

function isBareRef(node: Record<string, unknown>): boolean {
  for (const key of Object.keys(node)) {
    if (!REF_ANNOTATION_SIBLINGS.has(key)) return false;
  }
  return true;
}

function transformInner(
  schema: SchemaOrBoolean,
  direction: BodyDirection,
  refResolver: RefResolver,
  cache: Map<SchemaOrBoolean, SchemaOrBoolean>,
): SchemaOrBoolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;

  // OAS `format: "binary"` marks opaque bytes: the field arrives as a
  // Buffer, Uint8Array, or framework-specific object (multer etc.), not
  // a JS string. Stripping all constraints so the validator accepts
  // whatever the HTTP layer decoded avoids false positives on every
  // multipart file upload. `format: "byte"` (base64) stays as a string
  // and follows normal validation.
  if (isBinaryStringSchema(schema)) {
    const empty: Record<string, unknown> = {};
    cache.set(schema, empty as unknown as SchemaOrBoolean);
    return empty as unknown as SchemaOrBoolean;
  }

  const clone: Record<string, unknown> = { ...schema };
  cache.set(schema, clone as unknown as SchemaOrBoolean);

  const rejectAttr = direction === "request" ? "readOnly" : "writeOnly";

  const props = clone.properties;
  if (typeof props === "object" && props !== null && !Array.isArray(props)) {
    const newProps: Record<string, SchemaOrBoolean> = {};
    const rejected = new Set<string>();
    for (const [name, propSchema] of Object.entries(props as Record<string, SchemaOrBoolean>)) {
      if (hasDirectionalFlag(propSchema, rejectAttr, refResolver, new Set())) {
        setSpecKey(newProps, name, false);
        rejected.add(name);
      } else {
        setSpecKey(newProps, name, transformInner(propSchema, direction, refResolver, cache));
      }
    }
    clone.properties = newProps;
    if (Array.isArray(clone.required)) {
      clone.required = (clone.required as string[]).filter((r) => !rejected.has(r));
    }
  }

  for (const k of SUBSCHEMA_SINGLE_POSITIONS) {
    const v = clone[k];
    if (v !== undefined) {
      clone[k] = transformInner(v as SchemaOrBoolean, direction, refResolver, cache);
    }
  }
  for (const k of SUBSCHEMA_ARRAY_POSITIONS) {
    const v = clone[k];
    if (Array.isArray(v)) {
      clone[k] = (v as SchemaOrBoolean[]).map((s) =>
        transformInner(s, direction, refResolver, cache),
      );
    }
  }
  for (const k of SUBSCHEMA_MAP_POSITIONS) {
    // `properties` is handled specially above (readOnly/writeOnly filtering).
    if (k === "properties") continue;
    const v = clone[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const m: Record<string, SchemaOrBoolean> = {};
      for (const [kk, vv] of Object.entries(v as Record<string, SchemaOrBoolean>)) {
        setSpecKey(m, kk, transformInner(vv, direction, refResolver, cache));
      }
      clone[k] = m;
    }
  }

  return clone as unknown as SchemaOrBoolean;
}

function isBinaryStringSchema(schema: SchemaOrBoolean): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (s.format !== "binary") return false;
  // Either `type: "string"` or an array containing "string"; accept
  // both, including the 3.1 shorthand `type: ["string", "null"]`.
  if (s.type === "string") return true;
  if (Array.isArray(s.type) && (s.type as unknown[]).includes("string")) return true;
  // Author declared `format: binary` without a type. Still not a
  // validatable JSON value; bypass.
  if (s.type === undefined) return true;
  return false;
}

function hasDirectionalFlag(
  schema: SchemaOrBoolean,
  attr: "readOnly" | "writeOnly",
  refResolver: RefResolver,
  visited: Set<SchemaOrBoolean>,
): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  if (visited.has(schema)) return false;
  visited.add(schema);
  const s = schema as Record<string, unknown>;
  if (s[attr] === true) return true;
  if (typeof s.$ref === "string") {
    try {
      const t = refResolver.resolve(s.$ref);
      if (hasDirectionalFlag(t, attr, refResolver, visited)) return true;
    } catch {
      // ignore unresolved refs
    }
  }
  if (Array.isArray(s.allOf)) {
    for (const child of s.allOf as SchemaOrBoolean[]) {
      if (hasDirectionalFlag(child, attr, refResolver, visited)) return true;
    }
  }
  return false;
}
