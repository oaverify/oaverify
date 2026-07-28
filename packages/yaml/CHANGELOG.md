# Changelog

## [4.0.0](https://github.com/oaverify/oaverify/compare/yaml-v3.8.0...yaml-v4.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* `@aahoughton/oav` no longer exports the library. Import from `@aahoughton/oav-core` (or `@aahoughton/oav-core/schema`, `/spec`, `/formats`, `/overlay-spec`) instead, and take `@aahoughton/oav-yaml` for `createYamlFileReader`, `createSmartHttpReader`, `parseYamlString`, and `loadSpecSync`. Generated validators emitted by `compile-spec` / `compile-schema` now import `@aahoughton/oav-core` by default.

### Chore

* split the packages and rename to oaverify ([#480](https://github.com/oaverify/oaverify/issues/480)) ([a5ddcac](https://github.com/oaverify/oaverify/commit/a5ddcac565d64f3ddfc928bc0a62549ccd1f9f12))
