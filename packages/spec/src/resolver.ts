import {
  detectOpenAPIVersion,
  escapePointerSegment,
  followsRef,
  pointerFromFragment,
  refPositionFor,
  resolveJsonPointer,
  type OpenAPIDocument,
  type RefNodeKind,
} from "@oaverify/internal-core";
import type { DocumentReader } from "./reader.js";
import { lintResolvedSpec, type SpecHygieneIssue } from "./lint.js";
import {
  assertEntryDocument,
  baseDirOf,
  cycleKey,
  componentSchemaSlots,
  entryIdentity,
  existingSchemaNames,
  EXTERNALS_FIELD,
  hoistedRef,
  HoistNames,
  makeStitchRef,
  mergeHoistedSchemas,
  noteInlinedComponent,
  removeComponentSchema,
  mergeStitchedExternals,
  type MountState,
  type Mutable,
  noteReferrer,
  ProvenanceTrail,
  type ReferrerTrail,
  resolveRelative,
  rewriteInternalRefTarget,
  setSpecKey,
  targetKey,
  wrapReadError,
  wrapFragmentError,
  HoleLog,
  UNREADABLE,
  type UnresolvedRef,
} from "./resolver-shared.js";
import type { SourceHop, SpecRegion } from "./provenance.js";
import { subschemaFamilyOf } from "@oaverify/internal-core/subschema-positions";

// Re-export the canonical implementation so @oaverify/internal-spec consumers who
// imported `resolveJsonPointer` keep working. `pointerFromFragment` rides
// along because a caller holding a `$ref` needs it before the other.
export { pointerFromFragment, resolveJsonPointer };

/**
 * Options accepted by {@link resolveSpec}.
 *
 * @public
 */
export interface ResolveSpecOptions {
  /** Reader used to fetch documents by URI. */
  reader: DocumentReader;
  /** Entry URI. */
  entry: string;
  /** Base directory/URI for resolving relative refs. Defaults to the entry's directory. */
  baseUri?: string;
  /**
   * Run spec-hygiene lint passes against the resolved document.
   * Findings land in {@link ResolvedSpec.specHygieneIssues}. Defaults
   * to `false`. See {@link lintResolvedSpec}.
   */
  lint?: boolean;
  /**
   * Record where each part of the resolved document came from. Regions
   * land in {@link ResolvedSpec.regions}. Defaults to `false`.
   *
   * Off by default because the callers that resolve a spec to build a
   * validator never look at the answer, and they are every server
   * process at startup. On, the walk carries a reused path stack and
   * records one region per external reference; off, it carries a null
   * check. See {@link sourceOf} for what the regions answer.
   */
  provenance?: boolean;
  /**
   * What to do with a reference the resolver cannot follow.
   *
   * `"throw"`, the default, is the historical behaviour: the first
   * reference that will not follow ends the resolution and no document
   * comes back.
   *
   * `"record"` carries on. The reference is left unfollowed, the
   * failure lands in {@link ResolvedSpec.unresolved}, and a document
   * comes back with a hole where the target would have been. That is
   * for a caller holding a buffer someone is still typing in, where a
   * reference that will not follow is a transient state rather than a
   * verdict.
   *
   * Both halves of a reference are covered: a document that will not
   * read, and a document that reads whose fragment names no node. The
   * second is the commoner one in an editor, since a fragment is
   * half-typed for as long as it takes to type the rest of it.
   * {@link UnresolvedRef.fragment} is what tells them apart.
   *
   * What a hole looks like depends on the position, because that is
   * what the walk does with a reference it can follow. A schema
   * position has already been rewritten to an internal `$ref` at the
   * component the target was going to be hoisted into, so the hole is
   * that component's absence, and the compiler reports the dangling
   * reference exactly as it reports one an author wrote. A non-schema
   * position would have been inlined, so the hole is the reference
   * itself, siblings kept.
   *
   * That surviving reference is written as the target the walk derived
   * rather than as the author spelled it. The two differ only for a
   * relative reference copied out of another source document: it is
   * relative to the file it was written in, and it is landing in a
   * document whose base is the entry, so keeping the spelling would
   * point it at a different file that may well exist. An entry-local
   * reference derives back to what the author wrote and is unchanged.
   * Writing the derived target is also what keeps the document and
   * {@link ResolvedSpec.unresolved} naming the same file.
   *
   * Nothing is ever substituted for the missing content: a permissive
   * placeholder would grade clean and say nothing was wrong. A
   * `components.schemas` slot the author wrote as nothing but an
   * external `$ref` is removed for the same reason, since the hoist
   * that was going to fill it did not happen and the slot would
   * otherwise point at itself.
   *
   * The entry document is not covered. A reference that will not
   * resolve leaves a hole in a document; an entry that will not read
   * leaves no document at all, so that still throws.
   */
  onUnresolved?: "throw" | "record";
}

