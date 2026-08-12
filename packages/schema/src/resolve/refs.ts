import {
  pointerFromFragment,
  resolveJsonPointer as coreResolveJsonPointer,
  type SchemaObject,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { absolutizeUri, type ResolvedGraph } from "./resolver.js";

/**
 * A function capable of resolving a JSON Schema `$ref` string (absolute or
 * fragment) into the schema it names.
 *
 * @public
 */
export interface RefResolver {
  /**
   * Resolve a `$ref` string to the target schema.
   *
   * @param ref - The `$ref` value, either a fragment (`#...`), a relative
   *   URI, or an absolute URI (with optional `#fragment`).
   * @param fromBaseUri - Optional base URI of the schema containing the
   *   `$ref`. Used to absolutize relative refs and to pick the right
   *   scope for `#anchor` / `#/pointer` fragments under nested `$id`s.
   */
  resolve(ref: string, fromBaseUri?: string): SchemaOrBoolean;
}

/** How to name a rejected value in the message, without echoing it. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return type === "object" ? "an object with no resolve method" : `a ${type}`;
}

/**
 * Reject a `refResolver` that is not one, at the point it was passed.
 *
 * A bare function is the shape a caller reaches for first, and it fails
 * far from the mistake: `state.refResolver.resolve is not a function`,
 * raised inside codegen, naming an internal field and not the option.
 * It also fails per schema, so a caller compiling many schemas in a
 * loop reads it as a problem with the schemas. In the audit that
 * produced this, it swallowed 19 of 30 before the cause was found.
 *
 * @param resolver - The `refResolver` option as passed.
 *
 * @internal
 */
export function assertRefResolver(resolver: unknown): void {
  if (
    typeof resolver === "object" &&
    resolver !== null &&
    typeof (resolver as RefResolver).resolve === "function"
  ) {
    return;
  }
  throw new TypeError(
    `refResolver must be an object with a resolve(ref) method; received ${describeShape(resolver)}`,
  );
}

/**
 * Build a {@link RefResolver} that resolves references against a given
 * {@link ResolvedGraph}.
 *
 * @remarks
 * Supported forms:
 * - `#`: the root of the enclosing `$id` scope (or the graph root if
 *   the `$ref` appears at the root).
 * - `#/a/b/c`: JSON Pointer into the enclosing scope's root schema.
 * - `#name`: lookup in the enclosing scope's anchor map; falls back to
 *   the flat anchor map for cross-scope references.
 * - absolute URI: lookup in `byId` or the external registry.
 * - absolute URI + fragment: resolve the URI, then the fragment.
 *
 * @param graph - Output of {@link resolve}.
 * @returns A resolver ready to hand to the compiler.
 *
 * @example
 * ```ts
 * const graph = resolve({ $defs: { Pet: { type: "object" } } });
 * const refs = createRefResolver(graph);
 * refs.resolve("#/$defs/Pet"); // → { type: "object" }
 * ```
 *
 * @public
 */
export function createRefResolver(graph: ResolvedGraph): RefResolver {
  return {
    resolve(ref: string, fromBaseUri: string = graph.baseUri): SchemaOrBoolean {
      return resolveOne(ref, graph, fromBaseUri);
    },
  };
}

function rootForBase(graph: ResolvedGraph, baseUri: string): SchemaOrBoolean {
  if (baseUri === "" || baseUri === graph.baseUri) return graph.root;
  const fromId = graph.byId.get(baseUri);
  if (fromId !== undefined) return fromId;
  const fromRegistry = graph.registry.get(baseUri);
  if (fromRegistry !== undefined) return fromRegistry;
  return graph.root;
}

function resolveOne(ref: string, graph: ResolvedGraph, fromBaseUri: string): SchemaOrBoolean {
  if (ref === "#" || ref === "") return rootForBase(graph, fromBaseUri);
  if (ref.startsWith("#")) {
    return resolveFragment(ref.slice(1), rootForBase(graph, fromBaseUri), graph, fromBaseUri);
  }

  const resolvedRef = absolutizeUri(ref, fromBaseUri);
  const hashIdx = resolvedRef.indexOf("#");
  const base = hashIdx < 0 ? resolvedRef : resolvedRef.slice(0, hashIdx);
  const fragment = hashIdx < 0 ? "" : resolvedRef.slice(hashIdx + 1);
  const baseSchema = graph.byId.get(base) ?? graph.registry.get(base);
  if (baseSchema === undefined) {
    throw new Error(`cannot resolve $ref: ${ref}`);
  }
  if (fragment === "") return baseSchema;
  return resolveFragment(fragment, baseSchema, graph, base);
}

function resolveFragment(
  fragment: string,
  rootSchema: SchemaOrBoolean,
  graph: ResolvedGraph,
  baseUri: string,
): SchemaOrBoolean {
  if (fragment === "") return rootSchema;
  // The fragment comes off a `$ref`, so percent-decode it into a
  // pointer before evaluating; `resolveJsonPointer` does none itself.
  if (fragment.startsWith("/")) {
    return resolveJsonPointer(rootSchema, pointerFromFragment(fragment));
  }
  const scoped =
    graph.anchorScopes.get(baseUri)?.get(fragment) ??
    graph.dynamicAnchorScopes.get(baseUri)?.get(fragment);
  if (scoped !== undefined) return scoped;
  // Fall back to the flat union; lets #anchor refs resolve against
  // cousin scopes when the enclosing scope doesn't own the anchor.
  const flat = graph.byAnchor.get(fragment) ?? graph.byDynamicAnchor.get(fragment);
  if (flat !== undefined) return flat;
  throw new Error(`unknown anchor: #${fragment}`);
}

function resolveJsonPointer(root: SchemaOrBoolean, pointer: string): SchemaOrBoolean {
  return coreResolveJsonPointer(root, pointer) as SchemaOrBoolean;
}

/**
 * Collect the graph-wide `$dynamicAnchor` union, plus the anchor `schema`
 * itself declares (which wins on a name collision).
 *
 * @remarks
 * A flat lookup table, not a scope simulation: since #663 the actual
 * dynamic scope lives in a runtime stack of schema resources, and this
 * map only supplies the static candidates. For schemas that don't use
 * `$dynamicAnchor`, a `$dynamicRef` behaves exactly like a `$ref`.
 *
 * @param schema - Schema whose own `$dynamicAnchor` (if any) is added.
 * @param graph - Resolved graph supplying the flat `byDynamicAnchor` union.
 * @returns A copy of `graph.byDynamicAnchor` with `schema`'s own
 *          `$dynamicAnchor` entry layered on top.
 *
 * @public
 */
export function collectDynamicAnchors(
  schema: SchemaOrBoolean,
  graph: ResolvedGraph,
): Map<string, SchemaOrBoolean> {
  const acc = new Map(graph.byDynamicAnchor);
  visit(schema, acc);
  return acc;
}

function visit(schema: SchemaOrBoolean, acc: Map<string, SchemaOrBoolean>): void {
  if (typeof schema === "boolean") return;
  const obj = schema as SchemaObject;
  if (typeof obj.$dynamicAnchor === "string") acc.set(obj.$dynamicAnchor, schema);
}
