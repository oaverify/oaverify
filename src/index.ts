/**
 * Default entry for `@oaverify/core`. Re-exports the HTTP validator
 * (`createValidator` and friends) plus the entirety of
 * `@oaverify/core/core`: error-tree helpers, formatters, shared
 * OpenAPI / HTTP types, and version detection.
 *
 * Lower-level pieces live on per-subsystem entrypoints:
 *
 *   - `@oaverify/core/schema`: JSON Schema 2020-12 compiler + dialects
 *   - `@oaverify/core/spec`: multi-file loader, resolver, overlays
 *   - `@oaverify/core/overlay-spec`: OpenAPI Overlay 1.0 to typed
 *     `SpecOverlay`
 *   - `@oaverify/core/formats`: the built-in format validators. One
 *     registry whatever JSON type a format constrains, so the numeric
 *     ones are here too.
 *   - `@oaverify/core/codegen-runtime`: the helpers a standalone
 *     validator emitted by `oaverify compile-spec` imports at runtime
 *   - `@oaverify/core/core`: the surface re-exported here, imported on
 *     its own
 *
 * Three more end in `/internals` (`schema`, `spec`, `validator`). Those
 * are compiler and resolver mechanics for plugins and tooling, and sit
 * outside the semver contract; each says so in its own header.
 *
 * @packageDocumentation
 */

export * from "../packages/validator/src/index.js";
export * from "../packages/core/src/index.js";