/**
 * Output of {@link resolveSpec}: the resolved OpenAPI document plus a record
 * of every file that was read to build it, the entry included.
 *
 * @public
 */
export interface ResolvedSpec {
  document: OpenAPIDocument;
  /**
   * URIs of every file the resolution read, the entry included.
   *
   * Under `onUnresolved: "record"` it also holds the targets that were
   * reached for and would not read. That is deliberate rather than an
   * oversight: a caller watching these files wants to be told when the
   * missing one appears, which is the edit that fixes the document, and
   * a list that omits it cannot say so. {@link ResolvedSpec.unresolved}
   * is what separates the two.
   */
  sources: string[];
  /**
   * Spec-hygiene findings from {@link lintResolvedSpec}. Empty unless
   * {@link ResolveSpecOptions.lint} was set. Same name and shape as
   * `Validator.specHygieneIssues` on the validator side.
   */
  specHygieneIssues: readonly SpecHygieneIssue[];
  /**
   * Components of the entry document that a reference reached and the
   * resolver inlined at the use site, as pointers
   * (`/components/parameters/PageSize`).
   *
   * Non-schema positions inline, so the resolved document contains the
   * component's content without reaching the component, and a rule
   * grading that document alone would call it unused. Pass this to
   * {@link lintResolvedSpec} so it stays quiet about them instead.
   * Empty for a single-file spec, and for any spec whose cross-document
   * references are all in schema positions.
   *
   * Optional so a caller building a {@link ResolvedSpec} by hand does
   * not have to, and so that absence can carry meaning. Both resolvers
   * always set it, empty included: an empty array says the walk inlined
   * no component, and absence says nobody can answer for this document.
   * `loadSpec` is what produces the second, dropping the list when an
   * overlay ran, since an overlay can re-reference or remove any of the
   * components it names. Reporting `[]` there would read as "nothing
   * was inlined" and silently turn the finding back on for the wrong
   * reason.
   */
  inlinedComponents?: readonly string[];
  /**
   * Where each part of the resolved document came from. Present only
   * when {@link ResolveSpecOptions.provenance} was set, which is the
   * one way to tell "provenance was never tracked" apart from "tracked,
   * and this node has no source"; {@link sourceOf} answers the latter
   * with `undefined` and cannot answer the former.
   */
  regions?: readonly SpecRegion[];
  /**
   * References the resolver could not follow.
   *
   * Present only under {@link ResolveSpecOptions.onUnresolved}
   * `"record"`, and the one way to tell a document with holes in it
   * from a whole one. Three states, the same convention
   * {@link ResolvedSpec.inlinedComponents} uses: absent says nobody
   * asked, `[]` says the resolution was asked and every reference
   * resolved, and a non-empty array says this document is missing
   * pieces and names which.
   *
   * A non-empty array says this document is **partial**, and that is a
   * statement about every consumer downstream of it, not only about the
   * references named here. A caller reading findings computed from a
   * partial document needs a policy for which of them to trust: a rule
   * whose verdict rests on something being absent can be wrong about a
   * document that is missing pieces, while one whose verdict rests on
   * what is present cannot. Reporting all of them and leaving the
   * reader to sort it out moves that problem rather than answering it.
   *
   * A field on the ordinary result rather than a type of its own, so a
   * consumer that never asks for holes keeps the signature it has. The
   * cost is that a function taking a `ResolvedSpec` cannot make a
   * caller think about this; the three states are the whole of the
   * contract, so a consumer that means to handle partial input checks
   * the field.
   */
  unresolved?: readonly UnresolvedRef[];
}

