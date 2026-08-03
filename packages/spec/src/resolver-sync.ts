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
import type { SyncDocumentReader } from "./reader.js";
import { lintResolvedSpec } from "./lint.js";
import type { ResolvedSpec } from "./resolver.js";
import {
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
} from "./resolver-shared.js";
import type { SourceHop } from "./provenance.js";
import { isSubschemaKey } from "@oaverify/internal-core";

/**
 * Options accepted by {@link resolveSpecSync}. Mirror of
 * {@link ResolveSpecOptions} with a {@link SyncDocumentReader}.
 */
export interface ResolveSpecSyncOptions {
  /** Synchronous reader used to fetch documents by URI. */
  reader: SyncDocumentReader;
  /** Entry URI. */
  entry: string;
  /** Base directory/URI for resolving relative refs. Defaults to the entry's directory. */
  baseUri?: string;
  /** Run spec-hygiene lint passes against the resolved document. Defaults to `false`. */
  lint?: boolean;
  /**
   * Record where each part of the resolved document came from. Regions
   * land in {@link ResolvedSpec.regions}. Defaults to `false`. See
   * {@link ResolveSpecOptions.provenance}.
   */
  provenance?: boolean;
}

/**
 * Synchronous mirror of {@link resolveSpec}. Identical resolution
 * semantics (schema-position hoisting into `components.schemas`,
 * non-schema inlining, circular non-schema stitching under
 * `$defs.__ext__`, discriminator-mapping rewriting, internal-ref
 * rewriting, sibling preservation, the source list, and lint), driven by
 * a {@link SyncDocumentReader} so it returns a {@link ResolvedSpec}
 * directly instead of a `Promise`.
 *
 * The walk skeleton below is a deliberate structural copy of
 * `resolveSpec`'s: JS function coloring means one body can't be both
 * `async` and sync, and the async resolver is the package's primary,
 * production surface that must not be rewritten to serve the
 * synchronous path. The duplication is confined to the
 * read-interleaving skeleton; every pure sub-step lives in
 * `./resolver-shared.ts`, shared with the async path. The sync/async
 * parity suite asserts the two produce identical output, throw
 * equivalently, and read documents in the identical order, so any
 * change to one walk that isn't mirrored in the other breaks the build.
 *
 * Blocking by construction (the reader reads files synchronously); for
 * boot-time / CLI use, not per-request. Use the async
 * {@link resolveSpec} for non-blocking contexts.
 *
 * @public
 */
