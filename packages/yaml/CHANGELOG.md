# Changelog

## [5.2.0](https://github.com/oaverify/oaverify/compare/yaml-v5.1.0...yaml-v5.2.0) (2026-07-31)


### Features

* **spec:** add containment and outbound-request controls to the readers ([#585](https://github.com/oaverify/oaverify/issues/585)) ([de655a4](https://github.com/oaverify/oaverify/commit/de655a4350450b90ff75e65b73b24bf59cd5096d))


### Bug Fixes

* **spec:** make confine and maxBytes enforce what they claim ([#589](https://github.com/oaverify/oaverify/issues/589)) ([6fd82d5](https://github.com/oaverify/oaverify/commit/6fd82d5ac7bd32322c79f0add309ca286b17a9cb))

## [5.1.0](https://github.com/oaverify/oaverify/compare/yaml-v5.0.0...yaml-v5.1.0) (2026-07-30)


### Chore

* **yaml:** Synchronize oaverify versions

## [5.0.0](https://github.com/oaverify/oaverify/compare/yaml-v4.0.0...yaml-v5.0.0) (2026-07-29)

### Chore

* Version bump only, to stay in lockstep with the `@oaverify/core` release group. This package's source is unchanged since 4.0.0.

### Notes

Validation semantics come from `@oaverify/core`, which had three
outcome-changing fixes in this release: malformed schemas behind a
`$ref` now throw, `$ref` siblings are applied at body roots, and
`dialect` now overrides the version the document declares. See
[its notes](https://github.com/oaverify/oaverify/blob/main/CHANGELOG.md)
and [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md).

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
