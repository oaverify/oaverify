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
import { basename, dirname, isAbsolute, posix, resolve as resolvePath } from "node:path";
import type { SourceHop, SpecRegion } from "./provenance.js";

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
 * The entry URI as a reference to it will be spelled once the walk has
 * resolved it, so the two can be compared.
 *
 * A `$ref` back into the entry document names a file, so it arrives at
 * the walk through {@link resolveRelative} like any other target.
 * Comparing that against the caller's `entry` string directly misses
 * the spellings that string can take: entry `./openapi.yaml` has its
 * own refs resolve to `openapi.yaml`, so a textual comparison answers
 * "external" for two thirds of the ways the same file can be named.
 * Putting the entry through the same function is what makes the answer
 * agree across spellings: its own directory joined with its own file
 * name, which is how a reference to it from beside it resolves.
 *
 * What this claims is narrow, and deliberately so: **the same document
 * under a reader key that differs only by path normalisation**. `docs`,
 * `sources` and the hoist names are all keyed by the reader key, and
 * this treats `./main.json` and `main.json` as one document, which is
 * true of every reader whose keys are paths. It does not claim symlink
 * identity, percent-encoding equivalence, `file:///x` against `/x`, a
 * case-insensitive filesystem, `http` against `https`, or trailing
 * slash and query variation. A reference matching the entry by any of
 * those and not by this one keeps today's behaviour, a hoisted
 * duplicate: larger than it needs to be, and correct. The permissive
 * failure is the one worth avoiding, since it would rewrite a genuine
 * external target to an internal address that need not exist.
 *
 * `ResolveSpecOptions.baseUri` is not part of this, also deliberately.
 * It redefines what a relative reference means, so with `baseUri` set a
 * ref that reads like the entry's own name resolves to a different
 * reader key, and the document served under that key is a different
 * document: hoisting it is the correct answer, and it is what happens.
 * Following `baseUri` here would let a reference that names one schema
 * be rewritten to the address of another, which is a validation change
 * wearing a deduplication's clothes. The cost is that an entry reached
 * only through `baseUri` keeps hoisting a duplicate of itself, which is
 * the conservative half of the same trade.
 */
