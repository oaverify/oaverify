/**
 * Internal re-exports for `@oaverify/core/spec/internals`. Exposes the
 * synchronous resolver and its sync reader primitives, which back the
 * public {@link loadSpecSync} but are kept off the main `@oaverify/core/spec`
 * barrel on purpose.
 *
 * `loadSpecSync` defaults its reader, so the common boot-time case
 * (read local JSON/YAML files, resolve `$ref`s, build a validator)
 * needs none of these. They live here for the narrow case where the
 * default reader's compose order doesn't fit and a caller wants to
 * build a custom sync reader or drive `resolveSpecSync` directly. By
 * keeping them at `/internals` rather than fully private, real usage
 * becomes the demand signal for whether to promote `SyncDocumentReader`
 * to a public, supported extension point.
 *
 * Nothing here is covered by semver guarantees. Compare against the
 * main barrel in `./index.ts` before importing from here.
 *
 * @packageDocumentation
 */

export {
  composeReadersSync,
  createFileReaderSync,
  fetchInit,
  type SyncDocumentReader,
} from "./reader.js";
export { resolveSpecSync, type ResolveSpecSyncOptions } from "./resolver-sync.js";
