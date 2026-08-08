# Changelog

## [6.1.0](https://github.com/oaverify/oaverify/compare/check-v6.0.0...check-v6.1.0) (2026-08-08)


### Features

* **formats:** assert language, an RFC 5646 tag ([#733](https://github.com/oaverify/oaverify/issues/733)) ([6393bfe](https://github.com/oaverify/oaverify/commit/6393bfe7d1fb27f17c73b35d8e1fe4c2d7c2e5ca))
* **formats:** assert media-range, the RFC 9110 production ([#734](https://github.com/oaverify/oaverify/issues/734)) ([c2c3721](https://github.com/oaverify/oaverify/commit/c2c3721e4d6a39f9915a4a167e917997c1efc33b))
* **formats:** assert six more OpenAPI Format Registry names ([#732](https://github.com/oaverify/oaverify/issues/732)) ([62d6b34](https://github.com/oaverify/oaverify/commit/62d6b3471d7cdc78686e0c184f1abc8a924a4bbf))


### Bug Fixes

* **check:** keep findings produced before an aborted check ([#719](https://github.com/oaverify/oaverify/issues/719)) ([51be0c7](https://github.com/oaverify/oaverify/commit/51be0c7fef2d529fd058e0699d3b81f18519580a)), closes [#716](https://github.com/oaverify/oaverify/issues/716)
* **router:** report a malformed path template instead of throwing URIError ([#712](https://github.com/oaverify/oaverify/issues/712)) ([d227968](https://github.com/oaverify/oaverify/commit/d227968c745cd7b47cce0a654fa7216c56696ed5)), closes [#708](https://github.com/oaverify/oaverify/issues/708)

## [6.0.0](https://github.com/oaverify/oaverify/compare/check-v5.4.0...check-v6.0.0) (2026-08-07)

**Selecting findings changed shape, and an ungradeable document now aborts everywhere.** `CheckOptions.only` is replaced by `findings`, which reaches an exact code or a family as well as a class. See [the v6 migration guide](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md).

### ⚠ BREAKING CHANGES

* **check,cli:** `CheckOptions.only` is removed. `checkSpec(spec, { only: ["hygiene"] })` becomes `checkSpec(spec, { findings: selectionForClasses(["hygiene"]) })`. A `FindingSelection` reaches an exact code or a family as well as a class, so `selectionForClasses` is the shorthand for the class-only case. ([#673](https://github.com/oaverify/oaverify/issues/673)) — migration guide: "`--only` becomes `--findings`"
* **check:** `check` now exits 2 (`CheckAbortedError`) on a document it cannot grade even when the selection reaches no schema code; such runs previously exited 0 with an empty report. Fixes [#674](https://github.com/oaverify/oaverify/issues/674). ([#680](https://github.com/oaverify/oaverify/issues/680)) — migration guide: "`check` aborts on an ungradeable document at every selection"
* **formats:** `builtInFormats` values are `FormatDefinition`, not `(value: string) => boolean`. This reaches `check` because the format pass fixes its known set at `builtInFormats`. Reading an entry back as a function needs a narrow; the 21 string entries are still bare functions at runtime. ([#671](https://github.com/oaverify/oaverify/issues/671)) — migration guide: "`builtInFormats` values are `FormatDefinition`"

### Features

* **formats:** the format pass classifies names against the whole [OpenAPI Format Registry](https://spec.openapis.org/registry/format/) rather than the OAS 3.0 shortlist, so a 3.1 document using `int8`, `http-date` or `sf-token` is no longer told the name is a vendor format. `format-not-validated` now distinguishes three cases: a name no validator can assert, a registry name not asserted yet, and a name you invented. ([#697](https://github.com/oaverify/oaverify/issues/697)) ([2cd9140](https://github.com/oaverify/oaverify/commit/2cd9140ad34c598e5784df084c4174f3366b4c10))
* **formats:** one format registry, and assert int32 and int64 ([#671](https://github.com/oaverify/oaverify/issues/671)) ([dab091e](https://github.com/oaverify/oaverify/commit/dab091eb0eaecad6a2ff500e12df7278dc7ef89a))
* **schema:** surface the `pattern` u-mode fallback as a schema-lint finding ([#684](https://github.com/oaverify/oaverify/issues/684)) ([4995e1f](https://github.com/oaverify/oaverify/commit/4995e1f1f26bdb570767619fd097e2e58a74f32e))

### Bug Fixes

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