export function entryIdentity(entry: string): string {
  return resolveRelative(baseDirOf(entry), basename(entry));
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

/**
 * Where a mounted subtree came from, as the walk currently stands.
 * Handed back by {@link ProvenanceTrail.enter} and returned to
 * {@link ProvenanceTrail.leave} so the enclosing document's answer is
 * restored on the way out.
 */
export interface MountState {
  readonly at: string;
  readonly uri: string;
  readonly pointer: string;
  readonly via: readonly SourceHop[];
}

/**
 * Records where each part of the resolved document came from, as both
 * resolvers walk.
 *
 * Exists only when provenance was asked for; the walks hold it as
 * `ProvenanceTrail | null` and reach it through `?.`, so an unasked-for
 * resolution pays one null check per node and allocates nothing. That
 * is the whole reason this is a separate object rather than fields on
 * the walk: spec load runs at startup for every server user and none of
 * them call `check`.
 *
 * The resolved-document path is a single reused array pushed and popped
 * as the walk descends. Both walks are depth-first and strictly
 * sequential (the async one awaits each child in turn and never runs
 * two branches concurrently), so a stack is enough, and a pointer string
 * is built only where a region is recorded: once per external
 * reference, not once per node.
 *
 * Shared by both resolvers rather than mirrored, so the recording rules
 * exist in one place and only the call sites are hand-mirrored.
 */
export class ProvenanceTrail {
  /** Regions recorded so far, in the order the walk found them. */
  readonly regions: SpecRegion[] = [];
  private readonly path: string[] = [];
  private at = "";
  private uri: string;
  private pointer = "";
  private via: readonly SourceHop[] = [];

  constructor(entryUri: string) {
    this.uri = entryUri;
    this.regions.push({ kind: "mounted", at: "", uri: entryUri, pointer: "", via: [] });
  }

  /**
   * Descend into a child. `segment` is a raw key or array index.
   *
   * Tested before escaping because this runs per node and the escape is
   * two regex passes: almost every key in a spec contains neither `~`
   * nor `/`, and two `includes` on a short string are much cheaper than
   * rebuilding it twice.
   */
  push(segment: string): void {
    this.path.push(
      segment.includes("~") || segment.includes("/") ? escapePointerSegment(segment) : segment,
    );
  }

  /** Come back out of a child. */
  pop(): void {
    this.path.pop();
  }

  /** RFC 6901 pointer to the node being walked, in the resolved document. */
  here(): string {
    return this.path.length === 0 ? "" : "/" + this.path.join("/");
  }

  /** The node being walked, addressed in the document it came from. */
  private sourceHere(): string {
    return this.pointer + this.here().slice(this.at.length);
  }

  /**
   * The chain that reaches a target referenced from the node being
   * walked: everything followed to get here, plus this reference.
   */
  chain(): readonly SourceHop[] {
    return [...this.via, { uri: this.uri, pointer: this.sourceHere() }];
  }

  /**
   * Record a subtree of `uri` mounted at the node being walked, and
   * answer for it until {@link leave}. This is the inlining case, where
   * the target's content replaces the reference in place.
   */
  enter(uri: string, pointer: string, via: readonly SourceHop[]): MountState {
    return this.mount(this.here(), uri, pointer, via);
  }

  /**
   * Record a subtree of `uri` mounted at an absolute position, and
   * answer for it until {@link leave}. This is relocation: a hoisted
   * schema or a stitched external is walked on its own, after the walk
   * that found it has finished, so it names where it lands rather than
   * continuing from where it was referenced.
   */
  enterAt(segments: readonly string[], uri: string, pointer: string, via: readonly SourceHop[]) {
    this.path.length = 0;
    for (const segment of segments) this.push(segment);
    return this.mount(this.here(), uri, pointer, via);
  }

  private mount(at: string, uri: string, pointer: string, via: readonly SourceHop[]): MountState {
    const saved: MountState = { at: this.at, uri: this.uri, pointer: this.pointer, via: this.via };
    this.at = at;
    this.uri = uri;
    this.pointer = pointer;
    this.via = via;
    this.regions.push({ kind: "mounted", at, uri, pointer, via });
    return saved;
  }

  /** Restore the enclosing document's answer, and its path if asked. */
  leave(saved: MountState, resetPath = false): void {
    this.at = saved.at;
    this.uri = saved.uri;
    this.pointer = saved.pointer;
    this.via = saved.via;
    if (resetPath) this.path.length = 0;
  }

  /**
   * Record that one key of the node being walked belongs to the
   * enclosing document rather than to whatever was mounted here.
   *
   * The non-schema merge `{...inlined, ...siblings}` blends two
   * documents key-wise, so provenance is recorded key-wise too: the
   * node keeps the target's address and each sibling key shadows it
   * with the referring document's. Call after {@link leave}.
   */
  shadow(key: string): void {
    const at = this.here() + "/" + escapePointerSegment(key);
    this.regions.push({
      kind: "mounted",
      at,
      uri: this.uri,
      pointer: this.pointer + at.slice(this.at.length),
      via: this.via,
    });
  }

  /** Record that a position exists only in the resolved document. */
  synthetic(at: string): void {
    this.regions.push({ kind: "synthetic", at });
  }
}

/**
 * Which document each external target was first referenced from, so a
 * read failure can name both ends of the edge that led to it.
 */
export type ReferrerTrail = Map<string, string>;

/**
 * Record the document a target was referenced from. First writer wins:
 * a target reached by several refs is read once, and the earliest
 * referrer is the one the walk actually followed to get there.
 */
export function noteReferrer(trail: ReferrerTrail, targetUri: string, referrerUri: string): void {
  if (!trail.has(targetUri)) trail.set(targetUri, referrerUri);
}

/**
 * Wrap a reader failure with the URI that failed and the document that
 * referenced it.
 *
 * A parse error from a reader carries no address of its own: JSON.parse
 * on a document reached through a `$ref` reports only the offending
 * token, which in a large spec names neither the file nor the reference
 * that pulled it in. Both ends of the edge are known here.
 */
export function wrapReadError(err: unknown, uri: string, referrer: string | null): Error {
  const cause = err instanceof Error ? err.message : String(err);
  const from = referrer === null || referrer === uri ? "" : ` (referenced from ${referrer})`;
  return new Error(`failed to read ${uri}${from}: ${cause}`, { cause: err });
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
