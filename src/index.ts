/**
 * Default entry for `@oaverify/core`. Re-exports the HTTP validator
 * (`createValidator` and friends) plus the entirety of
 * `@oaverify/core/core`: error-tree helpers, formatters, shared
 * OpenAPI / HTTP types, and version detection.
 *
 * Lower-level pieces live on per-subsystem entrypoints:
 *   - `@oaverify/core/schema`  — JSON Schema 2020-12 compiler + dialects
 *   - `@oaverify/core/spec`    — multi-file loader, resolver, overlays
 *   - `@oaverify/core/formats` — built-in string format validators
 *   - `@oaverify/core/core`    — the surface re-exported here, imported on its own
 */

export * from "../packages/validator/src/index.js";
export * from "../packages/core/src/index.js";
