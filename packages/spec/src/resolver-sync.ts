import { resolveJsonPointer, type OpenAPIDocument } from "@oaverify/internal-core";
import type { SyncDocumentReader } from "./reader.js";
import { lintResolvedSpec } from "./lint.js";
import type { ResolvedSpec } from "./resolver.js";
import {
  baseDirOf,
  cycleKey,
  makeStitchRef,
  mergeStitchedExternals,
  type Mutable,
  resolveRelative,
  rewriteInternalRefTarget,
} from "./resolver-shared.js";

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
 * semantics (external-ref inlining, circular-ref stitching under
 * `$defs.__ext__`, internal-ref rewriting, sibling preservation, the
 * source list, and lint), driven by a {@link SyncDocumentReader} so it
 * returns a {@link ResolvedSpec} directly instead of a `Promise`.
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

  const walk = (
    value: unknown,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
  ): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(walk(item, currentBase, stitchingUri, externalSourceUri));
      }
      return out;
    }
    const obj = value as Mutable;
    const ref = obj["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const [refPath, fragment = ""] = ref.split("#") as [string, string | undefined];
      const targetUri = resolveRelative(currentBase, refPath);
      const stitchRef = makeStitchRef(targetUri, fragment);
      if (stitchingUri !== null && stitchingUri === targetUri) {
        // Self-ref inside the subtree we're currently stitching; keep as
        // internal ref (the stitched copy serves as the target).
        return stitchRef;
      }
      if (visiting.has(cycleKey(targetUri, fragment))) {
        // Cycle: short-circuit and queue the target for stitching so the
        // internal ref has something to resolve against.
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
      // Recurse into the inlined subtree with the external file's URI
      // as the source context. Any internal `#/...` refs inside the
      // subtree are actually refs into this external file and will be
      // rewritten to point at its stitched location (see the internal-
      // ref branch below).
      const inlined = walk(resolved, baseDirOf(targetUri), stitchingUri, targetUri);
      visiting.delete(cycleKey(targetUri, fragment));
      // preserve sibling properties (OpenAPI 3.1 allows $ref + siblings for some objects)
      const siblings: Mutable = {};
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        siblings[key] = walk(obj[key], currentBase, stitchingUri, externalSourceUri);
      }
      if (Object.keys(siblings).length === 0) return inlined;
      return inlined !== null && typeof inlined === "object" && !Array.isArray(inlined)
        ? { ...(inlined as Mutable), ...siblings }
        : inlined;
    }
    // Internal ref inside a subtree that came from an external file:
    // rewrite it to point at the external's stitched location and make
    // sure that file ends up in $defs.__ext__. Without this rewrite,
    // `#/components/schemas/Thing` inside an inlined subtree would
    // resolve against the *root* document, orphaning the ref.
    if (typeof ref === "string" && ref.startsWith("#") && externalSourceUri !== null) {
      const rewritten = rewriteInternalRefTarget(externalSourceUri, ref.slice(1));
      stitchQueue.add(externalSourceUri);
      const siblings: Mutable = { $ref: rewritten };
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        siblings[key] = walk(obj[key], currentBase, stitchingUri, externalSourceUri);
      }
      return siblings;
    }
    const out: Mutable = {};
    for (const key of Object.keys(obj)) {
      out[key] = walk(obj[key], currentBase, stitchingUri, externalSourceUri);
    }
    return out;
  };

  const resolved = walk(entryDoc, baseDir, null, null) as OpenAPIDocument;

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
      // Walk the full document from scratch. Self-references collapse
      // into internal refs pointing at the stitched copy so the walk
      // terminates. Pass `uri` as externalSourceUri so *internal* refs
      // inside the stitched content (e.g. `#/components/schemas/Thing`)
      // get rewritten to point at their siblings under the stitched
      // location, not at the root document.
      const savedVisiting = new Set(visiting);
      visiting.clear();
      const inlined = walk(targetDoc, baseDirOf(uri), uri, uri);
      visiting.clear();
      for (const v of savedVisiting) visiting.add(v);
      stitched[uri] = inlined;
    }
    mergeStitchedExternals(resolved, stitched);
  }

  const specHygieneIssues = options.lint ? lintResolvedSpec(resolved) : [];
  return { document: resolved, sources: [...sources], specHygieneIssues };
}
