# Changelog

## [4.0.0](https://github.com/oaverify/oaverify/compare/yaml-v3.8.0...yaml-v4.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **New package.** The YAML readers were extracted out of the
  batteries-included `@aahoughton/oav`: `createYamlFileReader`,
  `createSmartHttpReader`, `parseYamlString`, and the YAML-defaulting
  `loadSpecSync` now live here. `@oaverify/core` stays JSON-only, which is
  what keeps it free of runtime dependencies. Versioned with the rest of the
  suite, so it starts at 4.0.0.
* **Renamed from the `@aahoughton` scope.** npm `oav` belongs to
  Microsoft's Azure/oav, the same problem domain, so the old name was
  search-contaminated regardless of scope. The `@aahoughton/*` packages are
  deprecated and will receive no further releases; they keep working at
  3.8.0 / 1.1.0 indefinitely.

### Chore

* split the packages and rename to oaverify ([#480](https://github.com/oaverify/oaverify/issues/480)) ([a5ddcac](https://github.com/oaverify/oaverify/commit/a5ddcac565d64f3ddfc928bc0a62549ccd1f9f12))
