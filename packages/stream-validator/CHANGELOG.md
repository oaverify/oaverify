# Changelog

## [6.1.0](https://github.com/oaverify/oaverify/compare/stream-v6.0.0...stream-v6.1.0) (2026-08-08)


### Bug Fixes

* **schema:** bound the multipleOf tolerance and handle an overflowing quotient ([#713](https://github.com/oaverify/oaverify/issues/713)) ([d36e05e](https://github.com/oaverify/oaverify/commit/d36e05ee6b03074991989bef4f9e4a72b0d41c8c)), closes [#709](https://github.com/oaverify/oaverify/issues/709)

## [6.0.0](https://github.com/oaverify/oaverify/compare/stream-v5.4.0...stream-v6.0.0) (2026-08-07)

No source changes in this package. The version tracks the linked release group, and the entries below reach it through `StreamValidatorOptions.formats`, which merges over `builtInFormats`.

### ⚠ BREAKING CHANGES

* **formats:** `builtInFormats` values are `FormatDefinition`, not `(value: string) => boolean`. Reading one back as a function needs a narrow; the 21 string entries are still bare functions at runtime. Passing `formats: { name: (s) => ... }` to `createStreamValidator` is unaffected. ([#671](https://github.com/oaverify/oaverify/issues/671)) — migration guide: "`builtInFormats` values are `FormatDefinition`"
* **formats:** a streamed body whose schema declares one of the newly-asserting formats is now checked against it. The integer widths, `byte`, `base64url` and `char` gained validators, and `uri`, `email`, `duration`, `regex`, `time` and `date-time` had their grammars corrected. ([#671](https://github.com/oaverify/oaverify/issues/671), [#676](https://github.com/oaverify/oaverify/issues/676), [#672](https://github.com/oaverify/oaverify/issues/672), [#697](https://github.com/oaverify/oaverify/issues/697))

Full detail in [`@oaverify/core`'s changelog](https://github.com/oaverify/oaverify/blob/main/CHANGELOG.md) and [the v6 migration guide](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md).

## [5.4.0](https://github.com/oaverify/oaverify/compare/stream-v5.3.0...stream-v5.4.0) (2026-08-04)


### Features

* **schema:** unknownFormats option, refusing a format nothing enforces ([#647](https://github.com/oaverify/oaverify/issues/647)) ([442610e](https://github.com/oaverify/oaverify/commit/442610ee02f34fb599e28bc58a296a51cfbff198))


### Bug Fixes

* **stream-validator:** merge builtInFormats under the caller's map ([#639](https://github.com/oaverify/oaverify/issues/639)) ([7dad9c9](https://github.com/oaverify/oaverify/commit/7dad9c99eca965f6ecdc21db0d44266749dc0863)), closes [#636](https://github.com/oaverify/oaverify/issues/636)

## [5.3.0](https://github.com/oaverify/oaverify/compare/stream-v5.2.0...stream-v5.3.0) (2026-08-03)


### Chore

* **stream:** Synchronize oaverify versions

## [5.2.0](https://github.com/oaverify/oaverify/compare/stream-v5.1.0...stream-v5.2.0) (2026-07-31)


### Bug Fixes

* backlog sweep ([#570](https://github.com/oaverify/oaverify/issues/570), [#571](https://github.com/oaverify/oaverify/issues/571), [#573](https://github.com/oaverify/oaverify/issues/573), [#584](https://github.com/oaverify/oaverify/issues/584)) ([#592](https://github.com/oaverify/oaverify/issues/592)) ([8cfafc2](https://github.com/oaverify/oaverify/commit/8cfafc2ea72bd4b77be7ee908a032b03b3171a4e))
* complete the own-key sweep across the router, AOT, and stream engines ([#586](https://github.com/oaverify/oaverify/issues/586)) ([9ee91d3](https://github.com/oaverify/oaverify/commit/9ee91d3879b755cc90e4b9a729390d50ea40e872))

## [5.1.0](https://github.com/oaverify/oaverify/compare/stream-v5.0.0...stream-v5.1.0) (2026-07-30)


### Chore

* **stream:** Synchronize oaverify versions

## [5.0.0](https://github.com/oaverify/oaverify/compare/stream-v4.0.0...stream-v5.0.0) (2026-07-29)

### Chore

* Version bump only, to stay in lockstep with the `@oaverify/core` release group. The streaming API and the analyzer are unchanged since 4.0.0.

### Notes

The streaming engine delegates buffered subtrees to the core schema
compiler, so core's changes reach this package even though its own
source did not move. Three of them can change outcomes: malformed
schemas behind a `$ref` now throw, `$ref` siblings are applied at body
roots, and `dialect` now overrides the version the document declares.
See [core's notes](https://github.com/oaverify/oaverify/blob/main/CHANGELOG.md)
and [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md).

## [4.0.0](https://github.com/oaverify/oaverify/compare/stream-v1.1.0...stream-v4.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* `@aahoughton/oav-stream-validator` is now **`@oaverify/stream`**.
* **Version jumps 1.1.0 -> 4.0.0.** The package was on an independent 1.x
  line; it now shares one version with the rest of the suite. It imports the
  schema and core internals throughout and is built for behavioral parity
  with the core engine, so a core semantics change is a compatibility event
  here whether or not this package's own source moved. Nothing about the
  streaming API changed in this release beyond the rename.
* **Renamed from the `@aahoughton` scope.** npm `oav` belongs to
  Microsoft's Azure/oav, the same problem domain, so the old name was
  search-contaminated regardless of scope. The `@aahoughton/*` packages are
  deprecated and will receive no further releases; they keep working at
  3.8.0 / 1.1.0 indefinitely.

### Documentation

* surface streaming and performance across the docs ([#461](https://github.com/oaverify/oaverify/issues/461)) ([91b7c6f](https://github.com/oaverify/oaverify/commit/91b7c6f4a3294e7da13963c0cbabab8f710a8fb4))


### Chore

* split the packages and rename to oaverify ([#480](https://github.com/oaverify/oaverify/issues/480)) ([a5ddcac](https://github.com/oaverify/oaverify/commit/a5ddcac565d64f3ddfc928bc0a62549ccd1f9f12))

## [1.1.0](https://github.com/aahoughton/oav/compare/oav-stream-validator-v1.0.0...oav-stream-validator-v1.1.0) (2026-06-25)


### Features

* **stream-validator:** member-level key edit (rename/drop) on the stream path ([#441](https://github.com/aahoughton/oav/issues/441)) ([6b76f08](https://github.com/aahoughton/oav/commit/6b76f08f64e1b31b97b3fd283ccedfaf2bfcc11d))
* **stream-validator:** report peak buffered bytes on the verdict ([#443](https://github.com/aahoughton/oav/issues/443)) ([dd42050](https://github.com/aahoughton/oav/commit/dd42050c10ae38f7a0aed116a8f629e75b6ff9d8))

## [1.0.0](https://github.com/aahoughton/oav/compare/oav-stream-validator-v0.2.0...oav-stream-validator-v1.0.0) (2026-06-24)


### Features

* **stream-validator:** streamability analyzer + oav stream-check ([#435](https://github.com/aahoughton/oav/issues/435)) ([e2de16b](https://github.com/aahoughton/oav/commit/e2de16b70d36d49119ba1258b5275353c62cd0d7))


### Bug Fixes

* **stream-validator:** resolve and normalize 3.0 $ref request bodies ([#433](https://github.com/aahoughton/oav/issues/433)) ([c948bec](https://github.com/aahoughton/oav/commit/c948bec07608e0dfcec411dc7f1f3f35e337d737))


### Refactoring

* **stream-validator:** exclusive BodyBudget union and readonly cleanups ([#436](https://github.com/aahoughton/oav/issues/436)) ([7640de6](https://github.com/aahoughton/oav/commit/7640de6796f4af38d5b5aad28ce36445b4b98d55))


### Chore

* **stream-validator:** release the streaming validator as 1.0.0 ([d98ed3d](https://github.com/aahoughton/oav/commit/d98ed3da6f4932b92d9bcf9800e6ddd8a008d892))

## [0.2.0](https://github.com/aahoughton/oav/compare/oav-stream-validator-v0.1.0...oav-stream-validator-v0.2.0) (2026-06-21)


### Features

* **stream-validator:** public-surface ergonomics ([#423](https://github.com/aahoughton/oav/issues/423)) ([#428](https://github.com/aahoughton/oav/issues/428)) ([6ddb759](https://github.com/aahoughton/oav/commit/6ddb759283b207fd90e8ef316719635a67ef33e8))


### Documentation

* **examples:** add streaming examples and refresh existing ones ([#421](https://github.com/aahoughton/oav/issues/421)) ([9318aa4](https://github.com/aahoughton/oav/commit/9318aa474dd40f32f80be306989a6abe05c6ec94))
* lead with the common case on the front-door READMEs and tune npm metadata ([#429](https://github.com/aahoughton/oav/issues/429)) ([80d2384](https://github.com/aahoughton/oav/commit/80d23847a17fbd7ff9b5576a4c7c0cc1cb3e788f))

## 0.1.0 (2026-06-20)


### Features

* **stream-validator:** make maxUniqueItems actually bound the buffered uniqueItems island ([#415](https://github.com/aahoughton/oav/issues/415)) ([aba2171](https://github.com/aahoughton/oav/commit/aba217188fef40f6bc8dab1148b675588907dfda))
* **stream-validator:** make maxUniqueItems bound the buffered uniqueItems island ([aba2171](https://github.com/aahoughton/oav/commit/aba217188fef40f6bc8dab1148b675588907dfda))
* **stream-validator:** publish as @aahoughton/oav-stream-validator (experimental) ([#419](https://github.com/aahoughton/oav/issues/419)) ([c459c11](https://github.com/aahoughton/oav/commit/c459c1122608f2462a6348cc7fca13b1a176e646))
* **stream-validator:** streaming JSON Schema 2020-12 validator ([#408](https://github.com/aahoughton/oav/issues/408)) ([b9d488e](https://github.com/aahoughton/oav/commit/b9d488ebaa38ff7ab533e7a1cc22f30ab2dbd61e))
* **stream-validator:** surface scalar value spans on a value channel ([#412](https://github.com/aahoughton/oav/issues/412)) ([b8d5dd7](https://github.com/aahoughton/oav/commit/b8d5dd7d76b2bdb6e91ed16544f5557bab2d57dc)), closes [#411](https://github.com/aahoughton/oav/issues/411)


### Bug Fixes

* **stream-validator:** eager over-limits + value-event full path (first-consumer fixes) ([#414](https://github.com/aahoughton/oav/issues/414)) ([ba7a0f6](https://github.com/aahoughton/oav/commit/ba7a0f604c4787d283853fcf6dc59352aae83c46))
* **stream-validator:** memoize $ref resolution on the spine hot path ([#410](https://github.com/aahoughton/oav/issues/410)) ([89d0b49](https://github.com/aahoughton/oav/commit/89d0b499a74d4851a4684898ed27cc1ee50e79ea))


### Documentation

* scrub internal references and clean up docs/comments ([#413](https://github.com/aahoughton/oav/issues/413)) ([b21b357](https://github.com/aahoughton/oav/commit/b21b35702155651bb2e6d9a81a7ee7b27cc78bc7))


### Refactoring

* **stream-validator:** tighten public surface before publish ([#418](https://github.com/aahoughton/oav/issues/418)) ([3edb2c9](https://github.com/aahoughton/oav/commit/3edb2c9d262c55f41cbd41bdd66702220b943c1e))
