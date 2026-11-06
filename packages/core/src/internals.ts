/**
 * Internal re-exports for `@oaverify/core/core/internals`: the
 * operation model, which says where a document's Path Items and
 * operations are and which of them each engine serves. Reachable for
 * tooling that walks a document the way this project's own passes do,
 * and kept apart from the `@oaverify/core/core` barrel so the public
 * surface stays the structural contracts.
 *
 * Nothing here is covered by semver guarantees. Compare against the
 * main barrel in `./index.ts` before importing from here.
 *
 * @packageDocumentation
 */

export * from "./operation-model.js";
