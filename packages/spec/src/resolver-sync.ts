import { resolveJsonPointer, type OpenAPIDocument } from "@oaverify/internal-core";
import type { SyncDocumentReader } from "./reader.js";
import { lintResolvedSpec } from "./lint.js";
import type { ResolvedSpec } from "./resolver.js";
import {
  baseDirOf,
  cycleKey,
  componentSchemaSlots,
  existingSchemaNames,
  hoistedRef,
  HoistNames,
  makeStitchRef,
  mergeHoistedSchemas,
  mergeStitchedExternals,
  type Mutable,
  resolveRelative,
  rewriteInternalRefTarget,
  targetKey,
} from "./resolver-shared.js";
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
  const sources = new Set<string>([options.entry]);
  const docs = new Map<string, unknown>();

  const entryDoc = reader.read(options.entry);
  docs.set(options.entry, entryDoc);

  const visiting = new Set<string>();
  const stitchQueue = new Set<string>();

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
        out[key] = target;
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
        out[key] = hoistedRef(names.nameFor(named.uri, named.fragment));
        changed = true;
      }
      if (changed) node["mapping"] = out;
    }
  };

  const walk = (
    value: unknown,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    inSchema: boolean,
  ): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(walk(item, currentBase, stitchingUri, externalSourceUri, inSchema));
      }
      return out;
    }
    const obj = value as Mutable;
    const ref = obj["$ref"];

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
        const out: Mutable = { $ref: hoistedRef(claim(uri, fragment)) };
        // OpenAPI 3.1 allows siblings alongside `$ref`; they survive.
        for (const key of Object.keys(obj)) {
          if (key === "$ref") continue;
          out[key] = walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, true);
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
      const stitchRef = makeStitchRef(targetUri, fragment);
      if (stitchingUri !== null && stitchingUri === targetUri) return stitchRef;
      if (visiting.has(cycleKey(targetUri, fragment))) {
        stitchQueue.add(targetUri);
        return stitchRef;
      }
      visiting.add(cycleKey(targetUri, fragment));
      sources.add(targetUri);
      let targetDoc = docs.get(targetUri);
      if (targetDoc === undefined) {
        targetDoc = reader.read(targetUri);
        docs.set(targetUri, targetDoc);
      }
      const resolved = fragment === "" ? targetDoc : resolveJsonPointer(targetDoc, fragment);
      const inlined = walk(resolved, baseDirOf(targetUri), stitchingUri, targetUri, false);
      visiting.delete(cycleKey(targetUri, fragment));
      const siblings: Mutable = {};
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        siblings[key] = walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, false);
      }
      if (Object.keys(siblings).length === 0) return inlined;
      return inlined !== null && typeof inlined === "object" && !Array.isArray(inlined)
        ? { ...(inlined as Mutable), ...siblings }
        : inlined;
    }
    if (typeof ref === "string" && ref.startsWith("#") && externalSourceUri !== null) {
      const rewritten = rewriteInternalRefTarget(externalSourceUri, ref.slice(1));
      stitchQueue.add(externalSourceUri);
      const siblings: Mutable = { $ref: rewritten };
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        siblings[key] = walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, false);
      }
      return siblings;
    }

    const out: Mutable = {};
    for (const key of Object.keys(obj)) {
      out[key] = walkChild(obj, key, currentBase, stitchingUri, externalSourceUri, inSchema);
    }
    return out;
  };

  /**
   * Walk one child, deciding whether it is a schema position.
   *
   * Entering a schema: a `schema` key (media type, parameter, header) or
   * a `components.schemas` entry. Staying in one: only the keys that
   * hold subschemas. `example`, `default` and `enum` hold arbitrary
   * author data, so they drop back out; a `$ref`-shaped object inside an
   * example is data, not a reference.
   */
  const walkChild = (
    parent: Mutable,
    key: string,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
    parentInSchema: boolean,
  ): unknown => {
    const value = parent[key];
    if (parentInSchema && key === "discriminator") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const node: Mutable = { ...(value as Mutable) };
      mappingSites.push({ node, base: currentBase, source: externalSourceUri });
      return node;
    }
    const childInSchema = parentInSchema
      ? isSubschemaKey(key)
      : key === "schema" || key === "schemas";
    // `components.schemas` and the subschema *map* positions hold
    // `name -> schema`, so the schemas are one level below the key.
    const mapOfSchemas = parentInSchema ? isSchemaMapKey(key) : key === "schemas";
    if (mapOfSchemas && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const out: Mutable = {};
      for (const [name, sub] of Object.entries(value as Mutable)) {
        out[name] = walk(sub, currentBase, stitchingUri, externalSourceUri, true);
      }
      return out;
    }
    return walk(value, currentBase, stitchingUri, externalSourceUri, childInSchema);
  };

  const resolved = walk(entryDoc, baseDir, null, null, false) as OpenAPIDocument;

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
    hoisted[name] = true; // placeholder: claims the slot before walking
    let targetDoc = docs.get(target.uri);
    if (targetDoc === undefined) {
      targetDoc = reader.read(target.uri);
      docs.set(target.uri, targetDoc);
    }
    const content =
      target.fragment === "" ? targetDoc : resolveJsonPointer(targetDoc, target.fragment);
    hoisted[name] = walk(content, baseDirOf(target.uri), null, target.uri, true);
  }
  fixUpDiscriminatorMappings();
  mergeHoistedSchemas(resolved, hoisted);

  if (stitchQueue.size > 0) {
    const stitched: Mutable = {};
    while (stitchQueue.size > 0) {
      const uri = stitchQueue.values().next().value as string;
      stitchQueue.delete(uri);
      if (Object.hasOwn(stitched, uri)) continue;
      sources.add(uri);
      let targetDoc = docs.get(uri);
      if (targetDoc === undefined) {
        targetDoc = reader.read(uri);
        docs.set(uri, targetDoc);
      }
      const savedVisiting = new Set(visiting);
      visiting.clear();
      const inlined = walk(targetDoc, baseDirOf(uri), uri, uri, false);
      visiting.clear();
      for (const v of savedVisiting) visiting.add(v);
      stitched[uri] = inlined;
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
  return { document: resolved, sources: [...sources], specHygieneIssues };
}
