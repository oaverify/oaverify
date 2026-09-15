/**
 * Following a `$ref` from inside a lint pass.
 *
 * A lint walk crosses refs for the same reason the compiler does: an
 * operation-scoped compile reaches `components` only through the
 * resolver, so a walk that stopped at the first `$ref` would see one
 * inline schema and nothing else. What it must not do is guess. Every
 * function here reports "could not follow" to its caller rather than
 * treating an unreachable target as contributing nothing, because the
 * two are opposite answers and only one of them is safe to act on.
 *
 * Shared by the rules that need it rather than copied into each: the
 * OAS 3.0 discarded-sibling case below is subtle, `pnpm check:walkers`
 * does not police this walk, and a second copy would drift without a
 * gate noticing.
 *
 * @packageDocumentation
 */

import { refSiblingIsDiscarded } from "../ref-siblings.js";
import { forEachSubschema } from "../subschema-positions.js";

/** A plain JSON object, which is what a non-boolean schema is. */
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Resolves a `$ref` to its target, or returns `undefined` when it
 * cannot. Supplied by the compiler so a lint walk can see through refs
 * it has no document to resolve against: in the HTTP pipeline each
 * operation's body schema is compiled on its own, with `components`
 * reachable only through the resolver.
 */
export type LintRefResolver = (ref: string) => unknown;

/**
 * Does this pointer pass through a key OAS 3.0 discards?
 *
 * Under 3.0 a `$ref` suppresses its siblings, so a pointer naming one
 * of them names text the compiled validator never sees. Following it
 * would let a lint report against a constraint that is not applied.
 */
export function pointerEntersDiscardedSibling(
  root: Obj,
  ref: string,
  ignoredRefSiblingKeys: WeakMap<Obj, ReadonlySet<string>> | undefined,
): boolean {
  if (ignoredRefSiblingKeys === undefined || !ref.startsWith("#/")) return false;
  let target: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(target)) return false;
    if (ignoredRefSiblingKeys.get(target)?.has(key) === true) return true;
    target = target[key];
  }
  return false;
}

/**
 * Index every node's discarded `$ref` siblings, once, so the pointer
 * walk above can answer without re-deriving them per hop. Returns
 * `undefined` under a dialect where `$ref` does not suppress siblings,
 * which is the signal that the question does not arise.
 */
export function collectIgnoredRefSiblingKeys(
  root: Obj,
  refSuppressesSiblings: boolean,
): WeakMap<Obj, ReadonlySet<string>> | undefined {
  if (!refSuppressesSiblings) return undefined;
  const ignoredRefSiblingKeys = new WeakMap<Obj, ReadonlySet<string>>();
  const seen = new WeakSet<object>();

  const go = (node: unknown): void => {
    if (!isObj(node) || seen.has(node)) return;
    seen.add(node);
    const ignored = Object.keys(node).filter((key) => refSiblingIsDiscarded(node, key, true));
    if (ignored.length > 0) ignoredRefSiblingKeys.set(node, new Set(ignored));

    forEachSubschema(node, (value, key) => {
      if (refSiblingIsDiscarded(node, key, true)) return;
      go(value);
    });
  };

  go(root);
  return ignoredRefSiblingKeys;
}

/**
 * Resolve one `$ref`, preferring the compiler's resolver (which knows
 * about external schemas and the document the operation came from) and
 * falling back to a plain in-document pointer walk.
 */
export function resolveLintRef(
  ref: string,
  root: Obj,
  resolve: LintRefResolver | undefined,
  ignoredRefSiblingKeys: WeakMap<Obj, ReadonlySet<string>> | undefined,
): unknown {
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
  if (pointerEntersDiscardedSibling(root, ref, ignoredRefSiblingKeys)) return undefined;
  let target: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(target) || !(key in target)) return undefined;
    target = target[key];
  }
  return target;
}
