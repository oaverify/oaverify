import { pointerFromRefFragment } from "@oaverify/internal-core";
import {
  positionFields,
  stepPosition,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_MIXED_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
  type SubschemaPosition,
} from "../subschema-positions.js";
import type { SchemaLintIssue } from "./compiler.js";

/**
 * Applicators that constrain the *same* instance as the schema holding
 * them, so a `required` inside one may name a property declared by any
 * of its siblings rather than alongside it.
 *
 * `dependentSchemas` belongs here too: its values apply to the enclosing
 * object, conditionally on a key being present. So does `dependencies`,
 * its draft-07 spelling, whose object-valued entries mean the same
 * thing.
 */
const IN_PLACE = [
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "not",
  "dependentSchemas",
  "dependencies",
] as const;
const IN_PLACE_SET = new Set<string>(IN_PLACE);

/**
 * Promote a shared-text anchor to `scoped-definition`, leaving `node`
 * alone: text reached without a `$ref` is not shared, so there is
 * nothing to warn a reader about.
 */
function anchorAsScoped(
  at: SubschemaPosition,
): Pick<SchemaLintIssue, "pointer" | "schemaPath" | "anchor"> {
  if (at.anchor !== "definition") return at;
  return { ...at, anchor: "scoped-definition" };
}

/** Sentinel for "this instance can carry names we cannot enumerate". */
const ANY_PROPERTY = " any";

/** Bounds the in-place closure on pathological or cyclic schemas. */
const MAX_CLOSURE_DEPTH = 25;

type Obj = Record<string, unknown>;

/**
 * Resolves a `$ref` to its target, or returns `undefined` when it
 * cannot. Supplied by the compiler so the walk can see through refs it
 * has no document to resolve against: in the HTTP pipeline each
 * operation's body schema is compiled on its own, with `components`
 * reachable only through the resolver.
 */
export type RequiredLintResolver = (ref: string) => unknown;

/**
 * One move from a schema's instance to a child instance. In-place
 * applicators produce no step, since they do not change the instance.
 *
 * `any` marks a move we do not model precisely (a `propertyNames`
 * subschema constrains key strings, for example); everything below it
 * is treated as unknowable, which suppresses flagging.
 */
type Step = { k: "prop"; n: string } | { k: "items" } | { k: "addl" } | { k: "any" };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Resolve one `$ref`, preferring the compiler's resolver (which knows
 * about external schemas and the document the operation came from) and
 * falling back to a plain in-document pointer walk.
 */
function resolveRef(ref: string, root: Obj, resolve: RequiredLintResolver | undefined): unknown {
  if (resolve !== undefined) {
    try {
      const viaResolver = resolve(ref);
      if (viaResolver !== undefined) return viaResolver;
    } catch {
      // An unresolvable ref is the caller's "cannot enumerate" case,
      // not an error to raise from a lint pass.
    }
  }
  if (!ref.startsWith("#/")) return undefined;
  let target: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(target) || !(key in target)) return undefined;
    target = target[key];
  }
  return target;
}

/**
 * Every schema constraining the same instance as one of `seeds`: the
 * seeds themselves, their in-place applicator branches, and their
 * `$ref` targets, transitively.
 *
 * `unresolved` reports that a `$ref` could not be followed, which the
 * caller treats as "cannot enumerate" rather than "contributes
 * nothing" -- guessing the other way would invent findings.
 */
function closure(
  seeds: readonly unknown[],
  root: Obj,
  resolve: RequiredLintResolver | undefined,
): { schemas: Obj[]; unresolved: boolean } {
  const schemas: Obj[] = [];
  const seen = new Set<unknown>();
  let unresolved = false;

  const add = (node: unknown, depth: number): void => {
    if (depth > MAX_CLOSURE_DEPTH) {
      unresolved = true;
      return;
    }
    if (!isObj(node) || seen.has(node)) return;
    seen.add(node);
    schemas.push(node);

    const ref = node["$ref"];
    if (typeof ref === "string") {
      const target = resolveRef(ref, root, resolve);
      if (isObj(target)) add(target, depth + 1);
      else unresolved = true;
    }

    for (const kw of IN_PLACE) {
      const v = node[kw];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const b of v) add(b, depth + 1);
      } else if (kw === "dependentSchemas" || kw === "dependencies") {
        // A map of schemas. `dependencies` also carries the array form,
        // whose entries name properties rather than holding a schema.
        if (isObj(v)) {
          for (const b of Object.values(v)) if (!Array.isArray(b)) add(b, depth + 1);
        }
      } else {
        add(v, depth + 1);
      }
    }
  };

  for (const s of seeds) add(s, 0);
  return { schemas, unresolved };
}