export function resolveSpecSync(options: ResolveSpecSyncOptions): ResolvedSpec {
  const { reader } = options;
  const baseDir = options.baseUri ?? baseDirOf(options.entry);
  const entryUri = entryIdentity(options.entry);
  const sources = new Set<string>([options.entry]);
  const docs = new Map<string, unknown>();

  // Mirrors resolveSpec; the commentary lives there.
  const trail = options.provenance === true ? new ProvenanceTrail(options.entry) : null;
  const hoistVia = new Map<string, readonly SourceHop[]>();
  const stitchVia = new Map<string, readonly SourceHop[]>();
  const noteVia = (map: Map<string, readonly SourceHop[]>, key: string): void => {
    if (trail !== null && !map.has(key)) map.set(key, trail.chain());
  };

  // Populated as the walk derives each target URI; read back only on
  // failure, to name the reference that pulled the bad document in.
  const referrers: ReferrerTrail = new Map();
  const readDoc = (uri: string): unknown => {
    try {
      return reader.read(uri);
    } catch (err) {
      throw wrapReadError(err, uri, referrers.get(uri) ?? null);
    }
  };

  const entryDoc = readDoc(options.entry);
  docs.set(options.entry, entryDoc);

  const visiting = new Set<string>();
  // Which positions may hold a `$ref` is version-dependent, so the
  // entry document's own version decides. Mirrors resolveSpec.
  const version = detectOpenAPIVersion(entryDoc) ?? "3.1";

  // Keyed by URI, valued by the kind of node the reference sat at, so a
  // stitched document is walked as the object it actually is.
  const stitchQueue = new Map<string, RefNodeKind>();

  // Schema targets get a `components.schemas` name and a single hoisted
  // copy; every `$ref` to them becomes an internal ref to that name.
  // Seeded with the entry document's own component names so hoisting can
  // never shadow a schema the author wrote.
  const names = new HoistNames(existingSchemaNames(entryDoc));
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

  /** See the async resolver for what these carry. */
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

  const walk = (
    value: unknown,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    pos: Pos,
  ): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        trail?.push(String(out.length));
        out.push(walk(item, currentBase, stitchingUri, externalSourceUri, pos));
        trail?.pop();
      }
      return out;
    }
    const obj = value as Mutable;
    const inSchema = pos.inSchema;
    // Outside a schema, a `$ref` is a reference only where the
    // specification types the position as `X | Reference`.
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
        // A target in the entry document already has an address in the
        // resolved document; the commentary lives in resolveSpec.
        const intoEntry = uri === entryUri && fragment.startsWith("/");
        if (!intoEntry) {
          noteReferrer(referrers, uri, externalSourceUri ?? options.entry);
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
            walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, SCHEMA_POS),
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
        targetDoc = readDoc(targetUri);
        docs.set(targetUri, targetDoc);
      }
      const resolved =
        fragment === "" ? targetDoc : resolveJsonPointer(targetDoc, pointerFromFragment(fragment));
      let mounted: MountState | undefined;
      if (trail !== null) {
        mounted = trail.enter(targetUri, pointerFromFragment(fragment), trail.chain());
      }
      const inlined = walk(resolved, baseDirOf(targetUri), stitchingUri, targetUri, pos);
      if (trail !== null && mounted !== undefined) trail.leave(mounted);
      visiting.delete(cycleKey(targetUri, fragment));
      const siblings: Mutable = {};
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        setSpecKey(
          siblings,
          key,
          walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
        );
      }
      if (Object.keys(siblings).length === 0) return inlined;
      if (inlined === null || typeof inlined !== "object" || Array.isArray(inlined)) return inlined;
      for (const key of Object.keys(siblings)) trail?.shadow(key);
      return { ...(inlined as Mutable), ...siblings };
    }
    // Inside content inlined from the entry, an internal ref already
    // addresses the resolved document; the commentary lives in
    // resolveSpec.
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
          walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos),
        );
      }
      return siblings;
    }

    const out: Mutable = {};
    for (const key of Object.keys(obj)) {
      setSpecKey(out, key, walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, pos));
    }
    return out;
  };

  /**
   * Walk one child, deciding what kind of position it is. Mirrors the
   * async resolver; the commentary lives there.
   */
  const walkChild = (
    parent: Mutable,
    key: string,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    parentPos: Pos,
  ): unknown => {
    const value = parent[key];
    trail?.push(key);
    if (parentPos.inSchema && key === "discriminator") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        trail?.pop();
        return value;
      }
      const node: Mutable = { ...(value as Mutable) };
      mappingSites.push({ node, base: currentBase, source: externalSourceUri });
      trail?.pop();
      return node;
    }

    let childPos: Pos;
    let mapOfChildren: boolean;
    if (parentPos.inSchema) {
      childPos = isSubschemaKey(key) ? SCHEMA_POS : UNKNOWN_POS;
      mapOfChildren = isSchemaMapKey(key);
    } else {
      const at = refPositionFor(version, parentPos.kind, key);
      childPos = at === undefined ? UNKNOWN_POS : posOf(at.kind, at.refable);
      mapOfChildren = at?.arity === "map";
    }

    if (mapOfChildren && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const out: Mutable = {};
      for (const [name, sub] of Object.entries(value as Mutable)) {
        trail?.push(name);
        setSpecKey(out, name, walk(sub, currentBase, stitchingUri, externalSourceUri, childPos));
        trail?.pop();
      }
      trail?.pop();
      return out;
    }
    const walked = walk(value, currentBase, stitchingUri, externalSourceUri, childPos);
    trail?.pop();
    return walked;
  };

  const resolved = walk(entryDoc, baseDir, null, null, DOCUMENT_POS) as OpenAPIDocument;

  // Hoist every claimed schema target. Nested targets discovered while
  // walking one are appended to the queue, so this drains transitively;
  // a self-reference resolves to an already-claimed name rather than
  // recursing.
  const hoisted: Mutable = {};
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
      targetDoc = readDoc(target.uri);
      docs.set(target.uri, targetDoc);
    }
    const content =
      target.fragment === ""
        ? targetDoc
        : resolveJsonPointer(targetDoc, pointerFromFragment(target.fragment));
    let mounted: MountState | undefined;
    if (trail !== null) {
      mounted = trail.enterAt(
        ["components", "schemas", name],
        target.uri,
        pointerFromFragment(target.fragment),
        hoistVia.get(key) ?? [],
      );
    }
    setSpecKey(hoisted, name, walk(content, baseDirOf(target.uri), null, target.uri, SCHEMA_POS));
    if (trail !== null && mounted !== undefined) trail.leave(mounted, true);
  }
  if (trail !== null && Object.keys(hoisted).length > 0) {
    const components = (resolved as unknown as Mutable).components;
    if (!isPlainObject(components)) trail.synthetic("/components");
    else if (!isPlainObject(components.schemas)) trail.synthetic("/components/schemas");
  }
  fixUpDiscriminatorMappings();
  mergeHoistedSchemas(resolved, hoisted);

  if (stitchQueue.size > 0) {
    trail?.synthetic(`/${escapePointerSegment(EXTERNALS_FIELD)}`);
    const stitched: Mutable = {};
    while (stitchQueue.size > 0) {
      const [uri, kind] = stitchQueue.entries().next().value as [string, RefNodeKind];
      stitchQueue.delete(uri);
      if (Object.hasOwn(stitched, uri)) continue;
      sources.add(uri);
      let targetDoc = docs.get(uri);
      if (targetDoc === undefined) {
        targetDoc = readDoc(uri);
        docs.set(uri, targetDoc);
      }
      const savedVisiting = new Set(visiting);
      visiting.clear();
      let mounted: MountState | undefined;
      if (trail !== null) {
        mounted = trail.enterAt([EXTERNALS_FIELD, uri], uri, "", stitchVia.get(uri) ?? []);
      }
      const inlined = walk(targetDoc, baseDirOf(uri), uri, uri, posOf(kind, true));
      if (trail !== null && mounted !== undefined) trail.leave(mounted, true);
      visiting.clear();
      for (const v of savedVisiting) visiting.add(v);
      setSpecKey(stitched, uri, inlined);
    }
    mergeStitchedExternals(resolved, stitched);
  }

  /** Subschema positions whose value is a `name -> schema` map. */
  function isSchemaMapKey(key: string): boolean {
    return (
      key === "properties" ||
      key === "patternProperties" ||
      key === "dependentSchemas" ||
      key === "$defs" ||
      key === "definitions"
    );
  }

  const specHygieneIssues = options.lint ? lintResolvedSpec(resolved) : [];
  return {
    document: resolved,
    sources: [...sources],
    specHygieneIssues,
    ...(trail !== null && { regions: trail.regions }),
  };
}

/** A JSON object, as opposed to an array, a null, or a scalar. */
function isPlainObject(value: unknown): value is Mutable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
