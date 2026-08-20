# Changelog

## [7.2.0](https://github.com/oaverify/oaverify/compare/check-v7.1.0...check-v7.2.0) (2026-08-20)

### Upgrading

* **`path-param-unused` is reported once per path item** rather than
  once per operation, so a document with N operations loses N-1
  duplicate findings, and two new cases report. A finding count that
  drops on upgrade is this ([#891](https://github.com/oaverify/oaverify/issues/891)).
* **A `security` or `parameters` field that cannot be read is a
  finding, not a crash.** `oaverify check` reports a located finding
  and exits 1, where it exited 3 ([#883](https://github.com/oaverify/oaverify/issues/883), [#884](https://github.com/oaverify/oaverify/issues/884)).
* **`unserved-parameter-location` is a new finding.** It reports a
  parameter location the validator cannot serve. Graded `warning`, so
  the exit code is unchanged by default, though the grade can fall and
  `--severity` can promote it ([#841](https://github.com/oaverify/oaverify/issues/841)).

### Features

* **check:** report a parameter location the validator cannot serve ([#841](https://github.com/oaverify/oaverify/issues/841)) ([b3aac5b](https://github.com/oaverify/oaverify/commit/b3aac5b0342196a26ad1a68bad78d016bda6fd36))
* **spec:** record a reference the resolver cannot follow instead of throwing ([#878](https://github.com/oaverify/oaverify/issues/878)) ([733214c](https://github.com/oaverify/oaverify/commit/733214c5db5bb72e5a239da0f05022a4f9aade2a)), closes [#817](https://github.com/oaverify/oaverify/issues/817)


### Bug Fixes

* read a parameters field that is not a list as no parameters ([#884](https://github.com/oaverify/oaverify/issues/884)) ([077af8c](https://github.com/oaverify/oaverify/commit/077af8c36ed405c71b062a4116b3b3efd02b9cac)), closes [#837](https://github.com/oaverify/oaverify/issues/837)
* read a security field that is not a list without throwing ([#896](https://github.com/oaverify/oaverify/issues/896)) ([9100ffc](https://github.com/oaverify/oaverify/commit/9100ffc974f31d85acfbcb8414614c3cac6a725b)), closes [#883](https://github.com/oaverify/oaverify/issues/883)
* **validator:** refuse a parameter location the validator cannot serve ([#838](https://github.com/oaverify/oaverify/issues/838)) ([57bae2a](https://github.com/oaverify/oaverify/commit/57bae2a11bfd2f22216d21110a48d1bbe2da6d00))


## [7.1.0](https://github.com/oaverify/oaverify/compare/check-v7.0.0...check-v7.1.0) (2026-08-16)


### Features

* **validator:** read OpenAPI 3.2's cookie parameter style ([#828](https://github.com/oaverify/oaverify/issues/828)) ([63efe44](https://github.com/oaverify/oaverify/commit/63efe4481f0e729c40657109d1a148740b050800))

## [7.0.0](https://github.com/oaverify/oaverify/compare/check-v6.0.0...check-v7.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **core:** the "flat" output-format alias is removed; pass "summary" instead. This is the `--format` flag and `formatError`'s renderer name, not `ValidatorOptions.output: "flat"`, which is unaffected.
* **validator:** bound the Fetch adapter's body read by maxTotalBytes ([#785](https://github.com/oaverify/oaverify/issues/785))
* @oaverify/yaml is now @oaverify/syntax. Every exported name and behaviour is unchanged; update the specifier. See docs/migration-v7.md.

### Features

* **check:** locate each sub-rejection of an invalid example in SARIF ([#778](https://github.com/oaverify/oaverify/issues/778)) ([d81ab42](https://github.com/oaverify/oaverify/commit/d81ab42175d663f5d3761c00e54f8566d3fc9346))
* **check:** point a finding at the key where the name is the subject ([#771](https://github.com/oaverify/oaverify/issues/771)) ([81d69ec](https://github.com/oaverify/oaverify/commit/81d69ecd4e51f2074387cfb3826627eb350fc2c6))
* **core:** share the leaf detail renderer between both message sites ([#782](https://github.com/oaverify/oaverify/issues/782)) ([fd0827c](https://github.com/oaverify/oaverify/commit/fd0827cdf2ae7cdb36b6634d1a76816eb6e4c604)), closes [#777](https://github.com/oaverify/oaverify/issues/777)
* **formats:** assert language, an RFC 5646 tag ([#733](https://github.com/oaverify/oaverify/issues/733)) ([6393bfe](https://github.com/oaverify/oaverify/commit/6393bfe7d1fb27f17c73b35d8e1fe4c2d7c2e5ca))
* **formats:** assert media-range, the RFC 9110 production ([#734](https://github.com/oaverify/oaverify/issues/734)) ([c2c3721](https://github.com/oaverify/oaverify/commit/c2c3721e4d6a39f9915a4a167e917997c1efc33b))
* **formats:** assert six more OpenAPI Format Registry names ([#732](https://github.com/oaverify/oaverify/issues/732)) ([62d6b34](https://github.com/oaverify/oaverify/commit/62d6b3471d7cdc78686e0c184f1abc8a924a4bbf))
* line and column for a check finding ([#769](https://github.com/oaverify/oaverify/issues/769)) ([781108a](https://github.com/oaverify/oaverify/commit/781108a4afa3fa5c4d749e4040d73b4e30bb2a6f))
* rename @oaverify/yaml to @oaverify/syntax ([#768](https://github.com/oaverify/oaverify/issues/768)) ([7b29cc1](https://github.com/oaverify/oaverify/commit/7b29cc166f4e7e5ecb4e2c2f197c131ee910f752))
* **validator:** bound the Fetch adapter's body read by maxTotalBytes ([#785](https://github.com/oaverify/oaverify/issues/785)) ([bc45651](https://github.com/oaverify/oaverify/commit/bc45651b24093bb513b93329bb82feb85200a5fe))


### Bug Fixes

* **check:** give float its own reason for going unasserted ([#795](https://github.com/oaverify/oaverify/issues/795)) ([e78df56](https://github.com/oaverify/oaverify/commit/e78df568cf8153efe741154fe5e9de146cc68b7e))
* **check:** keep findings produced before an aborted check ([#719](https://github.com/oaverify/oaverify/issues/719)) ([51be0c7](https://github.com/oaverify/oaverify/commit/51be0c7fef2d529fd058e0699d3b81f18519580a)), closes [#716](https://github.com/oaverify/oaverify/issues/716)
* **check:** state a rule's explanation on the rule, not in every finding ([#774](https://github.com/oaverify/oaverify/issues/774)) ([be5aa81](https://github.com/oaverify/oaverify/commit/be5aa81923b5173a5c01f5c3ecfd01f06478da8b)), closes [#773](https://github.com/oaverify/oaverify/issues/773)
* **router:** report a malformed path template instead of throwing URIError ([#712](https://github.com/oaverify/oaverify/issues/712)) ([d227968](https://github.com/oaverify/oaverify/commit/d227968c745cd7b47cce0a654fa7216c56696ed5)), closes [#708](https://github.com/oaverify/oaverify/issues/708)
* stop raw V8 messages reaching the user on null document nodes ([#794](https://github.com/oaverify/oaverify/issues/794)) ([a632cd4](https://github.com/oaverify/oaverify/commit/a632cd4ecba5c5cce58c77046a2689be2b5066b1))


### Documentation

* correct four documentation defects found in the v7 review ([#792](https://github.com/oaverify/oaverify/issues/792)) ([bef64db](https://github.com/oaverify/oaverify/commit/bef64dbe4607219a31e545a8880e24d2ff760bce))
* pare the prose docs and rework the README arrival surface ([#814](https://github.com/oaverify/oaverify/issues/814)) ([3593ef7](https://github.com/oaverify/oaverify/commit/3593ef7bd0a078c123ed94fec0767c066b96a297))
* **tsdoc:** correct comments that misdescribe the code, and fix dead links ([#815](https://github.com/oaverify/oaverify/issues/815)) ([ecc7c24](https://github.com/oaverify/oaverify/commit/ecc7c24eabe97f60d29b0897f45937a1cfda146d))
* **tsdoc:** fix references to things that do not exist, and three gaps ([#808](https://github.com/oaverify/oaverify/issues/808)) ([06c2920](https://github.com/oaverify/oaverify/commit/06c292075a15e0ac187e04a6d7b75046d8674cf9))


### Chore

* **core:** remove the deprecated "flat" output-format alias ([#791](https://github.com/oaverify/oaverify/issues/791)) ([24c3ad9](https://github.com/oaverify/oaverify/commit/24c3ad9207bc3d3523c2adbcc76b0b6044d0e38b))

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