/**
 * Load an OpenAPI document and resolve all external `$ref`s, producing a
 * single self-contained document.
 *
 * External refs in **schema** positions are hoisted: the target lands in
 * `components.schemas` under a derived name and each use site keeps an
 * internal `$ref` to it, so a schema keeps an address rather than being
 * copied per reference. A ref that names a file but resolves to the
 * entry document is not external: its target already has an address, so
 * the use site keeps a plain internal `$ref` to it (see
 * {@link entryIdentity} for exactly which spellings that recognises).
 * External refs in non-schema positions (Response, Parameter, Path Item
 * Objects) are inlined, and a cycle among those is materialized under
 * `x-oaverify-externals/<encoded-uri>` so the compiler can resolve it via
 * the identity-keyed schema cache.
 *
 * The synchronous mirror is `resolveSpecSync` (reachable via
 * `@oaverify/core/spec/internals`); both share the pure URI / ref-rewriting helpers
 * in `./resolver-shared.ts` and are pinned to identical behavior by the
 * parity suite. Keep any change to the walk here mirrored there.
 *
 * @param options - Reader + entry URI.
 * @returns Resolved document + the list of files loaded.
 *
 * @example
 * ```ts
 * const reader = composeReaders([createFileReader()]);
 * const { document } = await resolveSpec({ reader, entry: "openapi.json" });
 * ```
 *
 * @public
 */