/** The property names an instance constrained by `schemas` could carry. */
function namesOf(schemas: readonly Obj[]): Set<string> {
  const out = new Set<string>();
  for (const s of schemas) {
    const props = s["properties"];
    if (isObj(props)) for (const k of Object.keys(props)) out.add(k);
    const addl = s["additionalProperties"];
    if (addl === true || isObj(addl)) out.add(ANY_PROPERTY);
    if (isObj(s["patternProperties"])) out.add(ANY_PROPERTY);
    const unevaluated = s["unevaluatedProperties"];
    if (unevaluated === true || isObj(unevaluated)) out.add(ANY_PROPERTY);
  }
  return out;
}

/** The set of schemas constraining one instance position. */
interface Instance {
  readonly schemas: readonly Obj[];
  /** The reachable names cannot be enumerated here; suppress flagging. */
  readonly unknown: boolean;
}

const UNKNOWN_INSTANCE: Instance = { schemas: [], unknown: true };

/**
 * Every schema constraining the instance one `step` below `cur`,
 * following *every* contributor rather than only the route the walk
 * took to get there.
 *
 * This is the whole point of the rule: a `required` under
 * `allOf[0].then.properties.x` and a declaration under `properties.x`
 * constrain the same child instance, so the first is satisfied by the
 * second.
 *
 * Stepping from the parent rather than re-resolving the whole path from
 * the root is what keeps the walk cheap. The two are equivalent, since
 * resolving a path is exactly these steps applied in order, and the
 * re-resolving version made every node pay for its own depth (#511).
 */
function stepInstance(
  cur: Instance,
  step: Step,
  root: Obj,
  resolve: RequiredLintResolver | undefined,
): Instance {
  if (cur.unknown || step.k === "any") return UNKNOWN_INSTANCE;
  const next: unknown[] = [];

  for (const s of cur.schemas) {
    if (step.k === "prop") {
      const props = s["properties"];
      if (isObj(props) && Object.hasOwn(props, step.n)) next.push(props[step.n]);
      // A pattern could match this name; which one is undecidable
      // here, so stop claiming to know what the child can carry.
      if (isObj(s["patternProperties"])) return UNKNOWN_INSTANCE;
      const addl = s["additionalProperties"];
      if (isObj(addl)) next.push(addl);
    } else if (step.k === "items") {
      for (const key of ["items", "contains", "unevaluatedItems"]) {
        const v = s[key];
        if (v !== undefined) next.push(v);
      }
      const prefix = s["prefixItems"];
      if (Array.isArray(prefix)) next.push(...prefix);
    } else {
      for (const key of ["additionalProperties", "unevaluatedProperties"]) {
        const v = s[key];
        if (v !== undefined) next.push(v);
      }
      const patterns = s["patternProperties"];
      if (isObj(patterns)) next.push(...Object.values(patterns));
    }
  }

  const cl = closure(next, root, resolve);
  return cl.unresolved ? UNKNOWN_INSTANCE : { schemas: cl.schemas, unknown: false };
}

/** The child instance a descent through `key` lands on, if any. */
function stepFor(key: string, name?: string): Step | undefined {
  if (IN_PLACE_SET.has(key)) return undefined;
  switch (key) {
    case "properties":
      return { k: "prop", n: name as string };
    case "items":
    case "prefixItems":
    case "contains":
    case "unevaluatedItems":
      return { k: "items" };
    case "additionalProperties":
    case "patternProperties":
    case "unevaluatedProperties":
      return { k: "addl" };
    default:
      // `propertyNames` constrains key strings; `$defs` / `definitions`
      // are containers reached at their use sites via `$ref`, where the
      // instance position is known. Neither can be placed.
      return { k: "any" };
  }
}

