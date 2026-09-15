/**
 * The `unsatisfiable/composed-properties` rule: an
 * `additionalProperties: false` that rejects property names the
 * composition around it declares.
 *
 * `additionalProperties` is adjacency-scoped. It sees the `properties`
 * and `patternProperties` written beside it in the same schema object
 * and nothing else, so a name declared by an `allOf` branch, a `$ref`
 * target or a `oneOf` arm is "additional" to the node holding the
 * close and is rejected. The document says exactly that and the
 * compiled validator does exactly that; what the author meant was
 * `unevaluatedProperties: false`, or a different structure.
 *
 * Two questions, and they take different applicator sets:
 *
 * - **Locating a close.** The close has to be reached on every instance
 *   that reaches the declarations, so only a conjunctive path counts.
 *   A close inside a `oneOf` arm is the ordinary "one of these shapes"
 *   idiom and is not a defect.
 * - **Collecting declarations opposite it.** Any positive path counts,
 *   `anyOf` and `oneOf` included: the close applies whichever arm the
 *   instance takes, so a name declared in any of them is still dead.
 *
 * `not` is in neither set. A `properties` reached through `not` is a
 * negative constraint and the names in it were never meant to appear.
 *
 * @packageDocumentation
 */

import { refSiblingIsDiscarded } from "../ref-siblings.js";
import type { SchemaLintIssue } from "./compiler.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Bounds the walk on pathological or cyclic schemas. */
const MAX_DEPTH = 25;

/** Dead names listed in the message before it starts counting. */
const MAX_NAMED = 5;

/**
 * What the rule needs beyond the node itself.
 *
 * `known` is the active dialect's keyword set. Every keyword this rule
 * reasons about is checked against it, because a dialect that does not
 * implement `additionalProperties` compiles a close that rejects
 * nothing, and a finding claiming otherwise would describe behaviour
 * the validator does not have.
 */
export interface ClosedCompositionContext {
  /**
   * The compiler's own `$ref` resolver, which is the only one this rule
   * uses. It already answers the questions a second walk would have to
   * re-derive, the OAS 3.0 rule that a `$ref` node has no addressable
   * members among them, and it reports failure as `undefined` rather
   * than by throwing. Anything it cannot follow is "cannot enumerate".
   */
  readonly resolve: (ref: string) => unknown;
  readonly refSuppressesSiblings: boolean;
  readonly known: (keyword: string) => boolean;
}

/**
 * Applicators whose subschemas constrain the same instance and assert
 * positively, so a `properties` inside one declares a name the instance
 * may carry.
 *
 * `then` and `else` are handled beside this list rather than in it:
 * without an `if` they are inert, and the instance never reaches them.
 */
const POSITIVE_IN_PLACE = ["allOf", "anyOf", "oneOf", "dependentSchemas", "dependencies"] as const;

/** What a walk of the composition found declared. */
interface Declarations {
  readonly names: ReadonlySet<string>;
  /** A composed `patternProperties`, whose matches cannot be enumerated. */
  readonly patterns: boolean;
  /** A `$ref` that could not be followed: stop claiming to know the set. */
  readonly unresolved: boolean;
}

/** Is this key live here: in the dialect, and not dropped beside a `$ref`? */
function live(node: Obj, key: string, ctx: ClosedCompositionContext): boolean {
  return ctx.known(key) && !refSiblingIsDiscarded(node, key, ctx.refSuppressesSiblings);
}

/**
 * The `properties` keys a schema object *declares*, which needs the
 * keyword to be one the dialect implements: under a dialect without
 * `properties`, the key emits no code and names nothing.
 */
function declaredNames(node: Obj, ctx: ClosedCompositionContext): string[] {
  if (!live(node, "properties", ctx)) return [];
  const props = node["properties"];
  return isObj(props) ? Object.keys(props) : [];
}

/** The same question for `patternProperties`. */
function declaresPatterns(node: Obj, ctx: ClosedCompositionContext): boolean {
  if (!live(node, "patternProperties", ctx)) return false;
  const patterns = node["patternProperties"];
  return isObj(patterns) && Object.keys(patterns).length > 0;
}

/**
 * The names the close on this node already permits, which is a
 * different question and takes a different answer.
 *
 * `additionalProperties` reads its siblings raw (`properties.ts:122`,
 * `Object.keys(ctx.parentSchema.properties ?? {})`), with no check that
 * the dialect registers them. So a `properties` the dialect does not
 * implement still covers its names against the close, and subtracting
 * only registered ones would report a name the emitted validator
 * accepts. Coverage describes the generated code, so it reads what the
 * generated code reads.
 */
function coveredNames(node: Obj, ctx: ClosedCompositionContext): string[] {
  if (refSiblingIsDiscarded(node, "properties", ctx.refSuppressesSiblings)) return [];
  const props = node["properties"];
  return isObj(props) ? Object.keys(props) : [];
}

/** The same question for `patternProperties`, and for the same reason. */
function coversByPattern(node: Obj, ctx: ClosedCompositionContext): boolean {
  if (refSiblingIsDiscarded(node, "patternProperties", ctx.refSuppressesSiblings)) return false;
  const patterns = node["patternProperties"];
  return isObj(patterns) && Object.keys(patterns).length > 0;
}

