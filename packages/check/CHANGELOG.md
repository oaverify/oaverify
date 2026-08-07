# Changelog

## [6.0.0](https://github.com/oaverify/oaverify/compare/check-v5.4.0...check-v6.0.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **check:** check now exits 2 (CheckAbortedError) on a document it cannot grade even when the selection reaches no schema code; such runs previously exited 0 with an empty report. Fixes #674.
* **check,cli:** `CheckOptions.only` is removed. `checkSpec(spec, { only: ["hygiene"] })` becomes `checkSpec(spec, { findings: selectionForClasses(["hygiene"]) })`. The CLI is untouched; `--only` now resolves to a selection at the CLI layer.
* **formats:** builtInFormats values are FormatDefinition, not (value: string) => boolean. Reading one back as a function needs a narrow; the 18 string entries are still bare functions at runtime. fromAjvFormats returns the same widened shape and now carries `type: "number"` through as a numeric format instead of dropping it into the string map, where it was called with strings. Passing `formats: { name: (s) => ... }` is unaffected.

### Features

* **check,cli:** add --skip, and share one key parser with --severity ([#667](https://github.com/oaverify/oaverify/issues/667)) ([5d4a757](https://github.com/oaverify/oaverify/commit/5d4a757eb999608659404aeb04b37239125e6b95))
* **check,cli:** one findings flag, replacing --only and --skip ([#673](https://github.com/oaverify/oaverify/issues/673)) ([5e66e45](https://github.com/oaverify/oaverify/commit/5e66e451c0934c21290375ea72ecb36622b0ea8f))
* **formats:** cover the assertable OpenAPI Format Registry names ([#697](https://github.com/oaverify/oaverify/issues/697)) ([2cd9140](https://github.com/oaverify/oaverify/commit/2cd9140ad34c598e5784df084c4174f3366b4c10))
* **formats:** one format registry, and assert int32 and int64 ([#671](https://github.com/oaverify/oaverify/issues/671)) ([dab091e](https://github.com/oaverify/oaverify/commit/dab091eb0eaecad6a2ff500e12df7278dc7ef89a))
* **schema:** surface the pattern u-mode fallback as a schema-lint finding ([#684](https://github.com/oaverify/oaverify/issues/684)) ([4995e1f](https://github.com/oaverify/oaverify/commit/4995e1f1f26bdb570767619fd097e2e58a74f32e))


### Bug Fixes

* **check:** abort on an ungradeable document at every selection ([#680](https://github.com/oaverify/oaverify/issues/680)) ([22da155](https://github.com/oaverify/oaverify/commit/22da1552e906cb66b8c26b4539618bc69cac43a9))
* **check:** guard the examples pass against catastrophic patterns ([#688](https://github.com/oaverify/oaverify/issues/688)) ([dc70741](https://github.com/oaverify/oaverify/commit/dc707411cdce0872d4c8c20ab4fa648579ea1392))


### Documentation

* correct the claims 6.0 made stale ([#698](https://github.com/oaverify/oaverify/issues/698)) ([2c93f7f](https://github.com/oaverify/oaverify/commit/2c93f7f4866f1a902a09869c250a3bd41e2f720a))
* publish the detection corpus by pointing at it, and answer the custom-rule question ([#689](https://github.com/oaverify/oaverify/issues/689)) ([519e283](https://github.com/oaverify/oaverify/commit/519e28330e873ca94a18d6a705dbb282f58d654b))

## [5.4.0](https://github.com/oaverify/oaverify/compare/check-v5.3.0...check-v5.4.0) (2026-08-04)

First release. `@oaverify/check` is the document check that `oaverify check` runs, published so you can call it from your own tooling.

`checkSpec(resolved, options)` returns the findings from the six passes. `severityFor`, `defaultSeverityFor` and `parseSeverityMap` grade them, `renderSarif` emits SARIF 2.1.0, and the class and code registries plus the finding types are exported alongside. Findings from your own rules can be concatenated with oaverify's and graded and rendered through the same functions.

It takes a `ResolvedSpec` rather than an `OpenAPIDocument`: provenance regions and inlined components are byproducts of resolution, and without them a finding loses its source address and SARIF loses its locations.

The version starts at 5.4.0 because the package is part of the linked release group, not because there were five earlier ones.


### Features

* **check:** move the composed spec check into @oaverify/check ([#654](https://github.com/oaverify/oaverify/issues/654)) ([2b376e2](https://github.com/oaverify/oaverify/commit/2b376e253f59dcf97b6b8a71cdc670e6fbb8260d))
