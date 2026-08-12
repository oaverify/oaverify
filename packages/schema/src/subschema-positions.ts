import {
  escapePointerSegment,
  pointerFromRefFragment,
  type PathSegment,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-core/subschema-positions";

// The position constants live in `core` so the compiler, the validator
// and the spec resolver share one definition; re-exported here because
// this module is where every existing importer looks for them.
export {
  isSubschemaKey,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-core/subschema-positions";

/**
 * Visitor callback shape for {@link walkSubschemas}. Receives each
 * visited subschema plus the dotted-path string leading to it (relative
 * to the walk root; empty string for the root itself). Returning
 * `false` from the visitor prunes the subtree; any other value (or
 * `void`) continues the walk.
 *
 * @public
 */
export type SubschemaVisitor = (
  schema: SchemaOrBoolean,
  path: string,
  position: SubschemaPosition,
) => void | boolean;

/**
 * Where a visited subschema sits, in the two machine-readable frames a
 * walk can offer. Both are optional, and each is absent exactly when it
 * is undefined rather than unknown.
 *
 * The dotted `path` a visitor also receives is a *rendered* address
 * whose base frame changes silently at a `$ref` (see the addressing
 * note on {@link pathForRef}). These two do not: each says which frame
 * it is in by existing.
 *
 * @public
 */
export interface SubschemaPosition {
  /**
   * RFC 6901 pointer into the document the walk was rooted in,
   * percent-decoded with `~0` / `~1` retained.
   *
   * Present only when the caller supplied
   * {@link WalkSubschemasOptions.pointer}, and only while the walk can
   * still name a position: it is re-rooted at the target on entering a
   * local `$ref`, and absent below an anchor or external `$ref`, which
   * name a schema but no position in this document.
   */
  pointer?: string;
  /**
   * Segments from the walk root down to this subschema, never
   * pre-joined.
   *
   * Absent once a `$ref` has been crossed, because "descend into this
   * `$ref`" is not a schema position and no honest segment list spans
   * it. That is exactly where `pointer` takes over, so between them a
   * consumer always has an address whose frame it did not have to
   * guess.
   */
  schemaPath?: readonly PathSegment[];
  /**
   * Whether `pointer` addresses text this position reached through a
   * `$ref`, and so text that other use sites share.
   *
   * `"node"` until a `$ref` is crossed, `"definition"` after. A caller
   * whose walk root was *itself* reached through a `$ref` says so with
   * {@link WalkSubschemasOptions.anchor}: the walk cannot see a hop
   * that happened before it started, and the HTTP validator makes
   * exactly that hop when it unwraps a body schema's root ref.
   */
  anchor?: "node" | "definition";
}

/**
 * Options for {@link walkSubschemas}.
 *
 * @public
 */
export interface WalkSubschemasOptions {
  /** Follow `$ref` and walk the target too. See {@link walkSubschemas}. */
  resolveRef?: (ref: string) => SchemaOrBoolean | undefined;
  /**
   * RFC 6901 pointer to where the walk root sits in its document.
   * Without it no {@link SubschemaPosition.pointer} is ever produced,
   * which is the right answer for a caller holding a bare schema: it
   * has no document, so there is no pointer to give.
   */
  pointer?: string;
  /**
   * What `pointer` already addresses when the walk starts. Pass
   * `"definition"` when the root was reached through a `$ref`, so
   * findings inside it are reported as shared text rather than as
   * belonging to one use site. Defaults to `"node"`.
   */
  anchor?: "node" | "definition";
}

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
 * Step a {@link SubschemaPosition} down one segment. Either frame may
 * already be absent, and an absent frame stays absent: once a walk has
 * lost the ability to name a position, no further descent recovers it.
 *
 * Shared so the two passes that carry a position (the `walkSubschemas`
 * rules and the `required` rule, which follow `$ref` differently)
 * cannot drift on how a segment is escaped or appended.
 *
 * @internal
 */
export function stepPosition(at: SubschemaPosition, segment: PathSegment): SubschemaPosition {
  return {
    pointer:
      at.pointer === undefined
        ? undefined
        : `${at.pointer}/${escapePointerSegment(String(segment))}`,
    schemaPath: at.schemaPath === undefined ? undefined : [...at.schemaPath, segment],
    // Descending never un-shares text: once inside a definition,
    // everything below it is equally shared.
    anchor: at.anchor,
  };
}

/**
 * The position fields, with absent frames omitted rather than present
 * and `undefined`, so a finding carries a key only where it has an
 * answer.
 *
 * @internal
 */
export function positionFields(at: SubschemaPosition): SubschemaPosition {
  const out: SubschemaPosition = {};
  if (at.pointer !== undefined) out.pointer = at.pointer;
  if (at.schemaPath !== undefined) out.schemaPath = at.schemaPath;
  // An anchor describes what a pointer addresses, so it says nothing
  // without one and is omitted rather than reported against nothing.
  if (at.pointer !== undefined && at.anchor !== undefined) out.anchor = at.anchor;
  return out;
}

/**
 * Walk every subschema reachable from `root`, in pre-order, descending
 * through every schema-valued key the JSON Schema 2020-12 vocabulary
 * (plus the keys OpenAPI adds on top) declares. Boolean schemas are
 * visited but not descended. A `$ref` node is visited and its sibling
 * schema-valued keys are descended; only the ref target itself is not
 * followed without `resolveRef`.
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
  options?: ((ref: string) => SchemaOrBoolean | undefined) | WalkSubschemasOptions,
): void {
  // The third argument was the resolver before the position frames
  // existed, and stays accepted in that form: every existing caller
  // passes a function there. A caller wanting a pointer passes the
  // options object instead.
  const opts: WalkSubschemasOptions =
    typeof options === "function" ? { resolveRef: options } : (options ?? {});
  const resolve = opts.resolveRef;
  // Only ref targets are deduped, never structural positions: the same
  // schema object appearing under two keys is two places a reader may
  // need to fix, and each deserves its own path. A ref target is one
  // place however many pointers reach it, and deduping it is also what
  // stops a recursive component from looping.
  const walkedRefTargets = new WeakSet<object>();

  const go = (node: SchemaOrBoolean, path: string, at: SubschemaPosition): void => {
    const keep = visit(node, path, at);
    if (keep === false) return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;

    if (resolve !== undefined && typeof n["$ref"] === "string") {
      const ref = n["$ref"];
      const target = resolve(ref);
      if (target !== undefined && !(typeof target === "object" && walkedRefTargets.has(target))) {
        if (typeof target === "object" && target !== null) walkedRefTargets.add(target);
        // Both frames re-root here, and they do it differently. The
        // pointer becomes the target's own address, so it keeps
        // resolving. `schemaPath` has no way across the hop and so
        // ends; see SubschemaPosition.schemaPath.
        //
        // Re-rooting only while a frame is already in scope. A `$ref`
        // fragment names a position relative to the *ref resolution
        // root*, which is not the same thing as the document frame the
        // caller supplied, and may be a bare schema with no document at
        // all. Deriving a pointer from the ref alone would answer a
        // question the caller never established an answer to, under a
        // field documented as addressing their document: the exact
        // frame confusion this contract exists to remove.
        go(target, pathForRef(ref), {
          pointer: at.pointer === undefined ? undefined : pointerFromRefFragment(ref),
          anchor: "definition",
        });
      }
    }
    for (const k of SUBSCHEMA_SINGLE_POSITIONS) {
      const v = n[k];
      if (v !== undefined)
        go(v as SchemaOrBoolean, path === "" ? k : `${path}.${k}`, stepPosition(at, k));
    }
    for (const k of SUBSCHEMA_ARRAY_POSITIONS) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i += 1) {
          go(
            v[i] as SchemaOrBoolean,
            path === "" ? `${k}[${i}]` : `${path}.${k}[${i}]`,
            stepPosition(stepPosition(at, k), i),
          );
        }
      }
    }
    for (const k of SUBSCHEMA_MAP_POSITIONS) {
      const v = n[k];
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          go(
            vv as SchemaOrBoolean,
            path === "" ? `${k}.${kk}` : `${path}.${k}.${kk}`,
            stepPosition(stepPosition(at, k), kk),
          );
        }
      }
    }
  };
  go(root, "", { pointer: opts.pointer, schemaPath: [], anchor: opts.anchor ?? "node" });
}
