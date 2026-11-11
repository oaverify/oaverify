import { isPromise } from "node:util/types";
import type { SyncDocumentReader } from "./reader.js";
import { resolveSpecSteps, type ResolvedSpec, type TrackedResolution } from "./resolver.js";

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
  /**
   * What to do with a reference whose target cannot be read. Defaults
   * to `"throw"`. See {@link ResolveSpecOptions.onUnresolved}.
   */
  onUnresolved?: "throw" | "record";
}

/**
 * Synchronous form of {@link resolveSpec}: the same resolution, driven
 * by a {@link SyncDocumentReader} so it returns a {@link ResolvedSpec}
 * directly instead of a `Promise`. Both run `resolveSpecSteps`; this
 * one answers each read without awaiting.
 *
 * Blocking by construction (the reader reads files synchronously); for
 * boot-time / CLI use, not per-request. Use the async
 * {@link resolveSpec} for non-blocking contexts.
 *
 * @public
 */
export function resolveSpecSync(options: ResolveSpecSyncOptions): ResolvedSpec {
  return resolveSpecSyncTracked(options).resolved;
}

/**
 * {@link resolveSpecSync}, also returning the regions the walk recorded whether
 * or not `provenance` was requested. The loaders lint with them.
 *
 * @internal
 */
export function resolveSpecSyncTracked(options: ResolveSpecSyncOptions): TrackedResolution {
  const { reader } = options;
  const steps = resolveSpecSteps(options);
  let step = steps.next();
  while (!step.done) {
    let doc: unknown;
    try {
      doc = readSynchronously(reader, step.value);
    } catch (err) {
      step = steps.throw(err);
      continue;
    }
    step = steps.next(doc);
  }
  return step.value;
}

function readSynchronously(reader: SyncDocumentReader, uri: string): unknown {
  const doc = reader.read(uri);
  if (
    doc !== null &&
    (typeof doc === "object" || typeof doc === "function") &&
    typeof (doc as { then?: unknown }).then === "function"
  ) {
    // Observe already-started native promises without invoking a foreign
    // thenable, whose then method may start lazy work.
    if (isPromise(doc)) void Promise.prototype.then.call(doc, undefined, () => {});
    throw new Error(
      "reader returned a thenable; use resolveSpec or loadSpec with this reader, or provide a synchronous reader",
    );
  }
  return doc;
}
