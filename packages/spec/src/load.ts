import { createFileReaderSync, type DocumentReader, type SyncDocumentReader } from "./reader.js";
import { applyOverlays, type SpecOverlay } from "./overlay.js";
import { resolveSpec, type ResolvedSpec } from "./resolver.js";
import { resolveSpecSync } from "./resolver-sync.js";
import { lintResolvedSpec } from "./lint.js";

/**
 * Options accepted by {@link loadSpec}.
 *
 * @public
 */
export interface LoadSpecOptions {
  /** Reader used to fetch documents by URI. */
  reader: DocumentReader;
  /** Entry URI. */
  entry: string;
  /** Base directory/URI for resolving relative refs. Defaults to the entry's directory. */
  baseUri?: string;
  /** Overlays to apply in order after resolution. */
  overlays?: readonly SpecOverlay[];
  /**
   * Run spec-hygiene lint passes against the post-overlay document.
   * Findings land in {@link ResolvedSpec.specHygieneIssues}. Defaults
   * to `false`.
   */
  lint?: boolean;
}

/**
 * Load, resolve, and (optionally) overlay an OpenAPI spec in the one
 * step. Runs `resolveSpec` to resolve external `$ref`s (hoisting schema
 * targets into `components.schemas`, inlining the rest), then applies
 * each overlay in order to the resolved document.
 *
 * This is the recommended entrypoint for consumers; use
 * {@link resolveSpec} and {@link applyOverlays} directly only when you
 * need a custom composition.
 *
 * @example
 * ```ts
 * const reader = composeReaders([createFileReader()]);
 * const { document } = await loadSpec({ reader, entry: "openapi.yaml", overlays });
 * const validator = createValidator(document);
 * ```
 *
 * @public
 */
export async function loadSpec(options: LoadSpecOptions): Promise<ResolvedSpec> {
  // resolveSpec lints the pre-overlay document if asked, but the overlay
  // pass below can change reachability (add or remove operations,
  // components, refs). Defer the lint to after overlays are applied so
  // the findings reflect the document the consumer will actually use.
  const resolved = await resolveSpec({
    reader: options.reader,
    entry: options.entry,
    ...(options.baseUri !== undefined && { baseUri: options.baseUri }),
  });
  const overlaid =
    options.overlays && options.overlays.length > 0
      ? applyOverlays(resolved.document, options.overlays)
      : resolved.document;
  const specHygieneIssues = options.lint ? lintResolvedSpec(overlaid) : [];
  return { document: overlaid, sources: resolved.sources, specHygieneIssues };
}

/**
 * Options accepted by {@link loadSpecSync}.
 *
 * Mirror of {@link LoadSpecOptions} with one deliberate divergence:
 * `reader` is optional. The async {@link loadSpec} requires a reader
 * because composing readers (file / HTTP / memory / YAML) is a
 * first-class part of its multi-runtime story. The sync loader serves
 * one runtime (boot-time Node reading local files), so it defaults its
 * reader and keeps the sync reader-composition primitives out of the
 * public surface. `reader` is the additive seam: pass a
 * {@link SyncDocumentReader}-shaped `{ read, canRead }` object to plug
 * in a custom sync source without any extra import.
 *
 * @public
 */
export interface LoadSpecSyncOptions {
  /** Entry URI. */
  entry: string;
  /**
   * Synchronous reader. Defaults to a JSON-only filesystem reader
   * ({@link createFileReaderSync}). `@oaverify/yaml` ships a
   * `loadSpecSync` whose default also reads YAML.
   */
  reader?: SyncDocumentReader;
  /** Base directory/URI for resolving relative refs. Defaults to the entry's directory. */
  baseUri?: string;
  /** Overlays to apply in order after resolution. */
  overlays?: readonly SpecOverlay[];
  /**
   * Run spec-hygiene lint passes against the post-overlay document.
   * Findings land in {@link ResolvedSpec.specHygieneIssues}. Defaults
   * to `false`.
   */
  lint?: boolean;
}

/**
 * Synchronous mirror of {@link loadSpec}: resolve external `$ref`s,
 * apply overlays, then (optionally) lint, returning a
 * {@link ResolvedSpec} directly instead of a `Promise`. Runs the
 * identical pipeline as {@link loadSpec} with the identical result
 * shape; the lint pass is deferred to after overlays for the same
 * reason (overlays change reachability).
 *
 * For load-once-at-boot programs and CLIs that build their validator
 * inside a synchronous bootstrap and can't await. Blocking by
 * construction (filesystem reads via `readFileSync`); for boot-time /
 * CLI use, not per-request. For non-blocking contexts the async
 * {@link loadSpec} stays the right tool. An unreadable or malformed
 * spec throws (mirroring {@link loadSpec}); a caller that wants
 * "unreadable spec disables validation rather than crashing boot"
 * expresses that with its own `try`/`catch`.
 *
 * @example
 * ```ts
 * // JSON specs (@oaverify/core). For YAML, use @oaverify/yaml's loadSpecSync.
 * const { document } = loadSpecSync({ entry: "openapi.json" });
 * const validator = createValidator(document);
 * ```
 *
 * @public
 */
export function loadSpecSync(options: LoadSpecSyncOptions): ResolvedSpec {
  const reader = options.reader ?? createFileReaderSync();
  const resolved = resolveSpecSync({
    reader,
    entry: options.entry,
    ...(options.baseUri !== undefined && { baseUri: options.baseUri }),
  });
  const overlaid =
    options.overlays && options.overlays.length > 0
      ? applyOverlays(resolved.document, options.overlays)
      : resolved.document;
  const specHygieneIssues = options.lint ? lintResolvedSpec(overlaid) : [];
  return { document: overlaid, sources: resolved.sources, specHygieneIssues };
}
