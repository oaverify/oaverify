# Changelog

## [3.8.1](https://github.com/aahoughton/oav/compare/oav-fastify-v3.8.0...oav-fastify-v3.8.1) (2026-07-08)


### Documentation

* surface streaming and performance across the docs ([#461](https://github.com/aahoughton/oav/issues/461)) ([91b7c6f](https://github.com/aahoughton/oav/commit/91b7c6f4a3294e7da13963c0cbabab8f710a8fb4))

## [3.8.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.7.0...oav-fastify-v3.8.0) (2026-07-06)


### Chore

* **oav-fastify:** Synchronize oav versions

## [3.7.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.6.0...oav-fastify-v3.7.0) (2026-06-25)


### Chore

* **oav-fastify:** Synchronize oav versions

## [3.6.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.5.0...oav-fastify-v3.6.0) (2026-06-24)


### Features

* **stream-validator:** streamability analyzer + oav stream-check ([#435](https://github.com/aahoughton/oav/issues/435)) ([e2de16b](https://github.com/aahoughton/oav/commit/e2de16b70d36d49119ba1258b5275353c62cd0d7))

## [3.5.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.4.0...oav-fastify-v3.5.0) (2026-06-21)


### Documentation

* lead with the common case on the front-door READMEs and tune npm metadata ([#429](https://github.com/aahoughton/oav/issues/429)) ([80d2384](https://github.com/aahoughton/oav/commit/80d23847a17fbd7ff9b5576a4c7c0cc1cb3e788f))

## [3.4.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.3.0...oav-fastify-v3.4.0) (2026-06-20)


### Chore

* **oav-fastify:** Synchronize oav versions

## [3.3.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.2.0...oav-fastify-v3.3.0) (2026-06-16)


### Features

* **validator:** opt-in requireResponseBody finding for absent declared response bodies ([#386](https://github.com/aahoughton/oav/issues/386)) ([475e87a](https://github.com/aahoughton/oav/commit/475e87a51647faa8b5ac1bbe6d32a004bdbc4d5f)), closes [#371](https://github.com/aahoughton/oav/issues/371)


### Documentation

* validateResponses bypass coverage + Fetch extractor shape notes ([#383](https://github.com/aahoughton/oav/issues/383)) ([9aecc1e](https://github.com/aahoughton/oav/commit/9aecc1eab594cd01991d297210aa8fe21e941420)), closes [#375](https://github.com/aahoughton/oav/issues/375)

## [3.2.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.1.0...oav-fastify-v3.2.0) (2026-06-11)


### Features

* **adapters:** validateResponses for response validation ([#357](https://github.com/aahoughton/oav/issues/357)) ([#370](https://github.com/aahoughton/oav/issues/370)) ([554d810](https://github.com/aahoughton/oav/commit/554d8109d3c7c9dc8611285bfc10b76c0e339aa0))


### Bug Fixes

* preserve 405 and implicit-HEAD overlap in combineValidators; split-phase response validation ([#378](https://github.com/aahoughton/oav/issues/378)) ([abcacde](https://github.com/aahoughton/oav/commit/abcacdedd063e940e6b9a3088093aa136561b0ce))

## [3.1.0](https://github.com/aahoughton/oav/compare/oav-fastify-v3.0.0...oav-fastify-v3.1.0) (2026-06-09)


### Documentation

* correct stale README claims against code ([#361](https://github.com/aahoughton/oav/issues/361)) ([bdd2654](https://github.com/aahoughton/oav/commit/bdd265431797255aa118ab3e9ddb33a4c50c0b56))

## [3.0.0](https://github.com/aahoughton/oav/compare/oav-fastify-v2.4.0...oav-fastify-v3.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* compileSchema and createValidator default to flat error output and maxErrors:1. validateRequest/validateResponse return a result object ({ valid, errors?, error?, truncated }) instead of ValidationError|null. Adapter onError receives a ValidationError[] leaf list. ValidationResult and CompiledSchema now name the flat shapes (tree is TreeValidationResult/CompiledTreeSchema). undefined-valued object properties count as absent. formatJson/summarize/formatFlat and the validateSecurity boolean form are removed. See docs/migration-v3.md.

### Features

* v3 - flat error output and maxErrors:1 as zero-config defaults ([#344](https://github.com/aahoughton/oav/issues/344)) ([4d4c52e](https://github.com/aahoughton/oav/commit/4d4c52e521b5e171b9834eafca80e6ae7508ea67))

## [2.4.0](https://github.com/aahoughton/oav/compare/oav-fastify-v2.3.0...oav-fastify-v2.4.0) (2026-06-06)


### Documentation

* **adapters:** add Hardening section to adapter READMEs ([#334](https://github.com/aahoughton/oav/issues/334)) ([73bdcb2](https://github.com/aahoughton/oav/commit/73bdcb28180f9ae64ccd8e5ea9f44b2efa673497))

## [2.3.0](https://github.com/aahoughton/oav/compare/oav-fastify-v2.2.1...oav-fastify-v2.3.0) (2026-06-06)


### Chore

* **oav-fastify:** Synchronize oav versions

## [2.2.1](https://github.com/aahoughton/oav/compare/oav-fastify-v2.2.0...oav-fastify-v2.2.1) (2026-06-05)


### Chore

* **oav-fastify:** Synchronize oav versions

## [2.2.0](https://github.com/aahoughton/oav/compare/oav-fastify-v2.1.0...oav-fastify-v2.2.0) (2026-05-19)


### Chore

* **oav-fastify:** Synchronize oav versions

## [2.1.0](https://github.com/aahoughton/oav/compare/oav-fastify-v2.0.0...oav-fastify-v2.1.0) (2026-05-04)


### Features

* **validator:** enum-valued validateSecurity with strict mode ([#262](https://github.com/aahoughton/oav/issues/262)) ([df1bb4d](https://github.com/aahoughton/oav/commit/df1bb4d20a2662d927a0758a772f1c546ebec6c8))


### Documentation

* cleanup pass, spelling normalization, TSDoc tightening ([#260](https://github.com/aahoughton/oav/issues/260)) ([77fcf4d](https://github.com/aahoughton/oav/commit/77fcf4ddafe8e6a30b8108fc0dee78a31a8e1a6b))

## [2.0.0](https://github.com/aahoughton/oav/compare/oav-fastify-v1.1.1...oav-fastify-v2.0.0) (2026-05-02)


### Documentation

* move root markdown into docs/ subdir ([#237](https://github.com/aahoughton/oav/issues/237)) ([365af48](https://github.com/aahoughton/oav/commit/365af48ab7394bf18ddc498419f15be67079ba3a))

## [1.1.1](https://github.com/aahoughton/oav/compare/oav-fastify-v1.1.0...oav-fastify-v1.1.1) (2026-04-27)


### Bug Fixes

* **docs:** cross-link gaps, custom-envelope worked example, parseYamlString cast hint ([#230](https://github.com/aahoughton/oav/issues/230)) ([b65c75d](https://github.com/aahoughton/oav/commit/b65c75dc54ca2afc128858587d2ab7ffec0d3f57)), closes [#229](https://github.com/aahoughton/oav/issues/229)

## [1.1.0](https://github.com/aahoughton/oav/compare/oav-fastify-v1.0.0...oav-fastify-v1.1.0) (2026-04-26)


### Features

* **core:** add formatSummary + toJsonObject; deprecate three misnamed exports ([#218](https://github.com/aahoughton/oav/issues/218)) ([23ce743](https://github.com/aahoughton/oav/commit/23ce743e1241b58998a385ecfb4ccb56a34daa3c))

## 1.0.0 (2026-04-25)

Initial release. Fastify adapter for
[`@aahoughton/oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core)
— a `preValidation` hook factory plus standalone helpers
(`httpRequestFromFastify`, `renderProblemDetails`) for callers composing
their own hooks.
