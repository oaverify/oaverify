# Changelog

## [5.0.0](https://github.com/oaverify/oaverify/compare/core-v4.0.0...core-v5.0.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **validator:** dialect overrides the version the document declares ([#538](https://github.com/oaverify/oaverify/issues/538))
* **cli:** a usage error (unknown command, unknown option, missing argument) exits 3 rather than Commander's 1.
* **cli:** `CheckFinding.class` gains `"malformed"`, and a malformed schema is now reported under it instead of `"schema"`. A consumer switching on `class` in `check --format json` output sees a value it did not before.
* **schema:** run the well-formedness guard on $ref targets ([#522](https://github.com/oaverify/oaverify/issues/522))
* **spec:** overlay extend verbs take a Partial of the component ([#509](https://github.com/oaverify/oaverify/issues/509))
* **validator:** apply $ref siblings at request and response body roots ([#508](https://github.com/oaverify/oaverify/issues/508))
* **cli:** add a check verb for spec validity ([#502](https://github.com/oaverify/oaverify/issues/502))
* **schema:** withhold required-not-in-properties pending its rewrite ([#501](https://github.com/oaverify/oaverify/issues/501))
* remove the v4-overdue deprecated aliases ([#497](https://github.com/oaverify/oaverify/issues/497))
* rename strict to schemaLint ([#495](https://github.com/oaverify/oaverify/issues/495))

### Features

* **cli:** add --version ([#526](https://github.com/oaverify/oaverify/issues/526)) ([8df026a](https://github.com/oaverify/oaverify/commit/8df026a4689d840bb360df53739ef84fa5c3a508))
* **cli:** add a check verb for spec validity ([#502](https://github.com/oaverify/oaverify/issues/502)) ([09481f1](https://github.com/oaverify/oaverify/commit/09481f1f7798a45c3f027453d8fadb33a4fbecfd)), closes [#476](https://github.com/oaverify/oaverify/issues/476)
* **cli:** report malformed schemas under their own finding class ([#529](https://github.com/oaverify/oaverify/issues/529)) ([0ad1b7a](https://github.com/oaverify/oaverify/commit/0ad1b7a52e747b968f2455c1d24cec5a9f1e8c7e))
* **schema:** add validateKeywordValue to KeywordDefinition ([#498](https://github.com/oaverify/oaverify/issues/498)) ([fc9ff17](https://github.com/oaverify/oaverify/commit/fc9ff1787d65fea5161ab1ec1ebbf4b8f5bbaffc))
* **validator:** carry operation context into compile-time schema output ([#507](https://github.com/oaverify/oaverify/issues/507)) ([e132131](https://github.com/oaverify/oaverify/commit/e132131658cd1b14168e048c422e2ae13eea2f91))


### Bug Fixes

* **cli:** exit 3 on a usage error, and split check's exit 2 ([#533](https://github.com/oaverify/oaverify/issues/533)) ([f64c9a9](https://github.com/oaverify/oaverify/commit/f64c9a9309d90f76e357cf0ecb823345c32a951d))
* **cli:** flush stdout before exiting ([#524](https://github.com/oaverify/oaverify/issues/524)) ([425224c](https://github.com/oaverify/oaverify/commit/425224c14b5473f57f1d8ac8ea01341c383186ad))
* **cli:** report every finding when a schema is malformed ([#525](https://github.com/oaverify/oaverify/issues/525)) ([a6a818f](https://github.com/oaverify/oaverify/commit/a6a818fec1a387db3b25df045d58d11ba60a5fe1))
* remove polynomial backtracking from the router and uri format ([#487](https://github.com/oaverify/oaverify/issues/487)) ([3bb065e](https://github.com/oaverify/oaverify/commit/3bb065e37686c4667a913cd8006f257734a40504))
* **schema:** a ref the lint walk cannot follow no longer fails the compile ([#537](https://github.com/oaverify/oaverify/issues/537)) ([d4bbfc9](https://github.com/oaverify/oaverify/commit/d4bbfc922f0a8f1bd061f2eccb858249fcd23d07))
* **schema:** follow $ref in the schema lint walk ([#523](https://github.com/oaverify/oaverify/issues/523)) ([9333521](https://github.com/oaverify/oaverify/commit/9333521557537c3004a47cc6cb0ff1fc17155528))
* **schema:** make required-not-in-properties ancestor-aware ([#503](https://github.com/oaverify/oaverify/issues/503)) ([4e5dce1](https://github.com/oaverify/oaverify/commit/4e5dce1b3de642ca5309ad9cbe7addc7304deb67))
* **schema:** make the required-lint walk linear in the $ref graph ([#521](https://github.com/oaverify/oaverify/issues/521)) ([bf1b81e](https://github.com/oaverify/oaverify/commit/bf1b81e1bdeb938063e2871b27bb7348547eabfe))
* **schema:** reject illegal type names and non-array required ([#494](https://github.com/oaverify/oaverify/issues/494)) ([2411096](https://github.com/oaverify/oaverify/commit/24110960182969f756354fd228fbfaa24fda5b39)), closes [#474](https://github.com/oaverify/oaverify/issues/474) [#490](https://github.com/oaverify/oaverify/issues/490)
* **schema:** reject non-schema values in schema-valued slots ([#492](https://github.com/oaverify/oaverify/issues/492)) ([17d367b](https://github.com/oaverify/oaverify/commit/17d367b938e92dbe3766c8b57708d21d0163e78d)), closes [#473](https://github.com/oaverify/oaverify/issues/473)
* **schema:** run the well-formedness guard on $ref targets ([#522](https://github.com/oaverify/oaverify/issues/522)) ([8bbb043](https://github.com/oaverify/oaverify/commit/8bbb0439af98a91002a42ec0f8dd2a41c55ae3db))
* **schema:** withhold required-not-in-properties pending its rewrite ([#501](https://github.com/oaverify/oaverify/issues/501)) ([c0dee06](https://github.com/oaverify/oaverify/commit/c0dee0694a6f4850d39f0a1099b64f78e3fa78fd))
* **spec:** overlay extend verbs take a Partial of the component ([#509](https://github.com/oaverify/oaverify/issues/509)) ([789377d](https://github.com/oaverify/oaverify/commit/789377dd86286c264e2e7ab7c7cf9dcc954cc9a1))
* **validator:** apply $ref siblings at request and response body roots ([#508](https://github.com/oaverify/oaverify/issues/508)) ([61edd74](https://github.com/oaverify/oaverify/commit/61edd74a9fccb679a4672222c8d743c1cc257589))
* **validator:** dialect overrides the version the document declares ([#538](https://github.com/oaverify/oaverify/issues/538)) ([7345a3d](https://github.com/oaverify/oaverify/commit/7345a3d6f3c76a57052087afc0335e393eff1c05))
* **validator:** guard each schema in precompile collect mode ([#527](https://github.com/oaverify/oaverify/issues/527)) ([e7c7035](https://github.com/oaverify/oaverify/commit/e7c703545b61dfd2027bc68e0df8a92572da0db5))


### Documentation

* add the v4 to v5 migration guide ([#530](https://github.com/oaverify/oaverify/issues/530)) ([309c85c](https://github.com/oaverify/oaverify/commit/309c85ce2384eabca017f71e99da5633fcea8dc9))
* correct the malformed-schema story and the stale strict links ([#528](https://github.com/oaverify/oaverify/issues/528)) ([c35bc05](https://github.com/oaverify/oaverify/commit/c35bc053320fbb48e63843037e9fc17070efa4e8))
* refresh release docs and tsdoc ([#535](https://github.com/oaverify/oaverify/issues/535)) ([3958943](https://github.com/oaverify/oaverify/commit/39589432cef11d2b079b8b889dba1a00636d1852))
* **schema:** write down the ref-addressing rule ([#532](https://github.com/oaverify/oaverify/issues/532)) ([8b06295](https://github.com/oaverify/oaverify/commit/8b06295a2b8cb0efc7c92a40d4107e352084f451))


### Refactoring

* remove the v4-overdue deprecated aliases ([#497](https://github.com/oaverify/oaverify/issues/497)) ([0b44793](https://github.com/oaverify/oaverify/commit/0b44793d8bb0ee06ac62b87fcd29cc025fe78d17))
* rename strict to schemaLint ([#495](https://github.com/oaverify/oaverify/issues/495)) ([ea17a41](https://github.com/oaverify/oaverify/commit/ea17a41dd05362dc1adb7978ce7b8b7963943405))

## [4.0.0](https://github.com/oaverify/oaverify/compare/core-v3.8.0...core-v4.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* `@aahoughton/oav-core` is now **`@oaverify/core`**.
* **The CLI package no longer exports the library.** `oaverify` (formerly
  `@aahoughton/oav`) now ships only the `oaverify` binary. Import the library
  from `@oaverify/core` (or `@oaverify/core/schema`, `/spec`, `/formats`,
  `/overlay-spec`), and take `@oaverify/yaml` for `createYamlFileReader`,
  `createSmartHttpReader`, `parseYamlString`, and `loadSpecSync`. Validators
  emitted by `compile-spec` / `compile-schema` now import `@oaverify/core`
  by default.
* **`customKeywordVocabulary` changed value**, from
  `https://oav.dev/vocab/custom-keywords` to
  `https://github.com/oaverify/oaverify/vocab/custom-keywords`. Importing the
  constant is unaffected; only code that hardcoded the literal string needs
  updating.
* **Renamed from the `@aahoughton` scope.** npm `oav` belongs to
  Microsoft's Azure/oav, the same problem domain, so the old name was
  search-contaminated regardless of scope. The `@aahoughton/*` packages are
  deprecated and will receive no further releases; they keep working at
  3.8.0 / 1.1.0 indefinitely.

### Documentation

* surface streaming and performance across the docs ([#461](https://github.com/oaverify/oaverify/issues/461)) ([91b7c6f](https://github.com/oaverify/oaverify/commit/91b7c6f4a3294e7da13963c0cbabab8f710a8fb4))


### Chore

* split the packages and rename to oaverify ([#480](https://github.com/oaverify/oaverify/issues/480)) ([a5ddcac](https://github.com/oaverify/oaverify/commit/a5ddcac565d64f3ddfc928bc0a62549ccd1f9f12))

## [3.8.0](https://github.com/aahoughton/oav/compare/oav-core-v3.7.0...oav-core-v3.8.0) (2026-07-06)


### Features

* **schema:** return at the maxErrors cap in flat mode (fast-fail) ([#451](https://github.com/aahoughton/oav/issues/451)) ([8908404](https://github.com/aahoughton/oav/commit/8908404dd22b2ca66557be211384047297db1119))


### Bug Fixes

* **cli:** accept OpenAPI Overlay 1.0 files and reject unknown overlay shapes ([#460](https://github.com/aahoughton/oav/issues/460)) ([deb2cf1](https://github.com/aahoughton/oav/commit/deb2cf16ccd4b7cb9741dfd18594633ec6143486)), closes [#448](https://github.com/aahoughton/oav/issues/448)


### Performance

* **router:** defer match() allocations until structurally needed ([#457](https://github.com/aahoughton/oav/issues/457)) ([100ca57](https://github.com/aahoughton/oav/commit/100ca571ebb9ad2520ad508d4871fb13aa4fab84))
* **schema:** hoist format-assertion lookups to module scope ([#458](https://github.com/aahoughton/oav/issues/458)) ([78bac7c](https://github.com/aahoughton/oav/commit/78bac7cc3c6b9ce9dd5633bad2b80e44e9ef2c45))
* **validator:** cache media type matching ([#452](https://github.com/aahoughton/oav/issues/452)) ([9ae079e](https://github.com/aahoughton/oav/commit/9ae079e4bf13b7ef07149308fb2969bbeb96e9d9))


### Documentation

* reframe README around streaming validation and buffer budgets ([#449](https://github.com/aahoughton/oav/issues/449)) ([f2eded7](https://github.com/aahoughton/oav/commit/f2eded7fcb51e61173e465239fc67d21eb004614))

## [3.7.0](https://github.com/aahoughton/oav/compare/oav-core-v3.6.0...oav-core-v3.7.0) (2026-06-25)


### Features

* **stream-validator:** member-level key edit (rename/drop) on the stream path ([#441](https://github.com/aahoughton/oav/issues/441)) ([6b76f08](https://github.com/aahoughton/oav/commit/6b76f08f64e1b31b97b3fd283ccedfaf2bfcc11d))
* **stream-validator:** report peak buffered bytes on the verdict ([#443](https://github.com/aahoughton/oav/issues/443)) ([dd42050](https://github.com/aahoughton/oav/commit/dd42050c10ae38f7a0aed116a8f629e75b6ff9d8))

## [3.6.0](https://github.com/aahoughton/oav/compare/oav-core-v3.5.0...oav-core-v3.6.0) (2026-06-24)


### Features

* **stream-validator:** streamability analyzer + oav stream-check ([#435](https://github.com/aahoughton/oav/issues/435)) ([e2de16b](https://github.com/aahoughton/oav/commit/e2de16b70d36d49119ba1258b5275353c62cd0d7))


### Bug Fixes

* **stream-validator:** resolve and normalize 3.0 $ref request bodies ([#433](https://github.com/aahoughton/oav/issues/433)) ([c948bec](https://github.com/aahoughton/oav/commit/c948bec07608e0dfcec411dc7f1f3f35e337d737))


### Refactoring

* **stream-validator:** exclusive BodyBudget union and readonly cleanups ([#436](https://github.com/aahoughton/oav/issues/436)) ([7640de6](https://github.com/aahoughton/oav/commit/7640de6796f4af38d5b5aad28ce36445b4b98d55))


### Chore

* **stream-validator:** release the streaming validator as 1.0.0 ([d98ed3d](https://github.com/aahoughton/oav/commit/d98ed3da6f4932b92d9bcf9800e6ddd8a008d892))

## [3.5.0](https://github.com/aahoughton/oav/compare/oav-core-v3.4.0...oav-core-v3.5.0) (2026-06-21)


### Features

* **stream-validator:** public-surface ergonomics ([#423](https://github.com/aahoughton/oav/issues/423)) ([#428](https://github.com/aahoughton/oav/issues/428)) ([6ddb759](https://github.com/aahoughton/oav/commit/6ddb759283b207fd90e8ef316719635a67ef33e8))


### Documentation

* **examples:** add streaming examples and refresh existing ones ([#421](https://github.com/aahoughton/oav/issues/421)) ([9318aa4](https://github.com/aahoughton/oav/commit/9318aa474dd40f32f80be306989a6abe05c6ec94))
* lead with the common case on the front-door READMEs and tune npm metadata ([#429](https://github.com/aahoughton/oav/issues/429)) ([80d2384](https://github.com/aahoughton/oav/commit/80d23847a17fbd7ff9b5576a4c7c0cc1cb3e788f))

## [3.4.0](https://github.com/aahoughton/oav/compare/oav-core-v3.3.0...oav-core-v3.4.0) (2026-06-20)


### Features

* **schema:** public keyword-introspection surface ([505ff89](https://github.com/aahoughton/oav/commit/505ff89ea9bae0b511bc5b34ffeac8c4a897a870)), closes [#405](https://github.com/aahoughton/oav/issues/405)
* **schema:** public keyword-introspection surface (registry + public schemaUsesUnevaluated) ([#406](https://github.com/aahoughton/oav/issues/406)) ([505ff89](https://github.com/aahoughton/oav/commit/505ff89ea9bae0b511bc5b34ffeac8c4a897a870))
* **stream-validator:** make maxUniqueItems actually bound the buffered uniqueItems island ([#415](https://github.com/aahoughton/oav/issues/415)) ([aba2171](https://github.com/aahoughton/oav/commit/aba217188fef40f6bc8dab1148b675588907dfda))
* **stream-validator:** make maxUniqueItems bound the buffered uniqueItems island ([aba2171](https://github.com/aahoughton/oav/commit/aba217188fef40f6bc8dab1148b675588907dfda))
* **stream-validator:** publish as @aahoughton/oav-stream-validator (experimental) ([#419](https://github.com/aahoughton/oav/issues/419)) ([c459c11](https://github.com/aahoughton/oav/commit/c459c1122608f2462a6348cc7fca13b1a176e646))
* **stream-validator:** streaming JSON Schema 2020-12 validator ([#408](https://github.com/aahoughton/oav/issues/408)) ([b9d488e](https://github.com/aahoughton/oav/commit/b9d488ebaa38ff7ab533e7a1cc22f30ab2dbd61e))
* **stream-validator:** surface scalar value spans on a value channel ([#412](https://github.com/aahoughton/oav/issues/412)) ([b8d5dd7](https://github.com/aahoughton/oav/commit/b8d5dd7d76b2bdb6e91ed16544f5557bab2d57dc)), closes [#411](https://github.com/aahoughton/oav/issues/411)


### Bug Fixes

* **stream-validator:** eager over-limits + value-event full path (first-consumer fixes) ([#414](https://github.com/aahoughton/oav/issues/414)) ([ba7a0f6](https://github.com/aahoughton/oav/commit/ba7a0f604c4787d283853fcf6dc59352aae83c46))
* **stream-validator:** memoize $ref resolution on the spine hot path ([#410](https://github.com/aahoughton/oav/issues/410)) ([89d0b49](https://github.com/aahoughton/oav/commit/89d0b499a74d4851a4684898ed27cc1ee50e79ea))


### Documentation

* **oav:** correct the root package's batteries-included loader note ([#416](https://github.com/aahoughton/oav/issues/416)) ([e0767fa](https://github.com/aahoughton/oav/commit/e0767fa291806fd2ea9ae2e0980af278a99e7562))
* scrub internal references and clean up docs/comments ([#413](https://github.com/aahoughton/oav/issues/413)) ([b21b357](https://github.com/aahoughton/oav/commit/b21b35702155651bb2e6d9a81a7ee7b27cc78bc7))


### Refactoring

* **stream-validator:** tighten public surface before publish ([#418](https://github.com/aahoughton/oav/issues/418)) ([3edb2c9](https://github.com/aahoughton/oav/commit/3edb2c9d262c55f41cbd41bdd66702220b943c1e))

## [3.3.0](https://github.com/aahoughton/oav/compare/oav-core-v3.2.0...oav-core-v3.3.0) (2026-06-16)


### Features

* **core:** formatSummary path option for self-locating leaves ([#381](https://github.com/aahoughton/oav/issues/381)) ([4f4e31c](https://github.com/aahoughton/oav/commit/4f4e31c3a84b1945ed33ee7a12d2602bf4ce2675)), closes [#380](https://github.com/aahoughton/oav/issues/380)
* **validator:** opt-in requireResponseBody finding for absent declared response bodies ([#386](https://github.com/aahoughton/oav/issues/386)) ([475e87a](https://github.com/aahoughton/oav/commit/475e87a51647faa8b5ac1bbe6d32a004bdbc4d5f)), closes [#371](https://github.com/aahoughton/oav/issues/371)


### Bug Fixes

* **core, cli:** rename the flat output format to summary, keep flat as a deprecated alias ([#384](https://github.com/aahoughton/oav/issues/384)) ([db42e48](https://github.com/aahoughton/oav/commit/db42e48c2dc995272886964730b628bb68facde1)), closes [#374](https://github.com/aahoughton/oav/issues/374)
* **performance:** make the benchmarks type-clean and restore collect-all ([#402](https://github.com/aahoughton/oav/issues/402)) ([3487df8](https://github.com/aahoughton/oav/commit/3487df8a3599510dda4945066ddda9c1899997da))


### Documentation

* **performance:** record the flat-vs-tree-mem baseline ([#403](https://github.com/aahoughton/oav/issues/403)) ([31f2db2](https://github.com/aahoughton/oav/commit/31f2db270c5913f072284d2b1ab8ff67dcfe4558))
* scope the 3.2 support claim to Schema Object + QUERY ([#400](https://github.com/aahoughton/oav/issues/400)) ([dca52f1](https://github.com/aahoughton/oav/commit/dca52f10e1777b459b23b93571a474a2d5854875))
* validateResponses bypass coverage + Fetch extractor shape notes ([#383](https://github.com/aahoughton/oav/issues/383)) ([9aecc1e](https://github.com/aahoughton/oav/commit/9aecc1eab594cd01991d297210aa8fe21e941420)), closes [#375](https://github.com/aahoughton/oav/issues/375)


### Refactoring

* **core, validator:** align param names in the error-helper layer ([#385](https://github.com/aahoughton/oav/issues/385)) ([5cae3f2](https://github.com/aahoughton/oav/commit/5cae3f256905e2130e0ce653e77670690bdbb8ab))

## [3.2.0](https://github.com/aahoughton/oav/compare/oav-core-v3.1.0...oav-core-v3.2.0) (2026-06-11)


### Features

* **adapters:** validateResponses for response validation ([#357](https://github.com/aahoughton/oav/issues/357)) ([#370](https://github.com/aahoughton/oav/issues/370)) ([554d810](https://github.com/aahoughton/oav/commit/554d8109d3c7c9dc8611285bfc10b76c0e339aa0))
* **validator:** combineValidators for multi-spec validation ([#369](https://github.com/aahoughton/oav/issues/369)) ([564aed0](https://github.com/aahoughton/oav/commit/564aed05156f3f09613389989e43d88b7459154a))
* **validator:** routes accessor for spec introspection ([#368](https://github.com/aahoughton/oav/issues/368)) ([477a5bf](https://github.com/aahoughton/oav/commit/477a5bfeefe4dacf78a8748a72a217d917fdc62b))


### Bug Fixes

* **core:** accept flat lists in formatSummary/countErrors/toJsonObject; fix stale docs ([#373](https://github.com/aahoughton/oav/issues/373)) ([04b86af](https://github.com/aahoughton/oav/commit/04b86afaec82359ffe0bb5e870f6c6a8f1e7e4ef))
* preserve 405 and implicit-HEAD overlap in combineValidators; split-phase response validation ([#378](https://github.com/aahoughton/oav/issues/378)) ([abcacde](https://github.com/aahoughton/oav/commit/abcacdedd063e940e6b9a3088093aa136561b0ce))


### Documentation

* **core:** document formatError's tree-only contract and the flat-list recipe ([#377](https://github.com/aahoughton/oav/issues/377)) ([8fb86f5](https://github.com/aahoughton/oav/commit/8fb86f5242589dcc7d8ad016fab65c603ef27594))

## [3.1.0](https://github.com/aahoughton/oav/compare/oav-core-v3.0.0...oav-core-v3.1.0) (2026-06-09)


### Features

* synchronous spec loader (loadSpecSync) ([#362](https://github.com/aahoughton/oav/issues/362)) ([efbf842](https://github.com/aahoughton/oav/commit/efbf842a99d9405066ed4f3fc451ec3b9eb6ea9c))


### Performance

* publishable benchmark harness + host-stamped c7i.large numbers ([#364](https://github.com/aahoughton/oav/issues/364)) ([3a58999](https://github.com/aahoughton/oav/commit/3a5899981ccaaf4716413aa0e60dcca55f8c2d27))
* **schema:** emit direct property checks for small required arrays ([#358](https://github.com/aahoughton/oav/issues/358)) ([fa4b111](https://github.com/aahoughton/oav/commit/fa4b111015afc613832893eaafbb83abee32eb04))


### Documentation

* correct stale README claims against code ([#361](https://github.com/aahoughton/oav/issues/361)) ([bdd2654](https://github.com/aahoughton/oav/commit/bdd265431797255aa118ab3e9ddb33a4c50c0b56))

## [3.0.0](https://github.com/aahoughton/oav/compare/oav-core-v2.4.0...oav-core-v3.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* **cli:** `oav compile-spec` output now returns the v3 result object ({ valid, ... }) instead of `ValidationError | null`, and defaults to flat + maxErrors:1. Consumers reading the old null/tree shape should read `result.valid` / `result.errors` (or pass `--output-mode tree` for the nested `error`).
* compileSchema and createValidator default to flat error output and maxErrors:1. validateRequest/validateResponse return a result object ({ valid, errors?, error?, truncated }) instead of ValidationError|null. Adapter onError receives a ValidationError[] leaf list. ValidationResult and CompiledSchema now name the flat shapes (tree is TreeValidationResult/CompiledTreeSchema). undefined-valued object properties count as absent. formatJson/summarize/formatFlat and the validateSecurity boolean form are removed. See docs/migration-v3.md.

### Features

* **cli:** compile-spec result-shape parity with createValidator ([#355](https://github.com/aahoughton/oav/issues/355)) ([5081b4a](https://github.com/aahoughton/oav/commit/5081b4a2a6bfb3ed313f655fc568403dde7be163))
* **schema:** flat error-collection mode ([#337](https://github.com/aahoughton/oav/issues/337)) ([7c4852e](https://github.com/aahoughton/oav/commit/7c4852e23e8c83880231bb83d0c9985e7a070a59))
* v3 - flat error output and maxErrors:1 as zero-config defaults ([#344](https://github.com/aahoughton/oav/issues/344)) ([4d4c52e](https://github.com/aahoughton/oav/commit/4d4c52e521b5e171b9834eafca80e6ae7508ea67))


### Performance

* **schema:** cheaper property presence via !== undefined ([#343](https://github.com/aahoughton/oav/issues/343)) ([32010b3](https://github.com/aahoughton/oav/commit/32010b3216137d964412cdec280cfefc77e302a7))
* **schema:** two-phase composition (predicate decision + lazy errors) ([#342](https://github.com/aahoughton/oav/issues/342)) ([6a832d4](https://github.com/aahoughton/oav/commit/6a832d41e55d54d411c5b8c433783bf0a783ebdb))


### Documentation

* drop "matching Ajv" framing from the defaults ([#356](https://github.com/aahoughton/oav/issues/356)) ([1d287b6](https://github.com/aahoughton/oav/commit/1d287b64ff409f06436d83ffa375124c0ee5902d))
* post-v3 cleanup of stale deprecation notes ([#347](https://github.com/aahoughton/oav/issues/347)) ([f0922f4](https://github.com/aahoughton/oav/commit/f0922f4eb64eba1ccf996beeb52d8dee16b060c5))
* sweep stale v2 result-shape and pre-maxDepth language ([#354](https://github.com/aahoughton/oav/issues/354)) ([0bc3c2b](https://github.com/aahoughton/oav/commit/0bc3c2b98eb4ceefc55310d1f78ba5cd9d4cdd97))


### Refactoring

* **schema:** derive compiled artifact variants from CompiledSchema ([#348](https://github.com/aahoughton/oav/issues/348)) ([e66af95](https://github.com/aahoughton/oav/commit/e66af95fec5ff2ac20069e5622b62b33288dc377))

## [2.4.0](https://github.com/aahoughton/oav/compare/oav-core-v2.3.0...oav-core-v2.4.0) (2026-06-06)


### Features

* **schema:** add maxDepth to bound recursion through $ref cycles ([#333](https://github.com/aahoughton/oav/issues/333)) ([cd05fa1](https://github.com/aahoughton/oav/commit/cd05fa1938db3714d3c19026a90b3971a88aeb80))


### Bug Fixes

* **schema:** make deepEqual iterative to stop stack overflow on deep data ([#332](https://github.com/aahoughton/oav/issues/332)) ([5aaa4dd](https://github.com/aahoughton/oav/commit/5aaa4ddce3f8bfdde1e9e29e8f4d99b513539cbf))


### Documentation

* **adapters:** add Hardening section to adapter READMEs ([#334](https://github.com/aahoughton/oav/issues/334)) ([73bdcb2](https://github.com/aahoughton/oav/commit/73bdcb28180f9ae64ccd8e5ea9f44b2efa673497))

## [2.3.0](https://github.com/aahoughton/oav/compare/oav-core-v2.2.1...oav-core-v2.3.0) (2026-06-06)


### Features

* **oav:** make esbuild an optional peer dependency ([#313](https://github.com/aahoughton/oav/issues/313)) ([daad9dd](https://github.com/aahoughton/oav/commit/daad9dd8b5848f6df5e5f1917b613c78208527f0))


### Bug Fixes

* correctness fixes from review (path decode, spaceDelimited, emit dedup) ([#326](https://github.com/aahoughton/oav/issues/326)) ([47ec36b](https://github.com/aahoughton/oav/commit/47ec36b6e35c3cea807b86cb199f56b3c6c92017))
* **release:** prefix tarball path with ./ for npm publish ([#308](https://github.com/aahoughton/oav/issues/308)) ([ddd0524](https://github.com/aahoughton/oav/commit/ddd052479e6c0d2147abbda135d33285d9cb94ac))


### Performance

* **core:** share frozen empty params default across errors ([#317](https://github.com/aahoughton/oav/issues/317)) ([bad7cfb](https://github.com/aahoughton/oav/commit/bad7cfb3e866eef3f0da334e7100556000e4c9f0))
* large-response benchmarks (stress + error-tree anatomy) ([#318](https://github.com/aahoughton/oav/issues/318)) ([4bbc1e7](https://github.com/aahoughton/oav/commit/4bbc1e7666763c78cac04f85794c79ee41da5ad0))
* **schema:** bind property value to a local before validating it ([#324](https://github.com/aahoughton/oav/issues/324)) ([cb167f3](https://github.com/aahoughton/oav/commit/cb167f3753ed20706df6076cb56ec2be7b8849a1))
* **schema:** bound minLength/maxLength by string length before walking code points ([#322](https://github.com/aahoughton/oav/issues/322)) ([35a32f2](https://github.com/aahoughton/oav/commit/35a32f243318de3b32c20e7d634bb7cbd6728188))
* **schema:** low-risk codegen cleanups ([7a2863c](https://github.com/aahoughton/oav/commit/7a2863c35b225b903f45cdc2003c529c8a771fc9))
* **schema:** low-risk codegen cleanups (redundant isFinite, length hoist, unused eval params) ([#323](https://github.com/aahoughton/oav/issues/323)) ([7a2863c](https://github.com/aahoughton/oav/commit/7a2863c35b225b903f45cdc2003c529c8a771fc9))
* **schema:** object hot-path codegen (single-pass required + shared guard) ([#316](https://github.com/aahoughton/oav/issues/316)) ([6dc008f](https://github.com/aahoughton/oav/commit/6dc008f876bf9b6b39ad2a10edf2ac95da99c53e))


### Documentation

* harden recursion-depth guidance and slim CLAUDE.md ([#331](https://github.com/aahoughton/oav/issues/331)) ([8c91e50](https://github.com/aahoughton/oav/commit/8c91e5012c1e03726e6f0a161f33d4c3c008795e))
* refresh benchmark and comparison perf claims after perf work ([#325](https://github.com/aahoughton/oav/issues/325)) ([6e70129](https://github.com/aahoughton/oav/commit/6e7012952dc02336b2c928945b254945460ff96d))

## [2.2.1](https://github.com/aahoughton/oav/compare/oav-core-v2.2.0...oav-core-v2.2.1) (2026-06-05)


### Documentation

* **core:** toProblemDetails echoes request values + schema metadata ([#304](https://github.com/aahoughton/oav/issues/304)) ([1f566fc](https://github.com/aahoughton/oav/commit/1f566fc045823b1099722963bb7f8197bfabd63b))

## [2.2.0](https://github.com/aahoughton/oav/compare/oav-core-v2.1.0...oav-core-v2.2.0) (2026-05-19)


### Features

* **overlay-spec:** translator for OpenAPI Overlay 1.0 spec format ([#290](https://github.com/aahoughton/oav/issues/290)) ([e8ae711](https://github.com/aahoughton/oav/commit/e8ae71100586922f55040db59537866d3e2d8938))
* **schema:** regexCompiler option for pattern and format: regex ([#289](https://github.com/aahoughton/oav/issues/289)) ([a9418c2](https://github.com/aahoughton/oav/commit/a9418c28db2c508a39a88b33a406fd0c8091b685))
* **spec:** expand SpecOverlay typed verbs to cover OpenAPI Overlay axes ([#284](https://github.com/aahoughton/oav/issues/284)) ([2e0423b](https://github.com/aahoughton/oav/commit/2e0423b4868a5f02b29ccfd31cd4fb74d438c287))

## [2.1.0](https://github.com/aahoughton/oav/compare/oav-core-v2.0.0...oav-core-v2.1.0) (2026-05-04)


### Features

* **validator:** enum-valued validateSecurity with strict mode ([#262](https://github.com/aahoughton/oav/issues/262)) ([df1bb4d](https://github.com/aahoughton/oav/commit/df1bb4d20a2662d927a0758a772f1c546ebec6c8))


### Bug Fixes

* **schema:** close codegen-injection vectors in keyword compilation ([#253](https://github.com/aahoughton/oav/issues/253)) ([b456f08](https://github.com/aahoughton/oav/commit/b456f0834d0544d61248eab564e7a21189d2c39a))
* **validator:** check required response headers when res.headers is absent ([1561395](https://github.com/aahoughton/oav/commit/1561395bebd646528e683357f34c6ecd2830a782))
* **validator:** required response headers when res.headers is absent ([#261](https://github.com/aahoughton/oav/issues/261)) ([1561395](https://github.com/aahoughton/oav/commit/1561395bebd646528e683357f34c6ecd2830a782))


### Performance

* **schema:** low-risk codegen wins (regex hoist, primitive equality, oneOf cleanup, required predicate) ([#265](https://github.com/aahoughton/oav/issues/265)) ([a9bc49d](https://github.com/aahoughton/oav/commit/a9bc49d9298ef6609990f6f0fd4ade51eebfaadc))


### Documentation

* cleanup pass, spelling normalization, TSDoc tightening ([#260](https://github.com/aahoughton/oav/issues/260)) ([77fcf4d](https://github.com/aahoughton/oav/commit/77fcf4ddafe8e6a30b8108fc0dee78a31a8e1a6b))

## [2.0.0](https://github.com/aahoughton/oav/compare/oav-core-v1.1.2...oav-core-v2.0.0) (2026-05-02)


### ⚠ BREAKING CHANGES

* **core:** formatSummary separator + includeCode ([#241](https://github.com/aahoughton/oav/issues/241))

### Features

* **core:** formatSummary separator + includeCode ([#241](https://github.com/aahoughton/oav/issues/241)) ([4cf7148](https://github.com/aahoughton/oav/commit/4cf7148d84f0c42e37359335c3ea297a8e74a9f9))
* **schema:** silent-rewrite/* lint family with three checks ([#245](https://github.com/aahoughton/oav/issues/245)) ([1dda495](https://github.com/aahoughton/oav/commit/1dda495d998b8add5db57aadddbfa537ab95f3cd))
* **spec:** spec-hygiene lint (resolveSpec / createValidator / oav resolve --lint) ([#243](https://github.com/aahoughton/oav/issues/243)) ([af3b1da](https://github.com/aahoughton/oav/commit/af3b1da327197ea353aaa4ac9a39029cb890de37))
* **spec:** spec-hygiene lint with four checks; surfaces from resolveSpec, loadSpec, createValidator, oav resolve ([af3b1da](https://github.com/aahoughton/oav/commit/af3b1da327197ea353aaa4ac9a39029cb890de37))


### Documentation

* move root markdown into docs/ subdir ([#237](https://github.com/aahoughton/oav/issues/237)) ([365af48](https://github.com/aahoughton/oav/commit/365af48ab7394bf18ddc498419f15be67079ba3a))
* trim README; extract reference content into docs/ ([#239](https://github.com/aahoughton/oav/issues/239)) ([db25a46](https://github.com/aahoughton/oav/commit/db25a46c4c3e6ca04a5a531cd48396561022b0b5))

## [1.1.2](https://github.com/aahoughton/oav/compare/oav-core-v1.1.1...oav-core-v1.1.2) (2026-04-27)


### Bug Fixes

* **docs:** cross-link gaps, custom-envelope worked example, parseYamlString cast hint ([#230](https://github.com/aahoughton/oav/issues/230)) ([b65c75d](https://github.com/aahoughton/oav/commit/b65c75dc54ca2afc128858587d2ab7ffec0d3f57)), closes [#229](https://github.com/aahoughton/oav/issues/229)

## [1.1.1](https://github.com/aahoughton/oav/compare/oav-core-v1.1.0...oav-core-v1.1.1) (2026-04-27)


### Bug Fixes

* drop preinstall script; too belt+suspender-y ([#228](https://github.com/aahoughton/oav/issues/228)) ([2ca850d](https://github.com/aahoughton/oav/commit/2ca850d9ba77cd696423b407a80445c758adf379)), closes [#227](https://github.com/aahoughton/oav/issues/227)
* **release:** revert OIDC; pnpm publish doesn't do trusted-publisher exchange ([#223](https://github.com/aahoughton/oav/issues/223)) ([2fc681e](https://github.com/aahoughton/oav/commit/2fc681ed9d0dcc824bc11cf856bc0494532ff54c))
* **release:** revert to NPM_TOKEN auth; pnpm doesn't yet do OIDC exchange ([2fc681e](https://github.com/aahoughton/oav/commit/2fc681ed9d0dcc824bc11cf856bc0494532ff54c))
* **release:** unblock OIDC trusted publishing; add dispatch recovery handle ([#221](https://github.com/aahoughton/oav/issues/221)) ([a3ae3e5](https://github.com/aahoughton/oav/commit/a3ae3e57619ce77e915f5ff47a55d1c443920d5e))


### Documentation

* rework readme to surface goals ([#226](https://github.com/aahoughton/oav/issues/226)) ([babe3e5](https://github.com/aahoughton/oav/commit/babe3e5c199bda9ebc0b59af311b2cac93d2ae7e)), closes [#225](https://github.com/aahoughton/oav/issues/225)

## [1.1.0](https://github.com/aahoughton/oav/compare/oav-core-v1.0.0...oav-core-v1.1.0) (2026-04-26)


### Features

* **core:** add formatSummary + toJsonObject; deprecate three misnamed exports ([#218](https://github.com/aahoughton/oav/issues/218)) ([23ce743](https://github.com/aahoughton/oav/commit/23ce743e1241b58998a385ecfb4ccb56a34daa3c))

## 1.0.0 (2026-04-25)

Initial release. `@aahoughton/oav-core` is the lean, zero-runtime-dependency
core: an HTTP-aware OpenAPI 3.0 / 3.1 / 3.2 request and response validator
built on a JSON Schema 2020-12 codegen compiler. JSON specs only. For YAML
readers and the `oav` CLI, install [`@aahoughton/oav`](https://www.npmjs.com/package/@aahoughton/oav)
instead.