/**
 * Flag `required` entries naming a property the instance can never
 * carry.
 *
 * Replaces a guard that asked whether *this* object composes, which is
 * the wrong question and failed in both directions: it over-fired on a
 * `then` or `oneOf[i]` branch whose property is declared on a sibling
 * sharing the instance, and suppressed itself on schemas that
 * legitimately compose -- exactly where the unsatisfiable cases live.
 * Measured at 2.6% signal (77 findings, 2 true positives) across 13
 * published specs, which is why it was withheld in #501.
 *
 * The question here is instead "what property names are reachable at
 * this *instance* position?". Each `required` is located by the path of
 * child-instance moves leading to it (in-place applicators contribute
 * no move, since they do not change the instance), and that path is
 * then re-resolved from the root through *every* schema that reaches
 * it. Tracking only the walk's own ancestors is not enough: under
 * `allOf[0].then.properties.x`, the names available to `x` are declared
 * by a `properties.x` on the other side of the composition.
 *
 * Three things suppress flagging outright:
 *
 * - A contributor whose `additionalProperties` / `patternProperties` /
 *   `unevaluatedProperties` permits extra names (`true` or a schema).
 *   The instance can carry names we cannot enumerate, so absence
 *   proves nothing. `additionalProperties: false` permits nothing and
 *   does not suppress.
 * - An unresolvable `$ref` anywhere in the closure, for the same reason.
 * - A `not` ancestor. `required` under `not` is a *negative* constraint
 *   ("must not have X"), and X need never be declared anywhere.
 *
 * @internal
 */
