# Changelog

## [7.2.0](https://github.com/oaverify/oaverify/compare/oaverify-v7.1.0...oaverify-v7.2.0) (2026-08-20)

### Upgrading

* **`compile-spec` no longer emits a security gate by default.** 7.1.0
  compiled an unconditional operation-level check into the module, so a
  deployment relying on it **stops checking on upgrade**. Pass
  `--validate-security shape` or `strict` to opt back in; `shape` is
  what 7.1.0 effectively ran, so it restores the old behaviour, and
  `strict` is stricter than the old gate ever was. The emitted
  gate now matches `createValidator` in all three modes, and honours
  document-level requirements, which it previously dropped entirely:
  before this, every operation inheriting its requirement from the
  document served anonymous traffic ([#911](https://github.com/oaverify/oaverify/issues/911)).
* **`oaverify check` answers exit 1 rather than exit 3** on a document
  whose `security` or `parameters` field cannot be read ([#883](https://github.com/oaverify/oaverify/issues/883), [#884](https://github.com/oaverify/oaverify/issues/884)).


### Features

* **cli:** a `--return-values` mode for `compile-spec` ([#905](https://github.com/oaverify/oaverify/issues/905)) ([4011d53](https://github.com/oaverify/oaverify/commit/4011d53154734255e9b63f917f3e9a9f72d28d30))
* **cli:** `--validate-security <mode>` for `compile-spec` ([#911](https://github.com/oaverify/oaverify/issues/911)) ([b760520](https://github.com/oaverify/oaverify/commit/b76052090113c90c7dafdd8666d661134e62105b))


### Bug Fixes

* **cli:** answer an implicit HEAD in the emitted validator ([#909](https://github.com/oaverify/oaverify/issues/909)) ([e50f99a](https://github.com/oaverify/oaverify/commit/e50f99a41cc7b2807312bbe7a2ba6a775ce72c77))
* **cli:** assemble an object parameter in the emitted validator ([#904](https://github.com/oaverify/oaverify/issues/904)) ([9577133](https://github.com/oaverify/oaverify/commit/957713345c76befef0666638091cd123fb793509))
* **cli:** decode a content-typed parameter before validating it ([#908](https://github.com/oaverify/oaverify/issues/908)) ([07230bc](https://github.com/oaverify/oaverify/commit/07230bc195c92c6b79ec072ffdd0ba844cc791ff))
* **cli:** refuse to emit a parameter location the validator cannot serve ([#839](https://github.com/oaverify/oaverify/issues/839)) ([07cd0bd](https://github.com/oaverify/oaverify/commit/07cd0bd4e5acb9f0e77d85874e0e71f47780d29d))
* **cli:** write the check report to `--output` in one piece ([#869](https://github.com/oaverify/oaverify/issues/869)) ([4cd2142](https://github.com/oaverify/oaverify/commit/4cd2142ff45addb5dd5f33d1ef6ed6753f120510))

### Documentation

* defer to the canonical option docs, and realign the express pair ([#933](https://github.com/oaverify/oaverify/issues/933)) ([a826ebb](https://github.com/oaverify/oaverify/commit/a826ebb8d0c4c3a18dd18f2b1a2a8ba23310acf1))

## [7.1.0](https://github.com/oaverify/oaverify/compare/oaverify-v7.0.0...oaverify-v7.1.0) (2026-08-16)


### Chore

* **oaverify:** Synchronize oaverify versions

## [7.0.0](https://github.com/oaverify/oaverify/compare/oaverify-v6.0.0...oaverify-v7.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **core:** `isSubschemaKey`, `SUBSCHEMA_SINGLE_POSITIONS`, `SUBSCHEMA_ARRAY_POSITIONS` and `SUBSCHEMA_MAP_POSITIONS` are no longer exported from `@oaverify/core`. Import them from `@oaverify/core/schema/internals`, which is outside the semver contract.
* **core:** the "flat" output-format alias is removed; pass "summary" instead. This is the `--format` flag and `formatError`'s renderer name, not `ValidatorOptions.output: "flat"`, which is unaffected.
* **cli:** `oaverify` refuses a `$ref` to another origin unless `--remote-refs allow` is passed. The flag shipped in v6 and already accepted that value, so there is no rename, no shim and no deprecation cycle; a caller who sets `--remote-refs` today is unaffected. The library is unaffected either way, composing no reader it was not given.
* @oaverify/yaml is now @oaverify/syntax. Every exported name and behaviour is unchanged; update the specifier. See docs/migration-v7.md.

### Features

* **cli:** refuse cross-origin remote $refs by default ([#779](https://github.com/oaverify/oaverify/issues/779)) ([bdb8916](https://github.com/oaverify/oaverify/commit/bdb89163166ccf8c5256c3426aeed821d3ae138c)), closes [#692](https://github.com/oaverify/oaverify/issues/692)
* rename @oaverify/yaml to @oaverify/syntax ([#768](https://github.com/oaverify/oaverify/issues/768)) ([7b29cc1](https://github.com/oaverify/oaverify/commit/7b29cc166f4e7e5ecb4e2c2f197c131ee910f752))


### Bug Fixes

* **check:** keep findings produced before an aborted check ([#719](https://github.com/oaverify/oaverify/issues/719)) ([51be0c7](https://github.com/oaverify/oaverify/commit/51be0c7fef2d529fd058e0699d3b81f18519580a)), closes [#716](https://github.com/oaverify/oaverify/issues/716)


### Chore

* **core:** move the subschema-position tables off the public entry ([#813](https://github.com/oaverify/oaverify/issues/813)) ([23cc28a](https://github.com/oaverify/oaverify/commit/23cc28abdb54f8baa54c3369f52753116610b44f))
* **core:** remove the deprecated "flat" output-format alias ([#791](https://github.com/oaverify/oaverify/issues/791)) ([24c3ad9](https://github.com/oaverify/oaverify/commit/24c3ad9207bc3d3523c2adbcc76b0b6044d0e38b))

## [6.0.0](https://github.com/oaverify/oaverify/compare/oaverify-v5.4.0...oaverify-v6.0.0) (2026-08-07)

**`oaverify check` now gates by default, and `--only` is now `--findings`.** Both are one-line changes wherever you invoke it, and both change what CI does. See [the v6 migration guide](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md).

### ⚠ BREAKING CHANGES

* **cli:** `oaverify check` exits 1 on any error-severity finding with no flag. A run relying on the advisory exit 0 needs `--fail-on none`. This also makes `--severity` gate-affecting, since regrading happens before `--fail-on` reads the result. Fixes [#549](https://github.com/oaverify/oaverify/issues/549). ([#686](https://github.com/oaverify/oaverify/issues/686)) — migration guide: "`check` gates on `error` severity by default"
* **cli:** `check --only <classes>` is replaced by `--findings <terms>`. The new flag takes the same key grammar as `--severity`, so a term is a code, a family as `name/*`, or a class, and a `-` prefix excludes. `--findings conformance` selects one class the way `--only` did; `--findings -unused-tag` reports everything except one code, which `--only` could not express. `compile-spec --only "POST /pets"` is a different flag and is unchanged. ([#673](https://github.com/oaverify/oaverify/issues/673)) — migration guide: "`--only` becomes `--findings`"
* **cli:** `compile-spec` on a document using formats outside the built-in set exits 3 instead of emitting silently; pass `--unknown-formats ignore` for the old behavior. Fixes [#660](https://github.com/oaverify/oaverify/issues/660). ([#685](https://github.com/oaverify/oaverify/issues/685)) — migration guide: "the compile commands refuse unknown formats by default"
* **check:** `check` exits 2 (`CheckAbortedError`) on a document it cannot grade even when the selection reaches no schema code; such runs previously exited 0 with an empty report. Fixes [#674](https://github.com/oaverify/oaverify/issues/674). ([#680](https://github.com/oaverify/oaverify/issues/680)) — migration guide: "`check` aborts on an ungradeable document at every selection"

### Features

* **cli:** flags for reader containment and outbound requests ([#693](https://github.com/oaverify/oaverify/issues/693)) ([b875639](https://github.com/oaverify/oaverify/commit/b875639a904b79a3b3d76f55de99f17a9dfdd1b2)). `--remote-refs allow|same-origin|deny` bounds how far `http(s)` reads may go, the entry document included; `--untrusted` confines file reads to the entry's directory, tightens the size and time caps, and implies `--remote-refs same-origin`. Both are available on `resolve`, `check`, `validate`, `compile-spec` and `stream-check`.

Traffic validated through the CLI is also subject to the format assertions added in `@oaverify/core` 6.0.0; see [its changelog](https://github.com/oaverify/oaverify/blob/main/CHANGELOG.md).

## [5.4.0](https://github.com/oaverify/oaverify/compare/oaverify-v5.3.0...oaverify-v5.4.0) (2026-08-04)

`oaverify check` now runs the check from the new [`@oaverify/check`](https://www.npmjs.com/package/@oaverify/check) package rather than its own copy. Same passes, same findings, same exit codes; the package is a new runtime dependency of the CLI.


### Features

* **cli:** enumerate check codes and validate --severity against them ([#641](https://github.com/oaverify/oaverify/issues/641)) ([67a928a](https://github.com/oaverify/oaverify/commit/67a928a2a386e94bdbb9c7597f2db20bc98ebc47)), closes [#633](https://github.com/oaverify/oaverify/issues/633) [#632](https://github.com/oaverify/oaverify/issues/632)
* **cli:** report a format check cannot validate ([#645](https://github.com/oaverify/oaverify/issues/645)) ([25e5471](https://github.com/oaverify/oaverify/commit/25e547157731fb8cfd4b38cb66da142f6a091a00)), closes [#644](https://github.com/oaverify/oaverify/issues/644)
* **check:** move the composed spec check into @oaverify/check ([#654](https://github.com/oaverify/oaverify/issues/654)) ([2b376e2](https://github.com/oaverify/oaverify/commit/2b376e253f59dcf97b6b8a71cdc670e6fbb8260d))


### Bug Fixes

* **check:** stop reporting an unvalidatable example as fine ([#653](https://github.com/oaverify/oaverify/issues/653)) ([e251b65](https://github.com/oaverify/oaverify/commit/e251b6530f0de0ef2925bb96cd730f996b731ce5)), closes [#625](https://github.com/oaverify/oaverify/issues/625)

## [5.3.0](https://github.com/oaverify/oaverify/compare/oaverify-v5.2.0...oaverify-v5.3.0) (2026-08-03)


### Features

* **cli:** accept a spec on stdin in every mode that takes one ([#617](https://github.com/oaverify/oaverify/issues/617)) ([272ca12](https://github.com/oaverify/oaverify/commit/272ca125e2f4e6c53b4d4ea56e676ee2628b8f5d))
* **cli:** SARIF 2.1.0 output for check ([#622](https://github.com/oaverify/oaverify/issues/622)) ([163a0df](https://github.com/oaverify/oaverify/commit/163a0df5fb615108363b2cf702396477437852d4))


### Bug Fixes

* **check:** report each rejected-example leaf once ([#616](https://github.com/oaverify/oaverify/issues/616)) ([86cb5fe](https://github.com/oaverify/oaverify/commit/86cb5fedebad8b74810db6a1d96d0c8982f1d11f))


### Documentation

* **cli:** move the shipped contracts into the package that ships ([#615](https://github.com/oaverify/oaverify/issues/615)) ([f5a5f00](https://github.com/oaverify/oaverify/commit/f5a5f00563a5cff15d9e80fe892cd7c6bf4ba6b8))
* **cli:** note that target.pointer values moved for multi-file specs ([#619](https://github.com/oaverify/oaverify/issues/619)) ([86a9b9e](https://github.com/oaverify/oaverify/commit/86a9b9ea6608b556b0a98109f1596e36528b39a9))

## [5.2.0](https://github.com/oaverify/oaverify/compare/oaverify-v5.1.0...oaverify-v5.2.0) (2026-07-31)


### Performance

* **validator:** take the own-property check off the parameter hot path ([#590](https://github.com/oaverify/oaverify/issues/590)) ([1714a12](https://github.com/oaverify/oaverify/commit/1714a12a3e47a1f3282cb387a298d09eb0526b3d))

## [5.1.0](https://github.com/oaverify/oaverify/compare/oaverify-v5.0.0...oaverify-v5.1.0) (2026-07-30)


### Features

* **check:** report a pattern with a proven ambiguity ([#569](https://github.com/oaverify/oaverify/issues/569)) ([f0913a7](https://github.com/oaverify/oaverify/commit/f0913a76c91518edaaa5530b03c684c28787ed4c)), closes [#563](https://github.com/oaverify/oaverify/issues/563)
* **cli:** document conformance as a check class, with severity ([#546](https://github.com/oaverify/oaverify/issues/546)) ([b9132d8](https://github.com/oaverify/oaverify/commit/b9132d87ad9ff7ff6dd6cde7a86ec33722ed50ce))

## [5.0.0](https://github.com/oaverify/oaverify/compare/oaverify-v4.0.0...oaverify-v5.0.0) (2026-07-29)

### ⚠ BREAKING CHANGES

* **Spec quality moved from `resolve --lint` to `check`.** `resolve` stitches a multi-file document and prints it; `check` answers whether the spec is good. `oaverify resolve spec.yaml --lint --fail-on warning` becomes `oaverify check spec.yaml --fail-on warning` ([#502](https://github.com/oaverify/oaverify/issues/502)).
* **A usage error exits 3.** An unknown command, unknown option, or missing argument returned Commander's 1, which the exit-code tables document as "a domain check failed", so a CI script reading that saw a spec with findings where it had a typo in the command name. `--help` still exits 0 ([#533](https://github.com/oaverify/oaverify/issues/533)).

### Features

* **`check`**: spec hygiene, schema lint, and malformed-schema findings in one report, with `--only`, `--fail-on`, and `--format text|json`. Findings for a component reached from several operations are reported once with an occurrence count ([#502](https://github.com/oaverify/oaverify/issues/502))
* **`--version`** ([#526](https://github.com/oaverify/oaverify/issues/526))

### Notes

Validation semantics come from `@oaverify/core`, which had three
outcome-changing fixes in this release. If you gate CI on this binary,
read [its notes](https://github.com/oaverify/oaverify/blob/main/CHANGELOG.md)
and [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md)
before moving the gate.

## [4.0.0](https://github.com/oaverify/oaverify/compare/oaverify-v3.8.0...oaverify-v4.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* `@aahoughton/oav` is now **`oaverify`** (unscoped), and it is now a
  CLI-only package. The binary is `oaverify`, not `oav`.
* **The CLI package no longer exports the library.** `oaverify` (formerly
  `@aahoughton/oav`) now ships only the `oaverify` binary. Import the library
  from `@oaverify/core` (or `@oaverify/core/schema`, `/spec`, `/formats`,
  `/overlay-spec`), and take `@oaverify/yaml` for `createYamlFileReader`,
  `createSmartHttpReader`, `parseYamlString`, and `loadSpecSync`. Validators
  emitted by `compile-spec` / `compile-schema` now import `@oaverify/core`
  by default.
* **Renamed from the `@aahoughton` scope.** npm `oav` belongs to
  Microsoft's Azure/oav, the same problem domain, so the old name was
  search-contaminated regardless of scope. The `@aahoughton/*` packages are
  deprecated and will receive no further releases; they keep working at
  3.8.0 / 1.1.0 indefinitely.

### Documentation

* surface streaming and performance across the docs ([#461](https://github.com/oaverify/oaverify/issues/461)) ([91b7c6f](https://github.com/oaverify/oaverify/commit/91b7c6f4a3294e7da13963c0cbabab8f710a8fb4))


### Chore

* split the packages and rename to oaverify ([#480](https://github.com/oaverify/oaverify/issues/480)) ([a5ddcac](https://github.com/oaverify/oaverify/commit/a5ddcac565d64f3ddfc928bc0a62549ccd1f9f12))

## [3.8.0](https://github.com/aahoughton/oav/compare/oav-v3.7.0...oav-v3.8.0) (2026-07-06)


### Chore

* **oav:** Synchronize oav versions

## [3.7.0](https://github.com/aahoughton/oav/compare/oav-v3.6.0...oav-v3.7.0) (2026-06-25)


### Chore

* **oav:** Synchronize oav versions

## [3.6.0](https://github.com/aahoughton/oav/compare/oav-v3.5.0...oav-v3.6.0) (2026-06-24)


### Features

* **stream-validator:** streamability analyzer + oav stream-check ([#435](https://github.com/aahoughton/oav/issues/435)) ([e2de16b](https://github.com/aahoughton/oav/commit/e2de16b70d36d49119ba1258b5275353c62cd0d7))

## [3.5.0](https://github.com/aahoughton/oav/compare/oav-v3.4.0...oav-v3.5.0) (2026-06-21)


### Documentation

* lead with the common case on the front-door READMEs and tune npm metadata ([#429](https://github.com/aahoughton/oav/issues/429)) ([80d2384](https://github.com/aahoughton/oav/commit/80d23847a17fbd7ff9b5576a4c7c0cc1cb3e788f))

## [3.4.0](https://github.com/aahoughton/oav/compare/oav-v3.3.0...oav-v3.4.0) (2026-06-20)


### Documentation

* **oav:** correct the root package's batteries-included loader note ([#416](https://github.com/aahoughton/oav/issues/416)) ([e0767fa](https://github.com/aahoughton/oav/commit/e0767fa291806fd2ea9ae2e0980af278a99e7562))

## [3.3.0](https://github.com/aahoughton/oav/compare/oav-v3.2.0...oav-v3.3.0) (2026-06-16)


### Chore

* **oav:** Synchronize oav versions

## [3.2.0](https://github.com/aahoughton/oav/compare/oav-v3.1.0...oav-v3.2.0) (2026-06-11)


### Chore

* **oav:** Synchronize oav versions

## [3.1.0](https://github.com/aahoughton/oav/compare/oav-v3.0.0...oav-v3.1.0) (2026-06-09)


### Features

* synchronous spec loader (loadSpecSync) ([#362](https://github.com/aahoughton/oav/issues/362)) ([efbf842](https://github.com/aahoughton/oav/commit/efbf842a99d9405066ed4f3fc451ec3b9eb6ea9c))

## [3.0.0](https://github.com/aahoughton/oav/compare/oav-v2.4.0...oav-v3.0.0) (2026-06-08)


### Chore

* **oav:** Synchronize oav versions

## [2.4.0](https://github.com/aahoughton/oav/compare/oav-v2.3.0...oav-v2.4.0) (2026-06-06)


### Chore

* **oav:** Synchronize oav versions

## [2.3.0](https://github.com/aahoughton/oav/compare/oav-v2.2.1...oav-v2.3.0) (2026-06-06)


### Features

* **oav:** make esbuild an optional peer dependency ([#313](https://github.com/aahoughton/oav/issues/313)) ([daad9dd](https://github.com/aahoughton/oav/commit/daad9dd8b5848f6df5e5f1917b613c78208527f0))

## [2.2.1](https://github.com/aahoughton/oav/compare/oav-v2.2.0...oav-v2.2.1) (2026-06-05)


### Chore

* **oav:** Synchronize oav versions

## [2.2.0](https://github.com/aahoughton/oav/compare/oav-v2.1.0...oav-v2.2.0) (2026-05-19)


### Features

* **overlay-spec:** translator for OpenAPI Overlay 1.0 spec format ([#290](https://github.com/aahoughton/oav/issues/290)) ([e8ae711](https://github.com/aahoughton/oav/commit/e8ae71100586922f55040db59537866d3e2d8938))

## [2.1.0](https://github.com/aahoughton/oav/compare/oav-v2.0.0...oav-v2.1.0) (2026-05-04)


### Documentation

* cleanup pass, spelling normalization, TSDoc tightening ([#260](https://github.com/aahoughton/oav/issues/260)) ([77fcf4d](https://github.com/aahoughton/oav/commit/77fcf4ddafe8e6a30b8108fc0dee78a31a8e1a6b))

## [2.0.0](https://github.com/aahoughton/oav/compare/oav-v1.1.1...oav-v2.0.0) (2026-05-02)


### Documentation

* move root markdown into docs/ subdir ([#237](https://github.com/aahoughton/oav/issues/237)) ([365af48](https://github.com/aahoughton/oav/commit/365af48ab7394bf18ddc498419f15be67079ba3a))

## [1.1.1](https://github.com/aahoughton/oav/compare/oav-v1.1.0...oav-v1.1.1) (2026-04-27)


### Bug Fixes

* **docs:** cross-link gaps, custom-envelope worked example, parseYamlString cast hint ([#230](https://github.com/aahoughton/oav/issues/230)) ([b65c75d](https://github.com/aahoughton/oav/commit/b65c75dc54ca2afc128858587d2ab7ffec0d3f57)), closes [#229](https://github.com/aahoughton/oav/issues/229)

## [1.1.0](https://github.com/aahoughton/oav/compare/oav-v1.0.0...oav-v1.1.0) (2026-04-26)


### Features

* **core:** add formatSummary + toJsonObject; deprecate three misnamed exports ([#218](https://github.com/aahoughton/oav/issues/218)) ([23ce743](https://github.com/aahoughton/oav/commit/23ce743e1241b58998a385ecfb4ccb56a34daa3c))

## 1.0.0 (2026-04-25)

Initial release. Batteries-included distribution of
[`@aahoughton/oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core):
same programmatic surface, plus YAML readers and the `oav` CLI.
