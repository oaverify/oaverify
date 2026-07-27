/**
 * The compile-time classifier. Walks a resolved schema (and its `$ref`
 * graph), assigns each subschema node a {@link Strategy}, and fails fast
 * on anything it cannot soundly stream.
 *
 * Two correctness properties the classifier guarantees:
 *
 *   - **`$ref` is a graph problem, not a tree walk.** A node's strategy
 *     is the join of its own keywords and the strategies it reaches
 *     through composition branches, the `contains` predicate, and `$ref`
 *     targets. Because `$ref` can form cycles, the strategies are a
 *     least fixed point over that join graph: every node in a ref cycle
 *     ends up with the cycle's joined strategy (a recursive schema that
 *     is STREAM throughout stays STREAM; one whose cycle reaches a BUFFER
 *     node is BUFFER everywhere in the cycle).
 *   - **Fast-fail.** `unevaluated*`, an unknown keyword, or an
 *     unresolvable `$ref` throws {@link ClassifierError} naming the
 *     keyword and JSON path, before any byte is read. Never a
 *     half-working validator.
 *
 * Per-member / per-item applicators (`properties`, `items`, ...) do not
 * propagate their child strategies up: a BUFFER property value
 * materializes just that subtree, leaving the enclosing scope on the
 * spine. Composition (`allOf` / `anyOf` / `oneOf` / `not` / `if`), the
 * `contains` predicate, and `$ref` do propagate.
 *
 * @packageDocumentation
 */

import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import {
  type Dialect,
  jsonSchemaDialect,
  keywordDefinitions,
  walkSubschemas,
} from "@oaverify/internal-schema";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-schema/internals";
import { resolveRef as resolveRefLocal } from "../ref-resolve.js";
import { KEYWORD_CATEGORY } from "./keyword-table.js";
import { joinStrategy, type Strategy } from "./strategy.js";

// Recognized schema-valued positions are structural containers, not
// "unknown" keywords, even when not in KEYWORD_CATEGORY (e.g. draft-07
// `definitions`). Their contents are reached by the walk / `$ref`.
const SUBSCHEMA_POSITIONS = new Set<string>([
  ...SUBSCHEMA_SINGLE_POSITIONS,
  ...SUBSCHEMA_ARRAY_POSITIONS,
  ...SUBSCHEMA_MAP_POSITIONS,
]);

/**
 * A compile-time classification failure: a keyword or `$ref` the engine
 * cannot soundly stream. `path` is the JSON path to the offending node;
 * `keyword` names the keyword when the failure is keyword-specific.
 *
 * @public
 */
export class ClassifierError extends Error {
  readonly path: string;
  readonly keyword: string | undefined;
  constructor(message: string, path: string, keyword?: string) {
    super(`${message} (at ${path === "" ? "<root>" : path})`);
    this.name = "ClassifierError";
    this.path = path;
    this.keyword = keyword;
  }
}

/** A sound-but-unbounded dimension the caller may want to cap. */
export interface ClassifierWarning {
  path: string;
  kind: "unbounded-string" | "unbounded-unique-items";
  message: string;
}

/** Options for {@link classify}. */
export interface ClassifyOptions {
  /** Dialect whose keyword set the classifier reads. Default `jsonSchemaDialect`. */
  dialect?: Dialect;
  /** Names of custom keywords registered with the in-memory compiler (delegable -> BUFFER). */
  customKeywords?: Iterable<string>;
  /** Force `anyOf` / `oneOf` to BUFFER (exact in-memory message parity). */
  parity?: boolean;
  /** Turn unbounded-* warnings into a thrown {@link ClassifierError}. */
  enforceBounds?: boolean;
}

/** The result of classifying a schema. */
export interface Classification {
  /** Strategy for a node. Boolean schemas and unknown nodes are `stream`. */
  strategyOf(node: SchemaOrBoolean): Strategy;
  /** Strategy of the root schema. */
  readonly root: Strategy;
  /** True iff every node classified as `stream` (no TEE / BUFFER anywhere). */
  readonly fullyStreamable: boolean;
  /** Sound-but-unbounded dimensions (empty under `enforceBounds`, which throws instead). */
  readonly warnings: readonly ClassifierWarning[];
  /** Number of distinct object nodes classified. */
  readonly nodeCount: number;
}