export function collectRequiredIssues(
  root: unknown,
  resolve?: RequiredLintResolver,
  pointer?: string,
  anchor?: "node" | "definition",
): SchemaLintIssue[] {
  if (!isObj(root)) return [];
  const issues: SchemaLintIssue[] = [];

  // A shared component is reached once per reference site. One
  // underlying bug would otherwise report once per site, so remember
  // which names have been reported for a given schema object.
  const reported = new Map<Obj, Set<string>>();

  // Identity keys for the visited set below. Per call rather than
  // module-level, so the numbering cannot grow without bound.
  const ids = new WeakMap<Obj, number>();
  let nextId = 0;
  const idOf = (o: Obj): number => {
    let id = ids.get(o);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      ids.set(o, id);
    }
    return id;
  };
  const keyOf = (node: Obj, cur: Instance): string =>
    cur.unknown
      ? `${idOf(node)}|?`
      : `${idOf(node)}|${cur.schemas
          .map(idOf)
          .sort((a, b) => a - b)
          .join(",")}`;

  // What a node's subtree reports depends on the node and on the set of
  // schemas constraining the instance it sits at, and on nothing else:
  // a child's set is a function of the parent's set and the step taken.
  // So a pair seen once needs no second visit. Guarding on the current
  // path instead made a diamond `$ref` graph re-walk once per distinct
  // path through it, which is exponential in depth (#511). This also
  // subsumes the cycle guard: a recursive schema revisits the same pair.
  const visited = new Set<string>();

  // Two frames, and they follow `$ref` differently on purpose. `path`
  // is the logical route and stays at the use site, because that is
  // where this rule's finding holds (see the block comment at the ref
  // hop below). `at` is the physical position of the text: it re-roots
  // at the target, because the offending `required` array is written
  // there and that is the only address that resolves.
  //
  // A node reached by two routes is visited once (`visited`), so `at`
  // names whichever route arrived first, the same caveat
  // `SchemaLintIssue.location` carries.
  const walk = (
    node: unknown,
    path: string,
    cur: Instance,
    underNot: boolean,
    at: SubschemaPosition,
  ): void => {
    if (!isObj(node)) return;
    const key = keyOf(node, cur);
    if (visited.has(key)) return;
    visited.add(key);

    // Follow `$ref` so the walk reaches component schemas, which an
    // operation-scoped compile cannot see: only a body schema's *root*
    // ref is unwrapped before compilation, so every nested `$ref`
    // target would go unvisited. The target shares this instance.
    //
    // `path` deliberately does NOT reset to `pathForRef(ref)` here,
    // unlike the well-formedness and `walkSubschemas` passes. This rule
    // reports where a `required` *applies*, and a component says
    // different things at different use sites, so the definition is the
    // wrong address for it. See the addressing rule on `pathForRef`.
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const target = resolveRef(ref, root, resolve);
      // The physical frame does re-root here, unlike `path`. Both are
      // right: `path` answers "where does this apply", `at` answers
      // "where is the text", and after a ref those are different
      // places.
      //
      // Only while a frame is in scope, for the reason given at the
      // matching hop in `walkSubschemas`: a ref fragment addresses the
      // ref resolution root, not the document frame the caller
      // supplied, and a caller who supplied none gets none.
      if (isObj(target)) {
        walk(target, path, cur, underNot, {
          pointer: at.pointer === undefined ? undefined : pointerFromRefFragment(ref),
          // Shared text from here down, which for this rule means
          // `scoped-definition` on the way out.
          anchor: "definition",
        });
      }
    }

    const required = node["required"];
    if (!underNot && Array.isArray(required)) {
      if (!cur.unknown) {
        const available = namesOf(cur.schemas);
        if (!available.has(ANY_PROPERTY)) {
          let seenNames = reported.get(node);
          if (seenNames === undefined) {
            seenNames = new Set<string>();
            reported.set(node, seenNames);
          }
          for (const name of required) {
            if (typeof name !== "string" || available.has(name)) continue;
            if (seenNames.has(name)) continue;
            seenNames.add(name);
            issues.push({
              code: "silent-rewrite/required-not-in-properties",
              keyword: "required",
              path,
              // This rule's verdict depends on the route taken to the
              // node: it asks which property names are reachable at an
              // *instance* position, and a component says different
              // things at different use sites. So where the pointer
              // names shared text, it names text that may be perfectly
              // correct for the definition's other users, and
              // `definition` would send a reader to fix something that
              // is not broken.
              ...anchorAsScoped(positionFields(stepPosition(at, "required"))),
              message:
                path.length === 0
                  ? `required: "${name}" at <root> is not declared in properties reachable here (likely a typo)`
                  : `required: "${name}" at "${path}" is not declared in properties reachable here (likely a typo)`,
            });
          }
        }
      }
    }

    // Descend using the shared position vocabulary rather than treating
    // every object value as a map: `items` holds a schema directly while
    // `properties` holds schemas one level down, and conflating them
    // reads a schema's own keywords as if they were subschemas.
    const descend = (
      v: unknown,
      childPath: string,
      key: string,
      childAt: SubschemaPosition,
      name?: string,
    ): void => {
      const step = stepFor(key, name);
      walk(
        v,
        childPath,
        step === undefined ? cur : stepInstance(cur, step, root, resolve),
        underNot || key === "not",
        childAt,
      );
    };

    for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
      const v = node[key];
      if (v === undefined) continue;
      descend(v, path === "" ? key : `${path}.${key}`, key, stepPosition(at, key));
    }

    for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
      const v = node[key];
      if (!Array.isArray(v)) continue;
      for (const [i, item] of v.entries()) {
        descend(
          item,
          path === "" ? `${key}[${i}]` : `${path}.${key}[${i}]`,
          key,
          stepPosition(stepPosition(at, key), i),
        );
      }
    }

    // `dependentSchemas` is already in the constant; it was appended by
    // hand here as well.
    for (const key of [...SUBSCHEMA_MAP_POSITIONS, ...SUBSCHEMA_MIXED_MAP_POSITIONS]) {
      const v = node[key];
      if (!isObj(v)) continue;
      for (const [name, sub] of Object.entries(v)) {
        // A mixed map's array entries name properties; there is no
        // schema to descend into.
        if (Array.isArray(sub)) continue;
        descend(
          sub,
          path === "" ? `${key}.${name}` : `${path}.${key}.${name}`,
          key,
          stepPosition(stepPosition(at, key), name),
          name,
        );
      }
    }
  };

  const rootClosure = closure([root], root, resolve);
  walk(
    root,
    "",
    rootClosure.unresolved ? UNKNOWN_INSTANCE : { schemas: rootClosure.schemas, unknown: false },
    false,
    { pointer, schemaPath: [], anchor: anchor ?? "node" },
  );
  return issues;
}
