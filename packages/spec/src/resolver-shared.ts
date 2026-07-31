/**
 * Pure (no-I/O) helpers shared by the async {@link resolveSpec} and the
 * synchronous `resolveSpecSync` resolvers. The two resolvers keep
 * separate walk skeletons because one interleaves `await reader.read`
 * and the other a synchronous `reader.read` (JS function coloring), but
 * every sub-step that never touches the reader lives here so the URI
 * math and `$ref`-rewriting logic exists in exactly one place. A change
 * to stitch-pointer construction or relative-URI resolution lands for
 * both paths at once; the sync/async parity suite guards the rest.
 *
 * @packageDocumentation
 */

import { escapePointerSegment, setSpecKey } from "@oaverify/internal-core";
import { dirname, isAbsolute, posix, resolve as resolvePath } from "node:path";

/** Mutable object view used while walking parsed JSON documents. */
export type Mutable = Record<string, unknown>;

/**
 * Resolve a (possibly relative) `$ref` path against the current base
 * URI. Mirrors how the matcher treats `file:` / `http(s):` bases vs.
 * bare relative paths; the relative branch keeps memory-reader keys
 * relative so in-memory fixtures resolve by the same keys they were
 * registered under.
 */
export function resolveRelative(base: string, rel: string): string {
  if (/^(https?|file):/i.test(rel)) return rel;
  if (/^(https?|file):/i.test(base)) {
    return new URL(rel, base.endsWith("/") ? base : base + "/").toString();
  }
  if (isAbsolute(rel)) return resolvePath(rel);
  if (isAbsolute(base)) return resolvePath(base, rel);
  // Relative (test-friendly): use posix.join so memory keys stay keyed relatively.
  const joined = posix.join(base === "" || base === "." ? "" : base, rel);
  return joined.replace(/^\.\//, "");
}

/** Directory of a URI, used as the base for refs found inside it. */
export function baseDirOf(uri: string): string {
  return dirname(uri);
}

/**
 * Root field the resolver materialises circular non-schema externals
 * under.
 *
 * An `x-` extension because OpenAPI allows those on the root object and
 * allows nothing else there: the previous home, a root `$defs`, is not a
 * legal OpenAPI field, so `check` reported the resolver's own output as
 * non-conformant on any spec that reached this path (#559).
 *
 * Only non-schema cycles land here. External *schema* targets are hoisted
 * into `components.schemas` and addressed by name.
 */
export const EXTERNALS_FIELD = "x-oaverify-externals";

/**
 * Encode a URI for use as an {@link EXTERNALS_FIELD} key
 * (JSON-pointer-safe). The core escape under the name that says what
 * this call is for; see `escapePointer` in the validator's document
 * walk for why these are one function rather than copies.
 */
export const encodeUri = escapePointerSegment;

/** Strip a single leading slash from a JSON-pointer fragment. */
export function encodeFragment(fragment: string): string {
  return fragment.replace(/^\//, "");
}

/**
 * The internal `$ref` an external `$ref` collapses to: a pointer into
 * `#/$defs/__ext__/<encoded-uri>` (plus the encoded fragment, if any).
 */
export function makeStitchRef(targetUri: string, fragment: string): { $ref: string } {
  return {
    $ref: `#/${EXTERNALS_FIELD}/${encodeUri(targetUri)}${fragment ? `/${encodeFragment(fragment)}` : ""}`,
  };
}

/**
 * Rewrite an internal `#/...` ref that was found inside an inlined
 * external subtree so it points at that external's stitched location
 * rather than at the root document. `fragmentAfterHash` is the ref
 * minus its leading `#`.
 */
export function rewriteInternalRefTarget(
  externalSourceUri: string,
  fragmentAfterHash: string,
): string {
  const encoded = encodeUri(externalSourceUri);
  if (fragmentAfterHash === "" || fragmentAfterHash === "/") {
    return `#/${EXTERNALS_FIELD}/${encoded}`;
  }
  return `#/${EXTERNALS_FIELD}/${encoded}${fragmentAfterHash.startsWith("/") ? fragmentAfterHash : `/${fragmentAfterHash}`}`;
}

/**
 * Canonical identity of an external target: the URI plus its fragment.
 * Two `$ref`s spelled differently but denoting the same schema share
 * this key, which is what makes hoisting dedupe rather than duplicate.
 */
export function targetKey(uri: string, fragment: string): string {
  return `${uri}#${fragment.replace(/^\//, "")}`;
}

/**
 * Trim leading and trailing underscores without a regex.
 *
 * `/^_+|_+$/` reads better and is a polynomial-ReDoS hazard on
 * library input (`js/polynomial-redos`): the name derives from a URI in
 * the user's spec, so a filename of many underscores drives the
 * backtracking. Scanning from each end is linear and needs no
 * justification.
 */
function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;
  return value.slice(start, end);
}

/** Component-name character set OpenAPI allows: `^[a-zA-Z0-9._-]+$`. */
function sanitizeName(raw: string): string {
  const cleaned = trimUnderscores(raw.replace(/[^a-zA-Z0-9._-]/g, "_"));
  return cleaned === "" ? "Schema" : cleaned;
}

/**
 * Short, stable discriminator appended when a derived name collides.
 * Derived from the canonical target rather than from encounter order, so
 * an unrelated change to traversal order cannot rename a component and
 * churn every diagnostic that mentions it.
 */
function stableSuffix(key: string): string {
  // FNV-1a, 32-bit. Not cryptographic; it only has to be stable and
  // spread well enough that two colliding names differ.
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

/**
 * Name to give a hoisted external schema.
 *
 * A fragment naming a component (`x.yaml#/components/schemas/Pet`) is
 * the common case and keeps its own name (`Pet`), which is what makes
 * the output readable and what a reader of the original files expects.
 * Otherwise the file's basename carries the meaning, optionally with the
 * fragment tail appended.
 */
export function deriveComponentName(uri: string, fragment: string): string {
  const tail = fragment.replace(/^\//, "").split("/").filter(Boolean);
  const fromComponents =
    tail.length >= 3 && tail[0] === "components" && tail[1] === "schemas" ? tail.at(-1) : undefined;
  if (fromComponents !== undefined) return sanitizeName(fromComponents);

  const base = (uri.split("/").pop() ?? uri).replace(/\.(ya?ml|json)$/i, "");
  if (tail.length === 0) return sanitizeName(base);
  return sanitizeName(`${base}_${tail.join("_")}`);
}

/**
 * Assigns each external schema target a unique `components.schemas`
 * name, and remembers the assignment so every `$ref` to that target
 * lands on the same component.
 *
 * `reserved` seeds the names already taken by the entry document's own
 * components, so hoisting can never shadow a schema the author wrote.
 */
export class HoistNames {
  private readonly byTarget = new Map<string, string>();
  private readonly taken: Set<string>;

  constructor(reserved: Iterable<string>) {
    this.taken = new Set(reserved);
  }

  /**
   * Bind a target to a name the author already chose.
   *
   * Used when a `components.schemas` entry is itself nothing but a
   * `$ref` to an external file: the target belongs in that slot, under
   * that name. Without this, hoisting would invent a second component
   * and leave the author's name as a pointer to it, adding a level of
   * indirection nobody wrote.
   */
  bind(uri: string, fragment: string, name: string): void {
    const key = targetKey(uri, fragment);
    if (this.byTarget.has(key)) return;
    this.byTarget.set(key, name);
    this.taken.add(name);
  }

  /** Name for a target, assigning one on first request. */
  nameFor(uri: string, fragment: string): string {
    const key = targetKey(uri, fragment);
    const existing = this.byTarget.get(key);
    if (existing !== undefined) return existing;

    const base = deriveComponentName(uri, fragment);
    let name = base;
    if (this.taken.has(name)) name = `${base}_${stableSuffix(key)}`;
    // Two different targets whose derived names *and* hashes collide is
    // vanishingly unlikely; widen deterministically rather than loop
    // forever if it happens.
    let widen = 2;
    while (this.taken.has(name)) {
      name = `${base}_${stableSuffix(key)}_${widen}`;
      widen += 1;
    }
    this.taken.add(name);
    this.byTarget.set(key, name);
    return name;
  }

  /** Has this target already been assigned a name? */
  has(uri: string, fragment: string): boolean {
    return this.byTarget.has(targetKey(uri, fragment));
  }

  /** Every assignment made, as `canonical target -> component name`. */
  entries(): ReadonlyMap<string, string> {
    return this.byTarget;
  }
}

/** The internal `$ref` a hoisted schema target is addressed by. */
export function hoistedRef(name: string): string {
  return `#/components/schemas/${name}`;
}

/**
 * Merge hoisted schemas into `components.schemas`, preserving whatever
 * the entry document already declared. Mutates `resolved` in place.
 */
export function mergeHoistedSchemas(resolved: object, hoisted: Mutable): void {
  if (Object.keys(hoisted).length === 0) return;
  const rootObj = resolved as Mutable;
  const components = (rootObj.components ?? {}) as Mutable;
  const schemas = (components.schemas ?? {}) as Mutable;
  rootObj.components = { ...components, schemas: { ...schemas, ...hoisted } };
}

/** The entry document's `components.schemas` map, or an empty one. */
export function componentSchemaSlots(doc: unknown): Mutable {
  if (typeof doc !== "object" || doc === null) return {};
  const components = (doc as Mutable).components;
  if (typeof components !== "object" || components === null) return {};
  const schemas = (components as Mutable).schemas;
  if (typeof schemas !== "object" || schemas === null || Array.isArray(schemas)) return {};
  return schemas as Mutable;
}

/** Names already used by the entry document's `components.schemas`. */
export function existingSchemaNames(doc: unknown): string[] {
  if (typeof doc !== "object" || doc === null) return [];
  const components = (doc as Mutable).components;
  if (typeof components !== "object" || components === null) return [];
  const schemas = (components as Mutable).schemas;
  if (typeof schemas !== "object" || schemas === null) return [];
  return Object.keys(schemas as Mutable);
}

/** Cycle-detection key for a (uri, fragment) pair. */
export function cycleKey(targetUri: string, fragment: string): string {
  return targetUri + "#" + fragment;
}

/**
 * Merge the stitched external documents into the resolved root's
 * {@link EXTERNALS_FIELD}. Mutates `resolved` in place.
 */
export function mergeStitchedExternals(resolved: object, stitched: Mutable): void {
  const rootObj = resolved as Mutable;
  const prev = (rootObj[EXTERNALS_FIELD] ?? {}) as Mutable;
  rootObj[EXTERNALS_FIELD] = { ...prev, ...stitched };
}

export { setSpecKey };