/**
 * Every property name declared by a schema reachable from `seeds`
 * along a positive in-place path, following `$ref`.
 *
 * The closing node is left in rather than excluded: its own adjacent
 * names are subtracted again by {@link verdict}, so they cancel, and
 * anything it declares *below* itself is dead for the same reason its
 * siblings' declarations are.
 */
function declarationsFrom(seeds: readonly unknown[], ctx: ClosedCompositionContext): Declarations {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  let patterns = false;
  let unresolved = false;

  const add = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      unresolved = true;
      return;
    }
    if (!isObj(node) || seen.has(node)) return;
    seen.add(node);

    for (const name of declaredNames(node, ctx)) names.add(name);
    if (declaresPatterns(node, ctx)) patterns = true;

    if (live(node, "$ref", ctx) && typeof node["$ref"] === "string") {
      const target = ctx.resolve(node["$ref"]);
      // A boolean schema is a resolved schema that declares no names,
      // which is a different answer from one that could not be followed.
      // Reading `true` as unknowable suppressed findings that hold.
      if (isObj(target)) add(target, depth + 1);
      else if (typeof target !== "boolean") unresolved = true;
    }

    for (const kw of POSITIVE_IN_PLACE) {
      if (!live(node, kw, ctx)) continue;
      const value = node[kw];
      if (Array.isArray(value)) {
        for (const branch of value) add(branch, depth + 1);
      } else if (isObj(value)) {
        // A map of schemas. `dependencies` also carries the draft-07
        // array form, whose entries name properties rather than holding
        // a schema.
        for (const branch of Object.values(value))
          if (!Array.isArray(branch)) add(branch, depth + 1);
      }
    }

    // Reachable only when an `if` selects them, which is still a
    // reachable positive assertion. Without one they are inert and
    // declare nothing.
    if (live(node, "if", ctx) && node["if"] !== undefined) {
      for (const kw of ["then", "else"]) {
        if (live(node, kw, ctx)) add(node[kw], depth + 1);
      }
    }
  };

  for (const seed of seeds) add(seed, 0);
  return { names, patterns, unresolved };
}

/** Is this node an `additionalProperties: false` the dialect honours? */
function isClosed(node: Obj, ctx: ClosedCompositionContext): boolean {
  return live(node, "additionalProperties", ctx) && node["additionalProperties"] === false;
}

/** `a, b and c`, capped, because a message is read rather than parsed. */
function renderNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED).map((n) => JSON.stringify(n));
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The fix, which is not the same sentence in every dialect or in every
 * position.
 *
 * Where the dialect has no `unevaluatedProperties`, the message does not
 * name it, even to say it is missing: an author who writes the keyword
 * on that advice gets a key nothing evaluates and an object they
 * believe is closed, so the advice would manufacture the defect it is
 * reporting. It names no dialect either. The condition is the keyword's
 * absence, which OAS 3.0 is the common case of and not the only one, so
 * a message saying "OAS 3.0" would be wrong under a custom dialect. It
 * states the edit instead, and it does not claim a composed object
 * cannot be closed there: declaring the properties beside the close
 * does close it.
 *
 * In a branch, substituting `unevaluatedProperties` where the close
 * sits does not work either: it collects annotations from its own
 * schema object and below, not from the branches beside it, so the
 * sibling's properties stay unevaluated and stay rejected. The close
 * has to move up to the composition.
 */
function advice(ctx: ClosedCompositionContext, inBranch: boolean): string {
  if (!ctx.known("unevaluatedProperties")) {
    return inBranch
      ? "Remove the close from this branch, or declare these properties beside it."
      : "Remove the close, or declare these properties beside it.";
  }
  return inBranch
    ? 'Remove the close from this branch and put "unevaluatedProperties": false on the enclosing composition.'
    : 'Use "unevaluatedProperties": false here instead.';
}

function message(
  path: string,
  dead: readonly string[],
  patternsOnly: boolean,
  ctx: ClosedCompositionContext,
  inBranch: boolean,
): string {
  const where = path.length === 0 ? "<root>" : `"${path}"`;
  const what = patternsOnly
    ? 'every property the composed "patternProperties" can match'
    : `properties the composed schemas declare (${renderNames(dead)})`;
  return (
    `"additionalProperties": false at ${where} rejects ${what}; ` +
    `"additionalProperties" only sees properties declared beside it. ${advice(ctx, inBranch)}`
  );
}

/**
 * The verdict for one close, given what the schemas around it declare.
 *
 * Returns the dead names, or `undefined` where the rule has to stay
 * silent. Silence covers three cases and they are not the same: a
 * `$ref` that could not be followed (the set is unknown), an adjacent
 * `patternProperties` on the closing node (it may match the composed
 * names, and deciding that is pattern containment), and nothing dead.
 */
