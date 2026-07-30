import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";

// The position constants live in `core` so the compiler, the validator
// and the spec resolver share one definition; re-exported here because
// this module is where every existing importer looks for them.
export {
  isSubschemaKey,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-core";

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
 * Display path for a schema reached through `$ref`. A local pointer
 * becomes the dotted document path it names, so
 * `#/components/schemas/Email` reads as `components.schemas.Email` and
 * joins with the path below it in the same style. Anything else (an
 * anchor, an external URI) is shown as written, since there is no
 * document path to give.
 *
 * ## Which passes use this, and why not all of them
 *
 * Three passes follow `$ref`, and they do not address a ref target the
 * same way. That is deliberate, and the rule is which question the
 * pass answers:
 *
 * - **Where is this defined?** {@link walkSubschemas} and
 *   `assertWellFormedSchema` reset the path to `pathForRef(ref)` on
 *   entering a target, so a finding inside a shared component is
 *   reported once, at its definition. A malformed `items` is one edit
 *   in one place however many operations reach it, and naming the
 *   route that got there first would send the reader somewhere they
 *   cannot fix it.
 *
 * - **Where does this apply?** `collectRequiredIssues` keeps the
 *   use-site path across a ref, because its finding is not a property
 *   of the target alone. The rule asks which property names are
 *   reachable at an *instance* position, and a component says
 *   different things at different use sites: the names available to it
 *   come from every schema constraining that position, including ones
 *   on the other side of a composition the target cannot see. Resetting
 *   to the definition would name a location where the finding may not
 *   even hold.
 *
 * So a reader can see one defect addressed two ways, and both are
 * right. Before changing a pass to match another, check which of the
 * two questions it answers; the required lint's correctness depends on
 * its answer.
 *
 * @internal
 */
export function pathForRef(ref: string): string {
  if (!ref.startsWith("#/")) return ref;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

/**
 * Walk every subschema reachable from `root`, in pre-order, descending
 * through every schema-valued key the JSON Schema 2020-12 vocabulary
 * (plus the keys OpenAPI adds on top) declares. Boolean schemas and
 * `$ref` nodes are visited but not descended.
 *
 * Pass `resolveRef` to follow `$ref` and walk its target too, reported
 * under the document path the pointer names. Without it the walk covers
 * only what is structurally present, which is what a caller holding a
 * self-contained schema wants. A caller holding one operation's slice
 * of a larger document wants the resolver, or it sees an arbitrary
 * fraction of what will be compiled: on Asana, 1 of 278 component
 * schemas (#513). Each ref target is walked once per call, which also
 * stops a recursive component looping.
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
export function walkSubschemas(
  root: SchemaOrBoolean,
  visit: SubschemaVisitor,
  resolveRef?: (ref: string) => SchemaOrBoolean | undefined,
): void {
  // Only ref targets are deduped, never structural positions: the same
  // schema object appearing under two keys is two places a reader may
  // need to fix, and each deserves its own path. A ref target is one
  // place however many pointers reach it, and deduping it is also what
  // stops a recursive component from looping.
  const walkedRefTargets = new WeakSet<object>();

  const go = (node: SchemaOrBoolean, path: string): void => {
    const keep = visit(node, path);
    if (keep === false) return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;

    if (resolveRef !== undefined && typeof n["$ref"] === "string") {
      const target = resolveRef(n["$ref"]);
      if (target !== undefined && !(typeof target === "object" && walkedRefTargets.has(target))) {
        if (typeof target === "object" && target !== null) walkedRefTargets.add(target);
        go(target, pathForRef(n["$ref"]));
      }
    }
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
