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
 *
 * Put the other way round: where a caller makes the entry reachable
 * under two reader keys, only the entry's own normalised key family is
 * recognised, and the second key stays external. Treating it as the
 * entry would mean proving that two keys name one document, which is a
 * claim about the reader rather than about the URIs.
 */
export function entryIdentity(entry: string): string {
  return resolveRelative(baseDirOf(entry), basename(entry));
}

/** A pointer naming one entry of one `components` category. */
const COMPONENT_POINTER = /^\/components\/[^/]+\/[^/]+$/;

/**
 * Record a component of the entry document that a reference reached and
 * the walk inlined at the use site.
 *
 * Non-schema positions inline, so after resolution nothing in the
 * document reaches the component the author declared, and
 * `unused-component` reports it (#612). The rule is answering correctly
 * about a document that no longer reflects what was written, and this
 * is the one thing it cannot see for itself. Collected here rather than
 * recomputed, because only the walk knows which references it followed.
 *
 * `fragment` is the reference's fragment, an RFC 6901 pointer with its
 * leading slash, and is kept only when it names a component; anything
 * else has no entry for the lint pass to stay quiet about.
 */
export function noteInlinedComponent(into: Set<string>, fragment: string): void {
  if (COMPONENT_POINTER.test(fragment)) into.add(fragment);
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
 * `#/x-oaverify-externals/<encoded-uri>` (plus the encoded fragment, if
 * any). See {@link EXTERNALS_FIELD}.
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

/**
 * Remove a `components.schemas` entry the author wrote, because the
 * external target it named could not be read.
 *
 * Only reached under `onUnresolved: "record"`, and only for a slot
 * {@link HoistNames.bind} bound to an external target: that slot said
 * "this component is that file", the walk rewrote it to point at the
 * name it was going to be hoisted into, and with the file missing it
 * would otherwise be left pointing at itself. A self-reference compiles
 * and grades clean, which is the one outcome a hole must never produce.
 * Removing it leaves every use site referring to a component that is not
 * there, which is the hole shape every other position produces.
 */
export function removeComponentSchema(resolved: object, name: string): void {
  const components = (resolved as Mutable).components;
  if (typeof components !== "object" || components === null || Array.isArray(components)) return;
  const schemas = (components as Mutable).schemas;
  if (typeof schemas !== "object" || schemas === null || Array.isArray(schemas)) return;
  delete (schemas as Mutable)[name];
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

/**
 * Wrap a fragment that did not resolve with the document it was looked
 * up in and the document that referenced it.
 *
 * Worded like {@link wrapReadError} because it answers the same
 * question one step further in: the file was found, the node inside it
 * was not. A bare pointer error names neither end of the edge, and in
 * an editor this is the commoner of the two failures, since a fragment
 * is half-typed for as long as it takes to type the rest of it.
 */
export function wrapFragmentError(
  err: unknown,
  uri: string,
  fragment: string,
  referrer: string | null,
): Error {
  const cause = err instanceof Error ? err.message : String(err);
  const from = referrer === null || referrer === uri ? "" : ` (referenced from ${referrer})`;
  return new Error(`failed to resolve ${uri}#${fragment}${from}: ${cause}`, { cause: err });
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

/**
 * Assert that the entry document is one an OpenAPI document could be.
 *
 * An OpenAPI document is an object. Without this the loaders passed a
 * scalar straight through: an empty or comment-only YAML file parses to
 * `null`, and `loadSpecSync` returned `{ document: null }` and threw
 * nothing, so the failure surfaced much later inside `createValidator`
 * as something unrelated-looking (#850).
 *
 * Only the *entry* is constrained. A `$ref` target may legitimately be
 * other shapes, a boolean schema being the obvious one, and the
 * position that consumes it reports a better error than this could:
 * `assertWellFormedSchema` names the pointer.
 *
 * The reader layer answers the narrower question of whether a file
 * contained a document at all; this answers whether the caller was
 * handed a spec.
 *
 * @internal
 */
export function assertEntryDocument(document: unknown, entry: string): void {
  if (typeof document === "object" && document !== null && !Array.isArray(document)) return;

  const got =
    document === null
      ? "null"
      : document === undefined
        ? "nothing at all"
        : Array.isArray(document)
          ? "an array"
          : `a ${typeof document}`;
  throw new Error(
    `${entry} is not an OpenAPI document: expected an object, got ${got}. ` +
      `A spec's entry document is an object with an "openapi" field.`,
  );
}

/**
 * What a read answers with when it failed and the resolver was told to
 * record rather than throw.
 *
 * A symbol rather than `undefined` or `null`, because both of those are
 * legal parsed documents: a YAML file holding nothing but comments
 * parses to `null`, and a reader is free to answer with either.
 */
export const UNREADABLE: unique symbol = Symbol("oaverify.unreadable");

/**
 * A reference the resolver was asked to follow and could not.
 *
 * Produced only under `onUnresolved: "record"`. The same failure that
 * throws under the default mode, kept as data so the walk can carry on
 * and the caller can report it where it was written.
 *
 * `via` is what makes it locatable: a {@link SourceHop} is `uri` plus a
 * pointer to the `$ref` node itself, which is exactly the shape
 * `SpanRequest` takes, so a caller holding the file's text resolves a
 * hole to a line and column through the resolver it already uses for
 * findings. It is empty unless `provenance` was set, since that is what
 * the pointers are recorded by; `referrer` names the file either way.
 *
 * @public
 */
export interface UnresolvedRef {
  /** The target document the reference named. */
  readonly uri: string;
  /**
   * The fragment that did not resolve, present only when the document
   * was read and the node inside it was not found.
   *
   * The two failures are different edits. Absent says the file is
   * missing or unreadable, so the fix is to the filename or to the
   * filesystem. Present says the file is fine and this pointer into it
   * is not, so the fix is to the fragment. An editor drawing one
   * message for both would send a reader to the wrong half of the
   * reference.
   */
  readonly fragment?: string;
  /**
   * The document holding the reference the walk followed to reach
   * `uri`. The first one, matching {@link noteReferrer}: a target
   * several references name is read once, and this is the reference the
   * walk actually took.
   */
  readonly referrer: string;
  /**
   * The references followed to reach `uri`, outermost first, the one
   * that failed last. Empty when the resolver was not tracking
   * provenance.
   */
  readonly via: readonly SourceHop[];
  /**
   * The failure, worded exactly as the throwing mode words it.
   *
   * The serializable answer to what went wrong. Prefer it over
   * {@link UnresolvedRef.cause} anywhere the record is logged, sent
   * over a wire, or written to a file.
   */
  readonly message: string;
  /**
   * Whatever the reader threw, unchanged.
   *
   * Diagnostic, and the one field on a resolution result that does not
   * survive `JSON.stringify`: an `Error` serializes to `{}`, so a
   * caller persisting the record keeps the field name and loses its
   * contents. `message` is the field to read instead.
   *
   * Handed over rather than mined, because mining it means knowing what
   * a parser's error looks like. A YAML reader's failure carries the
   * position of the syntax error on this object, and a caller that
   * wired that reader knows the error type and can ask; this package
   * cannot, and taking a parser dependency to find out is what its role
   * forbids.
   */
  readonly cause: unknown;
}

/**
 * The holes recorded during one `record`-mode resolution, keyed by
 * target URI.
 *
 * Keyed by target rather than by reference site because that is what a
 * reader fixes: one missing file is one edit, whatever number of `$ref`s
 * name it.
 *
 * How many references named it is deliberately not reported. The count
 * this class can see is read attempts, and those do not stand in for
 * references: a schema position collapses every reference to one target
 * into a single queued read, while a non-schema position reads per
 * reference, so one document answers 1 or 3 for the same three
 * references depending on where they sit. Counting references honestly
 * means counting them where they are found, which is a separate change.
 */
export class HoleLog {
  private readonly byKey = new Map<string, UnresolvedRef>();

  /** Whether this document has already failed to read. */
  has(uri: string): boolean {
    return this.byKey.has(uri);
  }

  /**
   * Record a failed read, or count a repeat of one already recorded.
   * First writer wins for everything but the count, matching
   * {@link noteReferrer}.
   */
  record(
    uri: string,
    referrer: string,
    via: readonly SourceHop[],
    wrapped: Error,
    cause: unknown,
  ): void {
    if (this.byKey.has(uri)) return;
    this.byKey.set(uri, { uri, referrer, via, message: wrapped.message, cause });
  }

  /**
   * Record a fragment that did not resolve in a document that read.
   *
   * Keyed by document and fragment together, because one document can
   * hold the node one reference names and not the node another does.
   */
  recordFragment(
    uri: string,
    fragment: string,
    referrer: string,
    via: readonly SourceHop[],
    wrapped: Error,
    cause: unknown,
  ): void {
    const key = cycleKey(uri, fragment);
    if (this.byKey.has(key)) return;
    this.byKey.set(key, { uri, fragment, referrer, via, message: wrapped.message, cause });
  }

  /** Every hole, in the order the walk found them. */
  entries(): readonly UnresolvedRef[] {
    return [...this.byKey.values()];
  }
}