function verdict(
  closed: Obj,
  declared: Declarations,
  ctx: ClosedCompositionContext,
): { dead: string[]; patternsOnly: boolean } | undefined {
  if (declared.unresolved) return undefined;
  if (coversByPattern(closed, ctx)) return undefined;

  const adjacent = new Set(coveredNames(closed, ctx));
  const dead = [...declared.names].filter((name) => !adjacent.has(name));
  if (dead.length > 0) return { dead, patternsOnly: false };

  // A composed `patternProperties` with no dead name to point at. Only
  // reportable where the close declares no names of its own: with one,
  // the pattern may match exactly those and nothing else.
  if (declared.patterns && adjacent.size === 0) return { dead: [], patternsOnly: true };
  return undefined;
}

/**
 * The close is on the visited node and the composition hangs off it.
 *
 * Every branch below the node is evaluated under the node, so the close
 * applies to any instance that reaches one.
 */
export function collectClosedCompositionIssue(
  node: Obj,
  path: string,
  ctx: ClosedCompositionContext,
): SchemaLintIssue | undefined {
  if (!isClosed(node, ctx)) return undefined;

  // Seeded with the node itself rather than with its applicators. The
  // node's own names land in the declared set and are subtracted again
  // as the adjacent set, so they cancel, and a node carrying no
  // composition at all reaches the same "nothing dead" answer without
  // needing a guard of its own.
  const declared = declarationsFrom([node], ctx);
  const found = verdict(node, declared, ctx);
  if (found === undefined) return undefined;
  return {
    code: "unsatisfiable/composed-properties",
    keyword: "additionalProperties",
    path,
    message: message(path, found.dead, found.patternsOnly, ctx, false),
  };
}

/** A closed `allOf` branch, with the route the walk took to reach it. */
interface ClosedBranch {
  readonly node: Obj;
  readonly segments: readonly (string | number)[];
}

/**
 * Closed branches reachable from `node` through inline `allOf` only.
 *
 * Inline, so a close written inside a shared component is out of scope:
 * whether that component is wrong depends on which composition reached
 * it, and the answer belongs to a use-site-framed rule. See the
 * coverage note in docs/strictness.md.
 */
function closedBranches(
  node: Obj,
  ctx: ClosedCompositionContext,
  depth = 0,
  segments: readonly (string | number)[] = [],
): ClosedBranch[] {
  if (depth > MAX_DEPTH || !live(node, "allOf", ctx)) return [];
  const branches = node["allOf"];
  if (!Array.isArray(branches)) return [];
  const out: ClosedBranch[] = [];
  for (const [index, branch] of branches.entries()) {
    if (!isObj(branch)) continue;
    const here = [...segments, "allOf", index];
    if (isClosed(branch, ctx)) out.push({ node: branch, segments: here });
    out.push(...closedBranches(branch, ctx, depth + 1, here));
  }
  return out;
}

/**
 * `allOf[0].allOf[1]`, prefixed by the enclosing node's path. The
 * segments alternate keyword and index, which is the shape
 * {@link closedBranches} builds them in.
 */
function renderBranchPath(path: string, segments: readonly (string | number)[]): string {
  let rendered = path;
  for (const segment of segments) {
    if (typeof segment === "number") rendered = `${rendered}[${segment}]`;
    else rendered = rendered.length === 0 ? segment : `${rendered}.${segment}`;
  }
  return rendered;
}

/**
 * The close is on an `allOf` branch and a sibling declares the
 * properties.
 *
 * Reported from the enclosing node because that is the only place the
 * branch's siblings are visible, and positioned at the branch because
 * that is the text to edit.
 *
 * `reported` carries the *paths* answered here, so the per-node check
 * above does not report the same close again; pre-order means the
 * enclosing node is always visited first. Paths rather than schema
 * objects, because one object reached at two structural positions is
 * two places a reader may have to edit and each deserves its own
 * finding. `walkSubschemas` deduplicates ref targets and never
 * structural positions, for that reason, and this follows it.
 */
export function collectClosedBranchIssues(
  node: Obj,
  path: string,
  ctx: ClosedCompositionContext,
  reported: Set<string>,
): { issue: SchemaLintIssue; segments: readonly (string | number)[] }[] {
  const branches = closedBranches(node, ctx);
  if (branches.length === 0) return [];

  // One walk for every branch: the set each close is measured against is
  // the whole composition, and the branch's own names are subtracted
  // from it rather than kept out of it.
  const declared = declarationsFrom([node], ctx);

  const out: { issue: SchemaLintIssue; segments: readonly (string | number)[] }[] = [];
  for (const branch of branches) {
    // Nested `allOf` puts one branch position in reach of more than one
    // enclosing node. Pre-order means the outermost reached it first,
    // with the largest set of declarations, so its finding is the one
    // that stands.
    const full = renderBranchPath(path, branch.segments);
    if (reported.has(full)) continue;
    const found = verdict(branch.node, declared, ctx);
    if (found === undefined) continue;
    reported.add(full);
    out.push({
      issue: {
        code: "unsatisfiable/composed-properties",
        keyword: "additionalProperties",
        path: full,
        message: message(full, found.dead, found.patternsOnly, ctx, true),
      },
      segments: branch.segments,
    });
  }
  return out;
}