export async function resolveSpec(options: ResolveSpecOptions): Promise<ResolvedSpec> {
  const { reader } = options;
  const baseDir = options.baseUri ?? baseDirOf(options.entry);
  const entryUri = entryIdentity(options.entry);
  const sources = new Set<string>([options.entry]);
  const inlinedComponents = new Set<string>();
  const docs = new Map<string, unknown>();

  // Null unless asked for. Every call site below reaches it through
  // `?.`, so the untracked walk pays a null check and nothing else.
  const trail = options.provenance === true ? new ProvenanceTrail(options.entry) : null;
  // The chain that first reached each deferred mount, recorded where
  // the reference was found and read back when the target is finally
  // walked. First writer wins, matching `noteReferrer` and `claim`:
  // a target reached by several references is mounted once.
  const hoistVia = new Map<string, readonly SourceHop[]>();
  const stitchVia = new Map<string, readonly SourceHop[]>();
  const noteVia = (map: Map<string, readonly SourceHop[]>, key: string): void => {
    if (trail !== null && !map.has(key)) map.set(key, trail.chain());
  };

  // Populated as the walk derives each target URI; read back only on
  // failure, to name the reference that pulled the bad document in.
  const referrers: ReferrerTrail = new Map();
  // Null unless the caller asked to record; every read below then
  // throws exactly as it always did.
  const holes = options.onUnresolved === "record" ? new HoleLog() : null;
  const readDoc = async (uri: string, via: readonly SourceHop[]): Promise<unknown> => {
    // A target already known to be missing is not read again. One
    // missing file costs one failed read however many references name
    // it, which is what keeps a document mid-rename cheap to re-check.
    if (holes !== null && holes.has(uri)) return UNREADABLE;
    const referrer = referrers.get(uri) ?? null;
    try {
      return await reader.read(uri);
    } catch (err) {
      const wrapped = wrapReadError(err, uri, referrer);
      if (holes === null) throw wrapped;
      holes.record(uri, referrer ?? uri, via, wrapped, err);
      return UNREADABLE;
    }
  };

  // The other half of a reference: the document was found, the node
  // inside it may not be. Under `record` a fragment that does not
  // resolve is a hole of its own, keyed by document and fragment, since
  // one document can hold the node one reference names and not another.
  const readFragment = (
    doc: unknown,
    uri: string,
    fragment: string,
    via: readonly SourceHop[],
  ): unknown => {
    if (fragment === "") return doc;
    try {
      return resolveJsonPointer(doc, pointerFromFragment(fragment));
    } catch (err) {
      if (holes === null) throw err;
      const referrer = referrers.get(uri) ?? null;
      holes.recordFragment(
        uri,
        fragment,
        referrer ?? uri,
        via,
        wrapFragmentError(err, uri, fragment, referrer),
        err,
      );
      return UNREADABLE;
    }
  };

  // Read directly rather than through `readDoc`, because `record` mode
  // does not cover the entry. See `ResolveSpecOptions.onUnresolved`.
  let entryDoc: unknown;
  try {
    entryDoc = await reader.read(options.entry);
  } catch (err) {
    throw wrapReadError(err, options.entry, null);
  }
  assertEntryDocument(entryDoc, options.entry);
  docs.set(options.entry, entryDoc);

  // Which positions may hold a `$ref` is version-dependent, so the
  // entry document's own version decides. An undetectable version is
  // treated as 3.1: the walk still refuses author-data positions, and
  // the two positions 3.1 lacks (3.2's ref-able Media Type) fall back
  // to being inlined, which is what they were before.
  const version = detectOpenAPIVersion(entryDoc) ?? "3.1";

  const visiting = new Set<string>();
  // Keyed by URI, valued by the kind of node the reference sat at, so a
  // stitched document is walked as the object it actually is.
  const stitchQueue = new Map<string, RefNodeKind>();

  // Schema targets get a `components.schemas` name and a single hoisted
  // copy; every `$ref` to them becomes an internal ref to that name.
  // Seeded with the entry document's own component names so hoisting can
  // never shadow a schema the author wrote.
  const names = new HoistNames(existingSchemaNames(entryDoc));
  // Component names the author bound to an external target by writing a
  // slot that is nothing but a `$ref`. Read back only when such a target
  // fails to read; see `removeComponentSchema`.
  const boundSlots = new Set<string>();
  const hoistQueue = new Set<string>();
  const targets = new Map<string, { uri: string; fragment: string }>();

  // A `components.schemas` entry that is nothing but an external `$ref`
  // names its target already, so hoist into that slot rather than
  // inventing a second component and pointing the author's name at it.
  for (const [name, slot] of Object.entries(componentSchemaSlots(entryDoc))) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) continue;
    const keys = Object.keys(slot as Mutable);
    const slotRef = (slot as Mutable)["$ref"];
    if (keys.length !== 1 || typeof slotRef !== "string" || slotRef.startsWith("#")) continue;
    const [refPath, fragment = ""] = slotRef.split("#") as [string, string | undefined];
    names.bind(resolveRelative(baseDir, refPath), fragment, name);
    boundSlots.add(name);
  }

  /**
   * Claim a name for an external schema target and queue it for hoisting.
   * Keyed canonically, so refs spelled differently but denoting the same
   * schema collapse onto one component, and a self-reference resolves to
   * a name that already exists rather than recursing.
   */
  const claim = (uri: string, fragment: string): string => {
    const key = targetKey(uri, fragment);
    if (!targets.has(key)) {
      targets.set(key, { uri, fragment });
      hoistQueue.add(key);
    }
    sources.add(uri);
    return names.nameFor(uri, fragment);
  };

  // `discriminator.mapping` values are `$ref`-shaped strings that the
  // compiler matches against branch `$ref`s, so hoisting the branches
  // means moving the mapping with them or the discriminator matches
  // nothing (#553).
  //
  // Recorded during the walk and rewritten afterwards, never resolved
  // eagerly. A mapping value is not required to name a loadable file:
  // the flattened DigitalOcean spec in `conformance/real-world` maps to
  // `models/*.yml` paths that do not exist beside it, and reading them
  // turned a spec oddity that had always been inert into a fatal load
  // error. After the walk the claimed targets are known, so a value can
  // be matched against them without touching the reader, and anything
  // that matches nothing is left exactly as written.
  const mappingSites: Array<{ node: Mutable; base: string; source: string | null }> = [];

  const fixUpDiscriminatorMappings = (): void => {
    for (const { node, base, source } of mappingSites) {
      const mapping = node["mapping"];
      if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) continue;
      const out: Mutable = {};
      let changed = false;
      for (const [key, target] of Object.entries(mapping as Mutable)) {
        setSpecKey(out, key, target);
        if (typeof target !== "string") continue;

        let candidate: string;
        if (target.startsWith("#")) {
          // A `#...` mapping is local to whichever document the
          // discriminator was written in. In the entry document that is
          // already the resolved document, so it needs no rewrite. In an
          // external document it names a sibling of that file, exactly
          // like the branch `$ref`s beside it, and must follow them to
          // their hoisted names. Leaving it alone pointed the mapping at
          // a same-named component in the *entry* document, which either
          // fails to match or routes through the wrong schema.
          if (source === null) continue;
          candidate = targetKey(source, target.slice(1));
        } else {
          // Treat it as a relative reference and see whether a branch
          // already claimed that exact target. Membership decides, rather
          // than guessing from the string's shape: `$ref: "Cat"` is a
          // legal same-directory file with no extension, so a
          // "contains a slash or a dot" test read it as a bare component
          // name and left it pointing at nothing. Nothing is read here,
          // so a mapping naming a file that does not exist (pre-bundled
          // specs keep those) stays inert, and a genuine bare component
          // name claims no target and is left alone.
          const [refPath, fragment = ""] = target.split("#") as [string, string | undefined];
          candidate = targetKey(resolveRelative(base, refPath), fragment);
        }

        const named = targets.get(candidate);
        if (named === undefined) continue;
        setSpecKey(out, key, hoistedRef(names.nameFor(named.uri, named.fragment)));
        changed = true;
      }
      if (changed) node["mapping"] = out;
    }
  };

  /**
   * Where the walk is standing: which OpenAPI object, whether that
   * position admits a Reference Object, and whether it is inside a
   * Schema Object (where JSON Schema's own `$ref` rules apply and the
   * position table does not).
   */
  interface Pos {
    readonly kind: RefNodeKind;
    readonly refable: boolean;
    readonly inSchema: boolean;
  }
  const DOCUMENT_POS: Pos = { kind: "document", refable: false, inSchema: false };
  const SCHEMA_POS: Pos = { kind: "schema", refable: false, inSchema: true };
  const UNKNOWN_POS: Pos = { kind: "unknown", refable: false, inSchema: false };
  const posOf = (kind: RefNodeKind, refable: boolean): Pos => ({
    kind,
    refable,
    inSchema: kind === "schema",
  });

  const walk = async (
    value: unknown,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    pos: Pos,
  ): Promise<unknown> => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        trail?.push(String(out.length));
        out.push(await walk(item, currentBase, stitchingUri, externalSourceUri, pos));
        trail?.pop();
      }
      return out;
    }
    const obj = value as Mutable;
    const inSchema = pos.inSchema;
    // Outside a schema, a `$ref` is a reference only where the
    // specification types the position as `X | Reference`. Anywhere else
    // it is author data that happens to be shaped like one, and reading
    // it hands a non-spec file to the reader chain.
    const ref = inSchema || followsRef(pos.kind, pos.refable) ? obj["$ref"] : undefined;

    // --- schema positions: hoist rather than inline ------------------
    // The reference keeps a name, which is what the discriminator needs
    // (#553), what lets a recursive schema have a legal internal address
    // (#556), and what stops a schema used by N operations being copied
    // N times.
    if (inSchema && typeof ref === "string") {
      const isExternal = !ref.startsWith("#");
      if (isExternal || externalSourceUri !== null) {
        const [refPath, fragment = ""] = isExternal
          ? (ref.split("#") as [string, string | undefined])
          : ["", ref.slice(1)];
        const uri = isExternal
          ? resolveRelative(currentBase, refPath)
          : (externalSourceUri as string);
        // Whether the target is the entry document decides, not whether
        // the reference is spelled as a path. A node of the entry
        // already has an address in the resolved document, so hoisting
        // one copies a schema that was reachable all along and leaves
        // the author's own component unreferenced (#612).
        //
        // The fragment has to be a JSON pointer for that address to
        // exist. An empty one names the whole OpenAPI document rather
        // than an addressable Schema Object, and `#anchor` is a claim
        // about `$anchor` resolution this makes no attempt at; both
        // keep hoisting, deliberately, and both have a test.
        const intoEntry = uri === entryUri && fragment.startsWith("/");
        if (!intoEntry) {
          noteReferrer(referrers, uri, externalSourceUri ?? options.entry);
          // The target is walked later, from the hoist queue, so the
          // chain that reached it is recorded here where it is known.
          noteVia(hoistVia, targetKey(uri, fragment));
        }
        const out: Mutable = {
          $ref: intoEntry ? `#${fragment}` : hoistedRef(claim(uri, fragment)),
        };
        // OpenAPI 3.1 allows siblings alongside `$ref`; they survive.
        for (const key of Object.keys(obj)) {
          if (key === "$ref") continue;
          setSpecKey(
            out,
            key,
            await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, SCHEMA_POS),
          );
        }
        return out;
      }
      // A plain internal ref in the entry document already addresses the
      // resolved document; leave it exactly as written.
    }

    // --- non-schema positions: inline, as before ---------------------
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const [refPath, fragment = ""] = ref.split("#") as [string, string | undefined];
      const targetUri = resolveRelative(currentBase, refPath);
      noteReferrer(referrers, targetUri, externalSourceUri ?? options.entry);
      // The content lands at the use site, so the component it came
      // from is about to look unreachable to anything reading the
      // resolved document alone.
      if (targetUri === entryUri) noteInlinedComponent(inlinedComponents, fragment);
      const stitchRef = makeStitchRef(targetUri, fragment);
      if (stitchingUri !== null && stitchingUri === targetUri) {
        noteVia(stitchVia, targetUri);
        return stitchRef;
      }
      if (visiting.has(cycleKey(targetUri, fragment))) {
        noteVia(stitchVia, targetUri);
        stitchQueue.set(targetUri, pos.kind);
        return stitchRef;
      }
      visiting.add(cycleKey(targetUri, fragment));
      sources.add(targetUri);
      let targetDoc = docs.get(targetUri);
      if (targetDoc === undefined) {
        targetDoc = await readDoc(targetUri, trail?.chain() ?? []);
        if (targetDoc === UNREADABLE) {
          // Nothing to inline, so the reference survives into the
          // resolved document and the walk carries on past it. Siblings
          // are still walked, because they are this document's content
          // and have nothing to do with the target.
          //
          // Written as the target the walk derived rather than as the
          // author spelled it. A relative reference is relative to the
          // document it was written in, and this one is landing in the
          // resolved document, whose base is the entry; keeping the
          // spelling would silently re-point `gone.json` written in
          // `sub/a.json` at a different `gone.json` beside the entry.
          // The URI here is the same one `unresolved` names, so the
          // document and the record agree on which file is missing.
          visiting.delete(cycleKey(targetUri, fragment));
          const unfollowed: Mutable = {
            $ref: fragment === "" ? targetUri : `${targetUri}#${fragment}`,
          };
          for (const key of Object.keys(obj)) {
            if (key === "$ref") continue;
            setSpecKey(
              unfollowed,
              key,
              await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
            );
          }
          return unfollowed;
        }
        docs.set(targetUri, targetDoc);
      }
      const resolved = readFragment(targetDoc, targetUri, fragment, trail?.chain() ?? []);
      if (resolved === UNREADABLE) {
        visiting.delete(cycleKey(targetUri, fragment));
        const unfollowed: Mutable = {
          $ref: fragment === "" ? targetUri : `${targetUri}#${fragment}`,
        };
        for (const key of Object.keys(obj)) {
          if (key === "$ref") continue;
          setSpecKey(
            unfollowed,
            key,
            await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
          );
        }
        return unfollowed;
      }
      // The target's content replaces the reference in place, so it is
      // mounted at the position the walk is standing on.
      let mounted: MountState | undefined;
      if (trail !== null) {
        mounted = trail.enter(targetUri, pointerFromFragment(fragment), trail.chain());
      }
      const inlined = await walk(resolved, baseDirOf(targetUri), stitchingUri, targetUri, pos);
      if (trail !== null && mounted !== undefined) trail.leave(mounted);
      visiting.delete(cycleKey(targetUri, fragment));
      const siblings: Mutable = {};
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        setSpecKey(
          siblings,
          key,
          await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
        );
      }
      if (Object.keys(siblings).length === 0) return inlined;
      if (inlined === null || typeof inlined !== "object" || Array.isArray(inlined)) return inlined;
      // Key-wise merge, so key-wise provenance: the node keeps the
      // target's address and each sibling shadows it with this one's.
      for (const key of Object.keys(siblings)) trail?.shadow(key);
      return { ...(inlined as Mutable), ...siblings };
    }
    // An internal ref inside content inlined from another document
    // names a node of *that* document, so it is stitched and re-pointed.
    // Inside content inlined from the entry it names a node of the
    // resolved document already, and stitching mounted a second copy of
    // the whole entry under the root extension to point at (#612).
    // Leaving it as written falls through to the generic walk below.
    if (
      typeof ref === "string" &&
      ref.startsWith("#") &&
      externalSourceUri !== null &&
      externalSourceUri !== entryUri
    ) {
      const rewritten = rewriteInternalRefTarget(externalSourceUri, ref.slice(1));
      noteVia(stitchVia, externalSourceUri);
      stitchQueue.set(externalSourceUri, pos.kind);
      const siblings: Mutable = { $ref: rewritten };
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        setSpecKey(
          siblings,
          key,
          await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
        );
      }
      return siblings;
    }

    const out: Mutable = {};
    for (const key of Object.keys(obj)) {
      setSpecKey(
        out,
        key,
        await walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
      );
    }
    return out;
  };

  /**
   * Walk one child, deciding what kind of position it is.
   *
   * Inside a Schema Object, JSON Schema's own rules apply: only the keys
   * that hold subschemas stay in one. `example`, `default` and `enum`
   * hold arbitrary author data, so they drop back out to `unknown`; a
   * `$ref`-shaped object inside an example is data, not a reference.
   *
   * Outside one, {@link refPositionFor} decides, and a key the
   * specification does not define drops to `unknown` for the same
   * reason. That is what keeps a `$ref` in a tag description, or under a
   * vendor extension, from reaching the reader.
   */
  const walkChild = async (
    parent: Mutable,
    key: string,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    parentPos: Pos,
  ): Promise<unknown> => {
    const value = parent[key];
    // Pushed here and popped before every return below, so the trail's
    // path always names the node being walked. An imbalance would
    // produce addresses that resolve to the wrong node.
    trail?.push(key);
    if (parentPos.inSchema && key === "discriminator") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        trail?.pop();
        return value;
      }
      const node: Mutable = { ...(value as Mutable) };
      mappingSites.push({ node, base: currentBase, source: externalSourceUri });
      // Copied whole and never walked into. `fixUpDiscriminatorMappings`
      // rewrites mapping values afterwards, which changes what is at
      // these addresses and not where they came from, so the enclosing
      // region keeps answering for them.
      trail?.pop();
      return node;
    }

    let childPos: Pos;
    let mapOfChildren: boolean;
    // Only a mixed map has entries that are not subschemas at all.
    let mixedMap = false;
    if (parentPos.inSchema) {
      // One classification for every subschema position, mixed included.
      // This asked `isSubschemaKey`, which answers `false` for a mixed
      // position by design: it promises every value at the key is a
      // schema, and under `dependencies` that is untrue of half of them.
      // A `false` there is "cannot say", and reading it as "not a schema
      // position" left an external `$ref` written inside one unhoisted
      // and its document never loaded (#859).
      const family = subschemaFamilyOf(key);
      childPos = family === undefined ? UNKNOWN_POS : SCHEMA_POS;
      // The subschema *map* positions hold `name -> schema`, so the
      // schemas are one level below the key.
      mapOfChildren = family === "map" || family === "mixed-map";
      mixedMap = family === "mixed-map";
    } else {
      const at = refPositionFor(version, parentPos.kind, key);
      childPos = at === undefined ? UNKNOWN_POS : posOf(at.kind, at.refable);
      mapOfChildren = at?.arity === "map";
    }

    if (mapOfChildren && typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Under a mixed map an array entry names required properties, so
      // it must not inherit the schema position: an *object* written
      // inside that array would otherwise be hoisted as a schema. A
      // string there is already safe, since a scalar is returned
      // untouched whatever position it carries.
      const entryPos = (sub: unknown): Pos =>
        mixedMap && Array.isArray(sub) ? UNKNOWN_POS : childPos;
      const out: Mutable = {};
      for (const [name, sub] of Object.entries(value as Mutable)) {
        trail?.push(name);
        setSpecKey(
          out,
          name,
          await walk(sub, currentBase, stitchingUri, externalSourceUri, entryPos(sub)),
        );
        trail?.pop();
      }
      trail?.pop();
      return out;
    }
    const walked = await walk(value, currentBase, stitchingUri, externalSourceUri, childPos);
    trail?.pop();
    return walked;
  };

  const resolved = (await walk(entryDoc, baseDir, null, null, DOCUMENT_POS)) as OpenAPIDocument;

  // Hoist every claimed schema target. Nested targets discovered while
  // walking one are appended to the queue, so this drains transitively;
  // a self-reference resolves to an already-claimed name rather than
  // recursing.
  const hoisted: Mutable = {};
  // Names whose target could not be read. Collected rather than deleted
  // in the loop, so the `hasOwn` guard above still collapses a repeat
  // instead of walking it a second time.
  const missingHoists = new Set<string>();
  while (hoistQueue.size > 0) {
    const key = hoistQueue.values().next().value as string;
    hoistQueue.delete(key);
    const target = targets.get(key);
    if (target === undefined) continue;
    const name = names.nameFor(target.uri, target.fragment);
    if (Object.hasOwn(hoisted, name)) continue;
    // placeholder: claims the slot before walking
    setSpecKey(hoisted, name, true);
    let targetDoc = docs.get(target.uri);
    if (targetDoc === undefined) {
      targetDoc = await readDoc(target.uri, hoistVia.get(key) ?? []);
      if (targetDoc === UNREADABLE) {
        // The use site was rewritten to `#/components/schemas/<name>`
        // before the target was read, so leaving the slot empty leaves
        // an internal reference to a component that is not there, which
        // is the dangling reference the compiler already reports with a
        // pointer at the use site.
        missingHoists.add(name);
        continue;
      }
      docs.set(target.uri, targetDoc);
    }
    const content = readFragment(targetDoc, target.uri, target.fragment, hoistVia.get(key) ?? []);
    if (content === UNREADABLE) {
      missingHoists.add(name);
      continue;
    }
    // Hoisting relocates: the target lands under a derived component
    // name rather than where it was referenced, so the mount names
    // where it ends up and the chain that found it is read back from
    // where the reference was.
    let mounted: MountState | undefined;
    if (trail !== null) {
      mounted = trail.enterAt(
        ["components", "schemas", name],
        target.uri,
        pointerFromFragment(target.fragment),
        hoistVia.get(key) ?? [],
      );
    }
    setSpecKey(
      hoisted,
      name,
      await walk(content, baseDirOf(target.uri), null, target.uri, SCHEMA_POS),
    );
    if (trail !== null && mounted !== undefined) trail.leave(mounted, true);
  }
  for (const name of missingHoists) {
    delete hoisted[name];
    if (boundSlots.has(name)) removeComponentSchema(resolved, name);
  }
  // `components` / `components.schemas` may be containers the resolver
  // invented to hold the hoisted schemas. The document is not merged
  // yet, so what the entry document declared is still visible here.
  if (trail !== null && Object.keys(hoisted).length > 0) {
    const components = (resolved as unknown as Mutable).components;
    if (!isPlainObject(components)) trail.synthetic("/components");
    else if (!isPlainObject(components.schemas)) trail.synthetic("/components/schemas");
  }
  fixUpDiscriminatorMappings();
  mergeHoistedSchemas(resolved, hoisted);

  if (stitchQueue.size > 0) {
    // The root extension itself is the resolver's own invention; the
    // documents mounted underneath it are not.
    trail?.synthetic(`/${escapePointerSegment(EXTERNALS_FIELD)}`);
    const stitched: Mutable = {};
    while (stitchQueue.size > 0) {
      const [uri, kind] = stitchQueue.entries().next().value as [string, RefNodeKind];
      stitchQueue.delete(uri);
      if (Object.hasOwn(stitched, uri)) continue;
      sources.add(uri);
      let targetDoc = docs.get(uri);
      if (targetDoc === undefined) {
        targetDoc = await readDoc(uri, stitchVia.get(uri) ?? []);
        // Same shape as an unread hoist: the references into this
        // document were rewritten before it was read, so leaving it out
        // leaves them dangling where they were written.
        if (targetDoc === UNREADABLE) continue;
        docs.set(uri, targetDoc);
      }
      const savedVisiting = new Set(visiting);
      visiting.clear();
      // The stitched document is whatever object the reference that
      // reached it expected, so it is walked as that kind rather than
      // as a fresh document root.
      let mounted: MountState | undefined;
      if (trail !== null) {
        mounted = trail.enterAt([EXTERNALS_FIELD, uri], uri, "", stitchVia.get(uri) ?? []);
      }
      const inlined = await walk(targetDoc, baseDirOf(uri), uri, uri, posOf(kind, true));
      if (trail !== null && mounted !== undefined) trail.leave(mounted, true);
      visiting.clear();
      for (const v of savedVisiting) visiting.add(v);
      setSpecKey(stitched, uri, inlined);
    }
    mergeStitchedExternals(resolved, stitched);
  }

  const inlined = [...inlinedComponents];
  const specHygieneIssues = options.lint
    ? lintResolvedSpec(resolved, { inlinedComponents: inlined })
    : [];
  return {
    document: resolved,
    sources: [...sources],
    specHygieneIssues,
    inlinedComponents: inlined,
    ...(trail !== null && { regions: trail.regions }),
    ...(holes !== null && { unresolved: holes.entries() }),
  };
}

/** A JSON object, as opposed to an array, a null, or a scalar. */
function isPlainObject(value: unknown): value is Mutable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