function isObjectSchema(s: unknown): s is SchemaObject {
  return typeof s === "object" && s !== null && !Array.isArray(s);
}

function joinPath(base: string, rel: string): string {
  if (rel === "") return base;
  return base === "" ? rel : `${base}.${rel}`;
}

/**
 * Resolve a `$ref` against the document root, throwing
 * {@link ClassifierError} (with path) on anything unresolvable. Wraps the
 * shared local resolver so a dangling or external ref fails the compile
 * rather than silently classifying as STREAM.
 */
function resolveRef(root: SchemaObject, ref: string, path: string): SchemaOrBoolean {
  const target = resolveRefLocal(root, ref);
  if (target === undefined) throw new ClassifierError(`unresolvable $ref "${ref}"`, path, "$ref");
  return target;
}

function compositionBranches(node: SchemaObject, key: string): SchemaOrBoolean[] {
  if (key === "not") return node.not === undefined ? [] : [node.not];
  if (key === "if") {
    return [node.if, node.then, node.else].filter((s): s is SchemaOrBoolean => s !== undefined);
  }
  const arr = (node as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr as SchemaOrBoolean[]) : [];
}

function hasComplexCandidate(node: SchemaObject, key: string): boolean {
  const complex = (v: unknown): boolean => typeof v === "object" && v !== null;
  if (key === "enum") return Array.isArray(node.enum) && node.enum.some(complex);
  return complex(node.const);
}

/**
 * Classify a resolved schema. Throws {@link ClassifierError} on an
 * unstreamable keyword, an unknown keyword, or an unresolvable `$ref`.
 *
 * @public
 */
