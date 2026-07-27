import { resolveJsonPointer, type OpenAPIDocument } from "@oaverify/internal-core";
import type { DocumentReader } from "./reader.js";
import { lintResolvedSpec, type SpecHygieneIssue } from "./lint.js";
import {
  baseDirOf,
  cycleKey,
  makeStitchRef,
  mergeStitchedExternals,
  type Mutable,
  resolveRelative,
  rewriteInternalRefTarget,
} from "./resolver-shared.js";

// Re-export the canonical implementation so @oaverify/internal-spec consumers who
// imported `resolveJsonPointer` keep working.
export { resolveJsonPointer };

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
}

/**
 * Output of {@link resolveSpec}: the stitched OpenAPI document plus a record
 * of how every external file was inlined.
 *
 * @public
 */
export interface ResolvedSpec {
  document: OpenAPIDocument;
  /** URIs of every external file that was loaded during resolution. */
  sources: string[];
  /**
   * Spec-hygiene findings from {@link lintResolvedSpec}. Empty unless
   * {@link ResolveSpecOptions.lint} was set. Same name and shape as
   * {@link Validator.specHygieneIssues} on the validator side.
   */
  specHygieneIssues: readonly SpecHygieneIssue[];
}

/**
 * Load an OpenAPI 3.1 document and inline all external `$ref`s, producing a
 * single self-contained document. Circular references are materialized under
 * `$defs.__ext__/<encoded-uri>` so the compiler can resolve them via the
 * identity-keyed schema cache; non-circular external refs are fully inlined.
 *
 * The synchronous mirror is `resolveSpecSync` (reachable via
 * `oav/spec/internals`); both share the pure URI / ref-rewriting helpers
 * in `./resolver-shared.ts` and are pinned to identical behavior by the
 * parity suite. Keep any change to the walk here mirrored there.
 *
 * @param options - Reader + entry URI.
 * @returns Resolved document + the list of files loaded.
 *
 * @example
 * ```ts
 * const reader = composeReaders([createFileReader()]);
 * const { document } = await resolveSpec({ reader, entry: "openapi.yaml" });
 * ```
 *
 * @public
 */
export async function resolveSpec(options: ResolveSpecOptions): Promise<ResolvedSpec> {
  const { reader } = options;
  const baseDir = options.baseUri ?? baseDirOf(options.entry);
  const sources = new Set<string>([options.entry]);
  const docs = new Map<string, unknown>();

  const entryDoc = await reader.read(options.entry);
  docs.set(options.entry, entryDoc);

  const visiting = new Set<string>();
  const stitchQueue = new Set<string>();

  const walk = async (
    value: unknown,
    currentBase: string,
    stitchingUri: string | null,
    externalSourceUri: string | null,
  ): Promise<unknown> => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(await walk(item, currentBase, stitchingUri, externalSourceUri));
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
        targetDoc = await reader.read(targetUri);
        docs.set(targetUri, targetDoc);
      }
      const resolved = fragment === "" ? targetDoc : resolveJsonPointer(targetDoc, fragment);
      // Recurse into the inlined subtree with the external file's URI
      // as the source context. Any internal `#/...` refs inside the
      // subtree are actually refs into this external file and will be
      // rewritten to point at its stitched location (see the internal-
      // ref branch below).
      const inlined = await walk(resolved, baseDirOf(targetUri), stitchingUri, targetUri);
      visiting.delete(cycleKey(targetUri, fragment));
      // preserve sibling properties (OpenAPI 3.1 allows $ref + siblings for some objects)
      const siblings: Mutable = {};
      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        siblings[key] = await walk(obj[key], currentBase, stitchingUri, externalSourceUri);
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
        siblings[key] = await walk(obj[key], currentBase, stitchingUri, externalSourceUri);
      }
      return siblings;
    }
    const out: Mutable = {};
    for (const key of Object.keys(obj)) {
      out[key] = await walk(obj[key], currentBase, stitchingUri, externalSourceUri);
    }
    return out;
  };

  const resolved = (await walk(entryDoc, baseDir, null, null)) as OpenAPIDocument;

  if (stitchQueue.size > 0) {
    const stitched: Mutable = {};
    while (stitchQueue.size > 0) {
      const uri = stitchQueue.values().next().value as string;
      stitchQueue.delete(uri);
      if (Object.hasOwn(stitched, uri)) continue;
      sources.add(uri);
      let targetDoc = docs.get(uri);
      if (targetDoc === undefined) {
        targetDoc = await reader.read(uri);
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
      const inlined = await walk(targetDoc, baseDirOf(uri), uri, uri);
      visiting.clear();
      for (const v of savedVisiting) visiting.add(v);
      stitched[uri] = inlined;
    }
    mergeStitchedExternals(resolved, stitched);
  }

  const specHygieneIssues = options.lint ? lintResolvedSpec(resolved) : [];
  return { document: resolved, sources: [...sources], specHygieneIssues };
}
