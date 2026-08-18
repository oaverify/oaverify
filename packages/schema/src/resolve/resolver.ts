import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { forEachSubschema } from "@oaverify/internal-core/subschema-positions";
import { SchemaRegistry } from "./registry.js";

/**
 * A resolved schema graph: the root schema plus lookup tables for every
 * $id / $anchor discovered during traversal. This is the input to the
 * compiler.
 *
 * @public
 */
export interface ResolvedGraph {
  /** The entry point schema. */
  root: SchemaOrBoolean;
  /** Base URI of the root schema (may be empty for anonymous schemas). */
  baseUri: string;
  /**
   * Every `$id` discovered, mapped to the schema it labels. Keyed by the
   * absolute URI, and additionally by the raw (possibly relative) `$id`
   * spelling so refs that repeat it resolve too.
   */
  byId: Map<string, SchemaOrBoolean>;
  /**
   * Flat union of every `$anchor` discovered: last-writer-wins when two
   * anchors share a name across scopes. Prefer {@link anchorScopes} when
   * scope-local lookup matters; this map exists for compatibility.
   */
  byAnchor: Map<string, SchemaOrBoolean>;
  /**
   * Flat union of every `$dynamicAnchor` discovered; see {@link byAnchor}
   * for caveats.
   */
  byDynamicAnchor: Map<string, SchemaOrBoolean>;
  /**
   * Per-base-URI anchor maps. Keys are absolute base URIs established by a
   * declared `$id` (or the root base URI); values are `anchor → schema`
   * maps for the anchors declared within that scope.
   */
  anchorScopes: Map<string, Map<string, SchemaOrBoolean>>;
  /** Per-base-URI `$dynamicAnchor` maps; same shape as {@link anchorScopes}. */
  dynamicAnchorScopes: Map<string, Map<string, SchemaOrBoolean>>;
  /** Identity-keyed map from every schema object to its enclosing base URI. */
  schemaBaseUri: WeakMap<object, string>;
  /** External schemas by URI (from the registry passed to {@link resolve}). */
  registry: SchemaRegistry;
}

/**
 * Options accepted by {@link resolve}.
 *
 * @public
 */
export interface ResolveOptions {
  /** Base URI to associate with the root schema. Defaults to `""`. */
  baseUri?: string;
  /**
   * External schema registry. Read-only here: its schemas are walked and
   * their `$id` / anchor entries copied into the returned graph; the
   * registry itself is never mutated.
   */
  registry?: SchemaRegistry;
}

/**
 * Walk a JSON Schema 2020-12 document and collect its `$id` / `$anchor` /
 * `$dynamicAnchor` locations into lookup tables, scoped by the enclosing
 * `$id` base URI. Boolean schemas (`true` / `false`) pass through
 * unchanged. Any schemas pre-registered in the passed registry are walked
 * too, using their registry key as the starting base URI.
 *
 * @remarks
 * This function does not yet inline `$ref`; references are left in place
 * and resolved lazily at compile time. The schemas remain the original
 * values (not cloned).
 *
 * @param schema - Root schema.
 * @param options - Optional base URI / registry.
 * @returns A {@link ResolvedGraph}.
 *
 * @example
 * ```ts
 * const graph = resolve({ $defs: { Pet: { type: "object" } } });
 * graph.byAnchor.size; // 0
 * ```
 *
 * @public
 */
export function resolve(schema: SchemaOrBoolean, options: ResolveOptions = {}): ResolvedGraph {
  const registry = options.registry ?? new SchemaRegistry();
  const byId = new Map<string, SchemaOrBoolean>();
  const anchorScopes = new Map<string, Map<string, SchemaOrBoolean>>();
  const dynamicAnchorScopes = new Map<string, Map<string, SchemaOrBoolean>>();
  const schemaBaseUri = new WeakMap<object, string>();
  const rootBaseUri = options.baseUri ?? "";

  walkScoped(schema, rootBaseUri, byId, anchorScopes, dynamicAnchorScopes, schemaBaseUri);

  for (const [uri, ext] of registry.entries()) {
    if (!byId.has(uri)) byId.set(uri, ext);
    walkScoped(ext, uri, byId, anchorScopes, dynamicAnchorScopes, schemaBaseUri);
  }

  const byAnchor = new Map<string, SchemaOrBoolean>();
  for (const scope of anchorScopes.values()) {
    for (const [k, v] of scope) byAnchor.set(k, v);
  }
  const byDynamicAnchor = new Map<string, SchemaOrBoolean>();
  for (const scope of dynamicAnchorScopes.values()) {
    for (const [k, v] of scope) byDynamicAnchor.set(k, v);
  }

  return {
    root: schema,
    baseUri: rootBaseUri,
    byId,
    byAnchor,
    byDynamicAnchor,
    anchorScopes,
    dynamicAnchorScopes,
    schemaBaseUri,
    registry,
  };
}

/**
 * Resolve a (possibly relative) URI against a base URI. Leaves the input
 * unchanged when the base is empty or URL resolution is not applicable
 * (e.g. bare JSON Pointer paths with a leading slash).
 *
 * @internal
 */
export function absolutizeUri(uri: string, base: string): string {
  if (base === "") return uri;
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

function getOrCreateScope(
  scopes: Map<string, Map<string, SchemaOrBoolean>>,
  uri: string,
): Map<string, SchemaOrBoolean> {
  let scope = scopes.get(uri);
  if (scope === undefined) {
    scope = new Map();
    scopes.set(uri, scope);
  }
  return scope;
}

function walkScoped(
  schema: SchemaOrBoolean,
  currentBase: string,
  byId: Map<string, SchemaOrBoolean>,
  anchorScopes: Map<string, Map<string, SchemaOrBoolean>>,
  dynamicAnchorScopes: Map<string, Map<string, SchemaOrBoolean>>,
  schemaBaseUri: WeakMap<object, string>,
): void {
  if (typeof schema === "boolean") return;
  const obj = schema as SchemaObject;

  let nextBase = currentBase;
  if (typeof obj.$id === "string") {
    nextBase = absolutizeUri(obj.$id, currentBase);
    byId.set(nextBase, schema);
    // Also expose the raw (possibly relative) form for refs that repeat it.
    if (!byId.has(obj.$id)) byId.set(obj.$id, schema);
  }
  schemaBaseUri.set(schema, nextBase);

  if (typeof obj.$anchor === "string") {
    getOrCreateScope(anchorScopes, nextBase).set(obj.$anchor, schema);
  }
  if (typeof obj.$dynamicAnchor === "string") {
    getOrCreateScope(dynamicAnchorScopes, nextBase).set(obj.$dynamicAnchor, schema);
  }

  // Driven by the shared iteration rather than a list written out here.
  // The hand-written list had drifted: `definitions` was in the
  // constants and missing here, so an `$anchor` under it resolved to
  // "unknown anchor". Going through the shared iteration means a
  // position family cannot be omitted at all.
  forEachSubschema(obj, (value) => {
    walkScoped(value, nextBase, byId, anchorScopes, dynamicAnchorScopes, schemaBaseUri);
  });
}