export function classify(root: SchemaOrBoolean, options: ClassifyOptions = {}): Classification {
  const dialect = options.dialect ?? jsonSchemaDialect;
  const parity = options.parity ?? false;
  const customKeywords = new Set(options.customKeywords ?? []);

  // Keywords folded into another via `implements` (then/else into if;
  // minContains/maxContains into contains). These have no table entry of
  // their own, so the unknown-keyword check must not flag them. Note: a
  // dispatching keyword that is registered but missing from
  // KEYWORD_CATEGORY is deliberately NOT in this set, so it falls through
  // to REJECT (the runtime backstop for a consumer on a newer
  // @oaverify/internal-schema; the drift test catches it in-repo).
  const folded = new Set<string>();
  for (const def of keywordDefinitions(dialect).values()) {
    for (const impl of def.implements ?? []) folded.add(impl);
  }

  if (!isObjectSchema(root)) {
    // A boolean root schema streams trivially.
    return {
      strategyOf: () => "stream",
      root: "stream",
      fullyStreamable: true,
      warnings: [],
      nodeCount: 0,
    };
  }

  // Collect every reachable object node (containment via walkSubschemas,
  // plus $ref targets that may sit outside the walked positions, e.g.
  // under an OpenAPI `components`). Record a path per node for errors.
  const pathOf = new Map<SchemaObject, string>();
  const refTargets: Array<{ ref: string; from: string }> = [];

  const addTree = (subroot: SchemaOrBoolean, base: string): void => {
    walkSubschemas(subroot, (s, rel) => {
      if (!isObjectSchema(s)) return undefined;
      if (pathOf.has(s)) return false; // already collected; prune the re-walk
      const p = joinPath(base, rel);
      pathOf.set(s, p);
      // Follow both `$ref` and `$dynamicRef` so a target reachable only
      // through a non-walked container (e.g. `components`) is classified.
      const ref = s.$ref ?? s.$dynamicRef;
      if (typeof ref === "string") refTargets.push({ ref, from: p });
      return undefined;
    });
  };
  addTree(root, "");
  // Follow refs to pull in out-of-containment targets (and validate them).
  for (let i = 0; i < refTargets.length; i++) {
    const { ref, from } = refTargets[i] as { ref: string; from: string };
    const target = resolveRef(root, ref, from);
    if (isObjectSchema(target) && !pathOf.has(target)) addTree(target, `${from}->$ref`);
  }

  const nodes = [...pathOf.keys()];
  const warnings: ClassifierWarning[] = [];

  // Per-node base strategy + join-successors (composition branches,
  // contains predicate, $ref target).
  const base = new Map<SchemaObject, Strategy>();
  const successors = new Map<SchemaObject, SchemaObject[]>();

  for (const node of nodes) {
    const path = pathOf.get(node) as string;
    let b: Strategy = "stream";
    const succ: SchemaObject[] = [];
    const pushSucc = (s: SchemaOrBoolean | undefined): void => {
      if (isObjectSchema(s)) succ.push(s);
    };

    for (const key of Object.keys(node)) {
      const cat = KEYWORD_CATEGORY[key];
      if (cat === undefined) {
        if (folded.has(key)) continue; // folded keyword (then/else/min|maxContains)
        if (SUBSCHEMA_POSITIONS.has(key)) continue; // structural container (e.g. definitions)
        // A `$ref`-target container, not a validation keyword. Its
        // referenced members are pulled in and classified via the
        // ref-follow pass above; the container itself asserts nothing.
        if (key === "components") continue;
        if (customKeywords.has(key)) {
          b = joinStrategy(b, "buffer");
          continue;
        }
        if (key.startsWith("x-")) continue; // OpenAPI specification extension: ignored
        throw new ClassifierError(`unsupported keyword "${key}"`, path, key);
      }
      switch (cat) {
        case "reject":
          throw new ClassifierError(`"${key}" cannot be streamed`, path, key);
        case "scalar":
        case "annotation":
        case "member":
          break; // no base contribution; member children classified at their own node
        case "value-equality":
          if (hasComplexCandidate(node, key)) b = joinStrategy(b, "buffer");
          break;
        case "contains":
          pushSucc(node.contains);
          break;
        case "composition": {
          const compBase: Strategy =
            parity && (key === "anyOf" || key === "oneOf") ? "buffer" : "tee";
          b = joinStrategy(b, compBase);
          for (const branch of compositionBranches(node, key)) pushSucc(branch);
          break;
        }
        case "buffer":
          b = joinStrategy(b, "buffer");
          break;
        case "dependencies": {
          const deps = (node as Record<string, unknown>).dependencies;
          if (isObjectSchema(deps)) {
            for (const entry of Object.values(deps)) {
              if (!Array.isArray(entry)) b = joinStrategy(b, "buffer"); // schema-form entry
            }
          }
          break;
        }
        case "ref":
          pushSucc(resolveRef(root, (node as Record<string, unknown>)[key] as string, path));
          break;
      }
    }

    // Unbounded-dimension warnings.
    if ((node.pattern !== undefined || node.format !== undefined) && node.maxLength === undefined) {
      warnings.push({
        path,
        kind: "unbounded-string",
        message: `string at ${path || "<root>"} has pattern/format but no maxLength (unbounded buffered scalar)`,
      });
    }
    if (node.uniqueItems === true && node.maxItems === undefined) {
      warnings.push({
        path,
        kind: "unbounded-unique-items",
        message: `uniqueItems at ${path || "<root>"} has no maxItems (seen-hash set is O(array length))`,
      });
    }

    base.set(node, b);
    successors.set(node, succ);
  }

  if (options.enforceBounds && warnings.length > 0) {
    const first = warnings[0] as ClassifierWarning;
    throw new ClassifierError(`enforceBounds: ${first.message}`, first.path);
  }

  // Least fixed point of strategy(n) = base(n) ⊔ ⊔ strategy(succ(n)).
  const strat = new Map<SchemaObject, Strategy>(base);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      let s = base.get(node) as Strategy;
      for (const c of successors.get(node) as SchemaObject[])
        s = joinStrategy(s, strat.get(c) as Strategy);
      if (s !== strat.get(node)) {
        strat.set(node, s);
        changed = true;
      }
    }
  }

  return {
    strategyOf: (n: SchemaOrBoolean) => (isObjectSchema(n) ? (strat.get(n) ?? "stream") : "stream"),
    root: strat.get(root) ?? "stream",
    fullyStreamable: nodes.every((n) => strat.get(n) === "stream"),
    warnings,
    nodeCount: nodes.length,
  };
}
