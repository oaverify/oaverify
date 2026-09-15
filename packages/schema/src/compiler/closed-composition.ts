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

/** This rule's code, named once so the dedup below cannot drift from it. */
const CODE = "unsatisfiable/composed-properties";

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
  /** Possible dynamic bindings supplied by the document compiler. */
  dynamicTargets?: (ref: string, from: object) => readonly unknown[];

  /**
   * The compiler's `$ref` resolver, told which node the `$ref` sits in
   * so it answers in that node's resource scope: a fragment under a
   * nested `$id` names a position in that resource, not in the root.
   * It resolves exactly as codegen does, so what this rule reads is
   * what the emitted validator runs.
   *
   * `undefined` means the ref does not resolve, which this rule treats
   * as "cannot enumerate" rather than "declares nothing".
   */
  readonly resolve: (ref: string, from: Obj) => unknown;
  /**
   * OAS 3.0 drops a `$ref`'s siblings. A keyword the dialect discards
   * constrains nothing, so it neither closes an object nor declares a
   * name.
   */
  readonly refSuppressesSiblings: boolean;
  /**
   * Is this keyword in the active dialect? Every keyword the rule
   * reasons about is checked, because one the dialect does not
   * implement emits no code, and a finding resting on it would describe
   * behaviour the validator does not have. `additionalProperties` is
   * the exception that proves it: it reads its own coverage siblings
   * raw, registered or not, which is why {@link coveredNames} does not
   * consult this and {@link declaredNames} does.
   */
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
      // Resolved from this node, so a fragment under a nested `$id`
      // names a position in that resource rather than in the root. The
      // resolver answers exactly as codegen does, including where a
      // node has no recorded scope, so what this reads is what the
      // emitted validator runs.
      const target = ctx.resolve(node["$ref"], node);
      // A boolean schema is a resolved schema that declares no names,
      // which is a different answer from one that could not be
      // followed. Reading `true` as unknowable suppressed findings that
      // hold.
      if (isObj(target)) add(target, depth + 1);
      else if (typeof target !== "boolean") unresolved = true;
    }

    if (
      ctx.dynamicTargets !== undefined &&
      live(node, "$dynamicRef", ctx) &&
      typeof node["$dynamicRef"] === "string"
    ) {
      try {
        const targets = ctx.dynamicTargets(node["$dynamicRef"], node);
        if (targets.length > 1) {
          // A declaration in one possible binding need not apply here.
          unresolved = true;
        } else
          for (const target of targets) {
            if (isObj(target)) add(target, depth + 1);
            else if (typeof target !== "boolean") unresolved = true;
          }
      } catch {
        unresolved = true;
      }
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
        for (const branch of Object.values(value)) {
          if (!Array.isArray(branch)) add(branch, depth + 1);
        }
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
    code: CODE,
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
 * One close can be answered twice: by the node above it, and again by
 * its own per-node check, and a nested `allOf` puts it in reach of more
 * than one enclosing node. {@link dedupeByAddress} collapses those,
 * after the walk and on the machine address, rather than here on
 * anything this function could key.
 */
export function collectClosedBranchIssues(
  node: Obj,
  path: string,
  ctx: ClosedCompositionContext,
): {
  issue: SchemaLintIssue;
  segments: readonly (string | number)[];
  node: Obj;
  /** The dead names this report rests on, for the dedup below. */
  evidence: string;
}[] {
  const branches = closedBranches(node, ctx);
  if (branches.length === 0) return [];

  // One walk for every branch: the set each close is measured against is
  // the whole composition, and the branch's own names are subtracted
  // from it rather than kept out of it.
  const declared = declarationsFrom([node], ctx);

  const out: {
    issue: SchemaLintIssue;
    segments: readonly (string | number)[];
    node: Obj;
    evidence: string;
  }[] = [];
  for (const branch of branches) {
    const full = renderBranchPath(path, branch.segments);
    const found = verdict(branch.node, declared, ctx);
    if (found === undefined) continue;
    out.push({
      issue: {
        code: CODE,
        keyword: "additionalProperties",
        path: full,
        message: message(full, found.dead, found.patternsOnly, ctx, true),
      },
      segments: branch.segments,
      node: branch.node,
      // Serialised rather than joined on a separator: a property name
      // may contain any character, so any separator makes two different
      // sets collide, which is the mistake this key exists to avoid.
      evidence: found.patternsOnly ? "patterns" : JSON.stringify([...found.dead].sort()),
    });
  }
  return out;
}

/**
 * Identifies one visited position, for the two suppressions this rule
 * needs. They answer different questions and only one of them can be
 * settled by position alone.
 *
 * *A branch answering its own node again.* A closed `allOf` branch is
 * reported from the node above it, which is the only place its siblings
 * are visible. Its own per-node check would answer it from less, and
 * the two disagree on the repair: move the close up to the composition,
 * against swap the keyword here, which still rejects the sibling's
 * properties. Position settles this, since both sides are the same
 * object at the same visit.
 *
 * *Two branch reports of one position.* Nested `allOf` puts one branch
 * in reach of several enclosing nodes. Position settles this too, where
 * there is a position to compare.
 *
 * The most precise identity available is used, because no single one
 * covers every compile:
 *
 * - `pointer`, when the caller established a document frame.
 * - `schemaPath`, for a bare-schema caller, until a `$ref` ends it.
 * - the schema object paired with the rendered path, below a `$ref`
 *   with no pointer, where the contract has no address to offer. Each
 *   alone is wrong: one object may sit at two positions, and two
 *   positions may render one string.
 *
 * That last one is a guess rather than an identity, and it is wrong in
 * exactly the case where one object sits at two positions whose paths
 * collide. The second suppression therefore adds the report's own
 * evidence to its key, so two branch reports collapse only where they
 * rest on the same dead names; see the call site. The first suppression
 * does not, because a per-node answer at a position a branch answer
 * already covers is weaker whatever it names.
 *
 * `anchor` is always part of it, so a component visited structurally
 * and again through a `$ref` stays two findings, as it does for every
 * other rule.
 */
export function positionKey(
  node: Obj,
  path: string,
  at: { pointer?: string; schemaPath?: readonly (string | number)[]; anchor?: string },
  idOf: (node: Obj) => number,
): string {
  const address =
    at.pointer ??
    (at.schemaPath === undefined ? `o${idOf(node)}:${path}` : JSON.stringify(at.schemaPath));
  return `${at.anchor ?? ""}|${address}`;
}
