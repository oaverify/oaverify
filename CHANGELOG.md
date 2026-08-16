# Changelog

## [7.1.0](https://github.com/oaverify/oaverify/compare/core-v7.0.0...core-v7.1.0) (2026-08-16)


### Features

* **validator:** read OpenAPI 3.2's cookie parameter style ([#828](https://github.com/oaverify/oaverify/issues/828)) ([63efe44](https://github.com/oaverify/oaverify/commit/63efe4481f0e729c40657109d1a148740b050800))


### Bug Fixes

* **formats:** uppercase IPvFuture version letter, and bump the JSON Schema Test Suite pin ([#820](https://github.com/oaverify/oaverify/issues/820)) ([69977e6](https://github.com/oaverify/oaverify/commit/69977e6b29489f789bd248120958a90825b449b5))
* **validator:** coerce an object parameter's properties with their schemas ([#825](https://github.com/oaverify/oaverify/issues/825)) ([b3ad532](https://github.com/oaverify/oaverify/commit/b3ad5326ff6cc0cfb277d5c38debfd4d627e7c70)), closes [#824](https://github.com/oaverify/oaverify/issues/824)
* **validator:** deserialize an object parameter in its declared style ([#822](https://github.com/oaverify/oaverify/issues/822)) ([8709160](https://github.com/oaverify/oaverify/commit/870916072530e864579adbdea78c0ec68c319663)), closes [#818](https://github.com/oaverify/oaverify/issues/818) [#787](https://github.com/oaverify/oaverify/issues/787)
* **validator:** require a label or matrix token to carry its framing ([#823](https://github.com/oaverify/oaverify/issues/823)) ([5d2abb5](https://github.com/oaverify/oaverify/commit/5d2abb5cae4d250b51b7e6de6f2b1824091e93cf)), closes [#789](https://github.com/oaverify/oaverify/issues/789)

## [7.0.0](https://github.com/oaverify/oaverify/compare/core-v6.0.0...core-v7.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* format: idn-email now rejects local parts over 64 UTF-8 octets that previously passed by fitting in 64 UTF-16 units. The pinned conformance baseline is unchanged (no suite case covers the gap).
* **core:** `isSubschemaKey`, `SUBSCHEMA_SINGLE_POSITIONS`, `SUBSCHEMA_ARRAY_POSITIONS` and `SUBSCHEMA_MAP_POSITIONS` are no longer exported from `@oaverify/core`. Import them from `@oaverify/core/schema/internals`, which is outside the semver contract.
* **core:** the "flat" output-format alias is removed; pass "summary" instead. This is the `--format` flag and `formatError`'s renderer name, not `ValidatorOptions.output: "flat"`, which is unaffected.
* **core:** `ConformanceIssue.location`, `SchemaLintIssue.context` and `PrecompileFailure.context` are removed. Read `ConformanceIssue.pointer`, `SchemaLintIssue.location` and `PrecompileFailure.location`; the values are unchanged.
* **validator:** a `style: matrix` parameter whose segment carries no group naming it is now reported as missing rather than reaching the handler as [] or as the foreign group's value. Requests that were accepted and silently mis-deserialized are now rejected.
* **core:** report a rejected fetch body's direction; scope httpStatusFor to requests ([#786](https://github.com/oaverify/oaverify/issues/786))
* **validator:** bound the Fetch adapter's body read by maxTotalBytes ([#785](https://github.com/oaverify/oaverify/issues/785))
* **cli:** `oaverify` refuses a `$ref` to another origin unless `--remote-refs allow` is passed. The flag shipped in v6 and already accepted that value, so there is no rename, no shim and no deprecation cycle; a caller who sets `--remote-refs` today is unaffected. The library is unaffected either way, composing no reader it was not given.
* @oaverify/yaml is now @oaverify/syntax. Every exported name and behaviour is unchanged; update the specifier. See docs/migration-v7.md.

### Features

* **check:** locate each sub-rejection of an invalid example in SARIF ([#778](https://github.com/oaverify/oaverify/issues/778)) ([d81ab42](https://github.com/oaverify/oaverify/commit/d81ab42175d663f5d3761c00e54f8566d3fc9346))
* **check:** point a finding at the key where the name is the subject ([#771](https://github.com/oaverify/oaverify/issues/771)) ([81d69ec](https://github.com/oaverify/oaverify/commit/81d69ecd4e51f2074387cfb3826627eb350fc2c6))
* **cli:** refuse cross-origin remote $refs by default ([#779](https://github.com/oaverify/oaverify/issues/779)) ([bdb8916](https://github.com/oaverify/oaverify/commit/bdb89163166ccf8c5256c3426aeed821d3ae138c)), closes [#692](https://github.com/oaverify/oaverify/issues/692)
* **core:** share the leaf detail renderer between both message sites ([#782](https://github.com/oaverify/oaverify/issues/782)) ([fd0827c](https://github.com/oaverify/oaverify/commit/fd0827cdf2ae7cdb36b6634d1a76816eb6e4c604)), closes [#777](https://github.com/oaverify/oaverify/issues/777)
* **formats:** assert language, an RFC 5646 tag ([#733](https://github.com/oaverify/oaverify/issues/733)) ([6393bfe](https://github.com/oaverify/oaverify/commit/6393bfe7d1fb27f17c73b35d8e1fe4c2d7c2e5ca))
* **formats:** assert media-range, the RFC 9110 production ([#734](https://github.com/oaverify/oaverify/issues/734)) ([c2c3721](https://github.com/oaverify/oaverify/commit/c2c3721e4d6a39f9915a4a167e917997c1efc33b))
* **formats:** assert six more OpenAPI Format Registry names ([#732](https://github.com/oaverify/oaverify/issues/732)) ([62d6b34](https://github.com/oaverify/oaverify/commit/62d6b3471d7cdc78686e0c184f1abc8a924a4bbf))
* line and column for a check finding ([#769](https://github.com/oaverify/oaverify/issues/769)) ([781108a](https://github.com/oaverify/oaverify/commit/781108a4afa3fa5c4d749e4040d73b4e30bb2a6f))
* rename @oaverify/yaml to @oaverify/syntax ([#768](https://github.com/oaverify/oaverify/issues/768)) ([7b29cc1](https://github.com/oaverify/oaverify/commit/7b29cc166f4e7e5ecb4e2c2f197c131ee910f752))
* **schema:** export stringArrayValue and checkStringArray from internals ([#802](https://github.com/oaverify/oaverify/issues/802)) ([c0a9c65](https://github.com/oaverify/oaverify/commit/c0a9c650218ff85a2707fb2d11785efb4e47618c))
* **validator:** bound the Fetch adapter's body read by maxTotalBytes ([#785](https://github.com/oaverify/oaverify/issues/785)) ([bc45651](https://github.com/oaverify/oaverify/commit/bc45651b24093bb513b93329bb82feb85200a5fe))
* **validator:** read bracket-suffixed query keys behind an option ([#746](https://github.com/oaverify/oaverify/issues/746)) ([e481b5c](https://github.com/oaverify/oaverify/commit/e481b5cbd6696dd5325b781cd7e8d925b46bcf49))
* **validator:** return deserialized request values behind returnValues ([#745](https://github.com/oaverify/oaverify/issues/745)) ([2f74122](https://github.com/oaverify/oaverify/commit/2f74122b23b7f26a0c61524f462b9fdae7efffa8))


### Bug Fixes

* **check,cli:** stop reporting a dropped x- extension, and stop leaking chunk names ([#811](https://github.com/oaverify/oaverify/issues/811)) ([5ce8bdc](https://github.com/oaverify/oaverify/commit/5ce8bdce7613b2509b64c37186cbb2e51d68c8a1))
* **check:** give float its own reason for going unasserted ([#795](https://github.com/oaverify/oaverify/issues/795)) ([e78df56](https://github.com/oaverify/oaverify/commit/e78df568cf8153efe741154fe5e9de146cc68b7e))
* **check:** keep findings produced before an aborted check ([#719](https://github.com/oaverify/oaverify/issues/719)) ([51be0c7](https://github.com/oaverify/oaverify/commit/51be0c7fef2d529fd058e0699d3b81f18519580a)), closes [#716](https://github.com/oaverify/oaverify/issues/716)
* **check:** state a rule's explanation on the rule, not in every finding ([#774](https://github.com/oaverify/oaverify/issues/774)) ([be5aa81](https://github.com/oaverify/oaverify/commit/be5aa81923b5173a5c01f5c3ecfd01f06478da8b)), closes [#773](https://github.com/oaverify/oaverify/issues/773)
* **cli:** stop repeatable flags swallowing the positional ([#797](https://github.com/oaverify/oaverify/issues/797)) ([3015aa7](https://github.com/oaverify/oaverify/commit/3015aa78d04ae22fe9322c2566e16e1ef99a87fc))
* **core:** report a rejected fetch body's direction; scope httpStatusFor to requests ([#786](https://github.com/oaverify/oaverify/issues/786)) ([291387c](https://github.com/oaverify/oaverify/commit/291387c982fa67ba47e066bc74e5ee9bd0d3b092)), closes [#784](https://github.com/oaverify/oaverify/issues/784)
* **formats:** accept line-wrapped base64 under byte, ship the strict reading ([#720](https://github.com/oaverify/oaverify/issues/720)) ([1df778d](https://github.com/oaverify/oaverify/commit/1df778d8d74624190fc3b959d1b81d76144ec844)), closes [#705](https://github.com/oaverify/oaverify/issues/705)
* **formats:** uri-template grammar, and bump the JSON Schema Test Suite pin ([#764](https://github.com/oaverify/oaverify/issues/764)) ([04ac736](https://github.com/oaverify/oaverify/commit/04ac736c96170989c68251b46c6f11a3c8bc35e4))
* **router:** decode literal runs inside a compound path segment ([#718](https://github.com/oaverify/oaverify/issues/718)) ([5c4d686](https://github.com/oaverify/oaverify/commit/5c4d686f06aa81b3239a3c3b0f132a444bf34b7e)), closes [#715](https://github.com/oaverify/oaverify/issues/715)
* **router:** let a compound capture hold a decoded slash ([#728](https://github.com/oaverify/oaverify/issues/728)) ([82a71f5](https://github.com/oaverify/oaverify/commit/82a71f588690b8afd8de9bc2dc3e4d99522882ba)), closes [#724](https://github.com/oaverify/oaverify/issues/724)
* **router:** match compound path segments with a linear scan ([#731](https://github.com/oaverify/oaverify/issues/731)) ([8c260ca](https://github.com/oaverify/oaverify/commit/8c260caa1d578e5ba49d804a169cc397675b5438)), closes [#730](https://github.com/oaverify/oaverify/issues/730)
* **router:** report a malformed path template instead of throwing URIError ([#712](https://github.com/oaverify/oaverify/issues/712)) ([d227968](https://github.com/oaverify/oaverify/commit/d227968c745cd7b47cce0a654fa7216c56696ed5)), closes [#708](https://github.com/oaverify/oaverify/issues/708)
* **router:** stop blaming parameter names for a literal route collision ([#727](https://github.com/oaverify/oaverify/issues/727)) ([5cf8994](https://github.com/oaverify/oaverify/commit/5cf89946b7d590fef1dce1b3bb848978ebe1b630)), closes [#725](https://github.com/oaverify/oaverify/issues/725)
* **schema:** bound the multipleOf tolerance and handle an overflowing quotient ([#713](https://github.com/oaverify/oaverify/issues/713)) ([d36e05e](https://github.com/oaverify/oaverify/commit/d36e05ee6b03074991989bef4f9e4a72b0d41c8c)), closes [#709](https://github.com/oaverify/oaverify/issues/709)
* **schema:** do not judge the value of a $ref sibling OAS 3.0 discards ([#801](https://github.com/oaverify/oaverify/issues/801)) ([d6d6d90](https://github.com/oaverify/oaverify/commit/d6d6d905dca25aba656694e887b3b17205a21771))
* settle the six code-vs-doc conflicts from the TSDoc audit ([#816](https://github.com/oaverify/oaverify/issues/816)) ([3b76c9f](https://github.com/oaverify/oaverify/commit/3b76c9f7072aeea3427f89be5d7c16d4b8d4501c))
* stop raw V8 messages reaching the user on null document nodes ([#794](https://github.com/oaverify/oaverify/issues/794)) ([a632cd4](https://github.com/oaverify/oaverify/commit/a632cd4ecba5c5cce58c77046a2689be2b5066b1))
* twelve defects from an adversarial review of the public surfaces ([#736](https://github.com/oaverify/oaverify/issues/736)) ([7d07c15](https://github.com/oaverify/oaverify/commit/7d07c15a6cdee7ffb4a06cd32c334bd1bfffa04b))
* **validator:** coerce parameters whose schemas sit behind a $ref ([#723](https://github.com/oaverify/oaverify/issues/723)) ([7c16282](https://github.com/oaverify/oaverify/commit/7c16282aa536d06fbc3cfbe336b6ca462ade8319)), closes [#714](https://github.com/oaverify/oaverify/issues/714)
* **validator:** coerce serialized parameter values with their subschemas ([#711](https://github.com/oaverify/oaverify/issues/711)) ([b24de2c](https://github.com/oaverify/oaverify/commit/b24de2cba568edf9c5d8eac0d0b9b329614640e3)), closes [#707](https://github.com/oaverify/oaverify/issues/707)
* **validator:** read a deepObject property by the scalar number grammar ([#756](https://github.com/oaverify/oaverify/issues/756)) ([5022745](https://github.com/oaverify/oaverify/commit/5022745f6ebc1dc996fa80d85242e69d7a4016b7)), closes [#751](https://github.com/oaverify/oaverify/issues/751)
* **validator:** read a matrix segment's group names in every shape ([#788](https://github.com/oaverify/oaverify/issues/788)) ([9c0627e](https://github.com/oaverify/oaverify/commit/9c0627e07840adc7e33cd62a8cced3db22e77750))
* **validator:** read a type set naming one type as that type ([#754](https://github.com/oaverify/oaverify/issues/754)) ([c88f0b7](https://github.com/oaverify/oaverify/commit/c88f0b737a66cb0125c9e640d3ebdea43410f43a))
* **validator:** resolve coercion refs through the resolver schemas compile with ([#729](https://github.com/oaverify/oaverify/issues/729)) ([e8e2b71](https://github.com/oaverify/oaverify/commit/e8e2b7187dee56efebae117d079950b829dcad85)), closes [#726](https://github.com/oaverify/oaverify/issues/726)
* **validator:** return a body verdict from a composite's unparseable fetch body ([#747](https://github.com/oaverify/oaverify/issues/747)) ([6cc769a](https://github.com/oaverify/oaverify/commit/6cc769a2be93c0c20554aae156c6b0426fc798a8))
* **validator:** say the example-check pattern guard is conservative ([#799](https://github.com/oaverify/oaverify/issues/799)) ([c699ad4](https://github.com/oaverify/oaverify/commit/c699ad4ed0bbbf0b03590d8ecd5c691c5e7c4a2e))
* **validator:** treat an explicit JSON null request body as a value ([#710](https://github.com/oaverify/oaverify/issues/710)) ([01d0e78](https://github.com/oaverify/oaverify/commit/01d0e78e3362cff2f0d4cc64ad93e065ee7cf2eb)), closes [#706](https://github.com/oaverify/oaverify/issues/706)
* **validator:** walk QUERY operations in the document schema walk ([#796](https://github.com/oaverify/oaverify/issues/796)) ([f01700e](https://github.com/oaverify/oaverify/commit/f01700eb2cbe000eb027444dac526c1399e3a03d))


### Documentation

* correct claims that do not match the code ([#805](https://github.com/oaverify/oaverify/issues/805)) ([a1e0412](https://github.com/oaverify/oaverify/commit/a1e0412b4bf16fcf20cbd8529fb37d0c201aa32c))
* correct four documentation defects found in the v7 review ([#792](https://github.com/oaverify/oaverify/issues/792)) ([bef64db](https://github.com/oaverify/oaverify/commit/bef64dbe4607219a31e545a8880e24d2ff760bce))
* **extending:** write down which specification a format validator follows ([#722](https://github.com/oaverify/oaverify/issues/722)) ([241b41d](https://github.com/oaverify/oaverify/commit/241b41d44644b22b5236939065261ac23d3732c7)), closes [#705](https://github.com/oaverify/oaverify/issues/705)
* fix snippets that do not compile, and two stale example claims ([#806](https://github.com/oaverify/oaverify/issues/806)) ([ed0cf8b](https://github.com/oaverify/oaverify/commit/ed0cf8b0a4621f3386e643b43719bced7d558a2e))
* **integration:** a report-only recipe for the adapters' onError hook ([#748](https://github.com/oaverify/oaverify/issues/748)) ([1453396](https://github.com/oaverify/oaverify/commit/1453396e97683b7545cf42848b5b2e1f94275c34))
* pare the prose docs and rework the README arrival surface ([#814](https://github.com/oaverify/oaverify/issues/814)) ([3593ef7](https://github.com/oaverify/oaverify/commit/3593ef7bd0a078c123ed94fec0767c066b96a297))
* **readme:** add a Why this exists section ([#721](https://github.com/oaverify/oaverify/issues/721)) ([e4d2650](https://github.com/oaverify/oaverify/commit/e4d26503941698ac9ffd0f138bd929000a30e5c6))
* **schema:** lead the compile context with a roadmap of its three groups ([#781](https://github.com/oaverify/oaverify/issues/781)) ([49ab584](https://github.com/oaverify/oaverify/commit/49ab584e2ce128dec2184cbffc3be16bce486ec1)), closes [#349](https://github.com/oaverify/oaverify/issues/349)
* state the Node floor, and give three unsourced numbers their host ([#812](https://github.com/oaverify/oaverify/issues/812)) ([10c14e2](https://github.com/oaverify/oaverify/commit/10c14e2a8d80658b4083608cff233940b88719d8))
* **tsdoc:** correct comments that misdescribe the code, and fix dead links ([#815](https://github.com/oaverify/oaverify/issues/815)) ([ecc7c24](https://github.com/oaverify/oaverify/commit/ecc7c24eabe97f60d29b0897f45937a1cfda146d))
* **tsdoc:** fix references to things that do not exist, and three gaps ([#808](https://github.com/oaverify/oaverify/issues/808)) ([06c2920](https://github.com/oaverify/oaverify/commit/06c292075a15e0ac187e04a6d7b75046d8674cf9))


### Refactoring



### Chore

* **core:** move the subschema-position tables off the public entry ([#813](https://github.com/oaverify/oaverify/issues/813)) ([23cc28a](https://github.com/oaverify/oaverify/commit/23cc28abdb54f8baa54c3369f52753116610b44f))
* **core:** remove the deprecated "flat" output-format alias ([#791](https://github.com/oaverify/oaverify/issues/791)) ([24c3ad9](https://github.com/oaverify/oaverify/commit/24c3ad9207bc3d3523c2adbcc76b0b6044d0e38b))
* **core:** remove the three deprecated field aliases ([#790](https://github.com/oaverify/oaverify/issues/790)) ([87ec28f](https://github.com/oaverify/oaverify/commit/87ec28fa6791374f6e1719362bea94628e1ce50f))

## [6.0.0](https://github.com/oaverify/oaverify/compare/core-v5.4.0...core-v6.0.0) (2026-08-07)

**`format` became one registry, and a lot of it now asserts.** Formats that were annotations reject traffic in 6.0: the integer widths, the base64 pair, `char`, and the string formats whose grammars were wrong. If you never pass `formats` and never read `builtInFormats`, that is the whole upgrade. **On the CLI, `check` gates by default**: it exits 1 on an error-severity finding where it used to exit 0 advisory.

Every breaking change below has a section in [the v6 migration guide](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md), which is the place to read before upgrading.

### ⚠ BREAKING CHANGES

**Formats now assert**

* **formats:** the integer widths (`int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`, `double-int`), the base64 pair (`byte`, `base64url`) and `char` gained validators, so a value declared with one of them and out of range is now a validation error. `byte` is the one most likely to be in a document you already have, and it rejects RFC 2045 line-wrapped base64. `int64` and `uint64` assert the safe-integer range rather than the full 64-bit range, because a JSON number past 2^53 is provably not the value that was on the wire. `float`, `double`, `binary` and `password` are not asserted and will not be. ([#671](https://github.com/oaverify/oaverify/issues/671), [#697](https://github.com/oaverify/oaverify/issues/697)) — migration guide: "Why `int32` started rejecting", "`int64` accepts less than int64", "`byte` rejects line-wrapped base64"
* **formats:** `uri`, `uri-reference`, `iri` and `iri-reference` match the RFC 3986 / 3987 grammars instead of delegating to `new URL()`, which repaired illegal input rather than refusing it. `email`, `duration` and `regex` were tightened in the same pass. Verdicts change in both directions. ([#676](https://github.com/oaverify/oaverify/issues/676)) — migration guide: "`uri` and `iri` match the grammar, not `new URL`", "`duration` enforces RFC 3339 unit ordering", "the `regex` format asserts ECMA-262 u-mode"
* **formats:** `time` and `date-time` accept `:60` only at the end of a UTC day, and bound the offset's own fields, so `22:59:60Z` and `01:02:03+24:00` are rejected. The three offset spellings of the real leap second still pass. ([#672](https://github.com/oaverify/oaverify/issues/672)) — migration guide: "`time` and `date-time` bound the leap second and the offset"
* **formats:** `builtInFormats` values are `FormatDefinition`, not `(value: string) => boolean`. Reading one back as a function needs a narrow; the 21 string entries are still bare functions at runtime. `fromAjvFormats` returns the same widened shape and now carries `type: "number"` through as a numeric format instead of dropping it into the string map, where it was called with strings. Passing `formats: { name: (s) => ... }` is unaffected. ([#671](https://github.com/oaverify/oaverify/issues/671)) — migration guide: "`builtInFormats` values are `FormatDefinition`", "`fromAjvFormats` routes `type: \"number\"`"

**CLI and `check`**

* **cli:** `oaverify check` exits 1 on any error-severity finding with no flag; runs relying on the advisory exit 0 need `--fail-on none`. Fixes [#549](https://github.com/oaverify/oaverify/issues/549). ([#686](https://github.com/oaverify/oaverify/issues/686)) — migration guide: "`check` gates on `error` severity by default"
* **check,cli:** `CheckOptions.only` is removed. `checkSpec(spec, { only: ["hygiene"] })` becomes `checkSpec(spec, { findings: selectionForClasses(["hygiene"]) })`. On the CLI, `--only` becomes `--findings`, which reaches an exact code or a family where `--only` reached only a class. ([#673](https://github.com/oaverify/oaverify/issues/673)) — migration guide: "`--only` becomes `--findings`"
* **check:** `check` now exits 2 (`CheckAbortedError`) on a document it cannot grade even when the selection reaches no schema code; such runs previously exited 0 with an empty report. Fixes [#674](https://github.com/oaverify/oaverify/issues/674). ([#680](https://github.com/oaverify/oaverify/issues/680)) — migration guide: "`check` aborts on an ungradeable document at every selection"
* **cli:** `compile-spec` on a document using formats outside the built-in set now exits 3 instead of emitting silently; pass `--unknown-formats ignore` for the old behavior. Fixes [#660](https://github.com/oaverify/oaverify/issues/660). ([#685](https://github.com/oaverify/oaverify/issues/685)) — migration guide: "the compile commands refuse unknown formats by default"

**Library surface**

* **core:** `deserialize`, `matchParsedMediaType`, `matchResponseKey`, `httpRequestFromFetch`, `httpResponseFromFetch`, `checkSecurity`, `compileOperationSecurity`, `resolveOperationRef`, `createRouter`, `reshapeResult`, `toFetchResult`, `contentTypeErrorMessage` and the `FetchRequestOptions` / `Router` / `RouteMatch` types are no longer exported from `@oaverify/core/validator/internals`; import them from `@oaverify/core/codegen-runtime`. Modules previously emitted by `compile-spec` keep working (they are bundled); regenerate with the current CLI to pick up the new specifier. Fixes [#656](https://github.com/oaverify/oaverify/issues/656). ([#682](https://github.com/oaverify/oaverify/issues/682)) — migration guide: "the emit-side runtime moves to `@oaverify/core/codegen-runtime`"
* **schema:** `compileSchema` returns an empty `CompiledSchema.source` unless the compile passes `retainSource: true`. ([#691](https://github.com/oaverify/oaverify/issues/691)) — migration guide: "`compileSchema` drops the generated source by default"

### Features

* **schema:** resolve `$dynamicRef` against the runtime dynamic scope ([#663](https://github.com/oaverify/oaverify/issues/663)) ([bfb8e00](https://github.com/oaverify/oaverify/commit/bfb8e00706aa5621d5472d9a40b77e063c3d94f1)). It resolved statically against a flattened anchor map, so a schema declaring the same `$dynamicAnchor` in more than one scope bound every reference to whichever declaration the flattening kept, and the failure mode was a silent pass. All 12 upstream `dynamicRef.json` cases now pass.
* **cli:** flags for reader containment and outbound requests ([#693](https://github.com/oaverify/oaverify/issues/693)) ([b875639](https://github.com/oaverify/oaverify/commit/b875639a904b79a3b3d76f55de99f17a9dfdd1b2)). `--remote-refs` bounds how far `http(s)` reads may go, the entry document included; `--untrusted` confines file reads to the entry's directory and tightens the caps.
* **schema:** surface the `pattern` u-mode fallback as a schema-lint finding ([#684](https://github.com/oaverify/oaverify/issues/684)) ([4995e1f](https://github.com/oaverify/oaverify/commit/4995e1f1f26bdb570767619fd097e2e58a74f32e))
* **core:** split the emit-side runtime into `@oaverify/core/codegen-runtime` ([#682](https://github.com/oaverify/oaverify/issues/682)) ([47f6759](https://github.com/oaverify/oaverify/commit/47f6759e0664d3a6d1d12fb8ae978b9acbff2f79))

### Bug Fixes

* **check:** guard the examples pass against catastrophic patterns ([#688](https://github.com/oaverify/oaverify/issues/688)) ([dc70741](https://github.com/oaverify/oaverify/commit/dc707411cdce0872d4c8c20ab4fa648579ea1392))
* **validator:** name the ignored content-type header, and stop the AOT message drifting ([#677](https://github.com/oaverify/oaverify/issues/677)) ([f6c862c](https://github.com/oaverify/oaverify/commit/f6c862cb3e296b58d9f25e7c269d0e369cdd12c3))

### Performance

* **schema:** drop the generated source unless asked for it ([#691](https://github.com/oaverify/oaverify/issues/691)) ([2913c15](https://github.com/oaverify/oaverify/commit/2913c15884b3b4108023e208affdab3d944eb387))

Compile got slower this cycle, and the refreshed numbers say so. On the same host as the previous run, every synthetic shape is 36-89% slower to compile than at 5.4.0, against an Ajv control that moved 1-6%. The cause is compile-time work that accumulated as schema-lint passes were added; it is measured and tracked in [#702](https://github.com/oaverify/oaverify/issues/702) and [#701](https://github.com/oaverify/oaverify/issues/701). Compile remains 16x to 199x faster than Ajv. Validate throughput is unchanged. See [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md#performance).

### Documentation

* **comparison:** refresh the benchmark numbers on c7i.large ([#703](https://github.com/oaverify/oaverify/issues/703)) ([2d5331c](https://github.com/oaverify/oaverify/commit/2d5331c64fb7e60271ea876274d77fb3797e2d35))
* correct the claims 6.0 made stale ([#698](https://github.com/oaverify/oaverify/issues/698)) ([2c93f7f](https://github.com/oaverify/oaverify/commit/2c93f7f4866f1a902a09869c250a3bd41e2f720a))
* **migration-v6:** cover the leap-second and offset tightening ([#704](https://github.com/oaverify/oaverify/issues/704)) ([472fdac](https://github.com/oaverify/oaverify/commit/472fdac256d3da660cfee1b3f669cb2b456479c3))
* **readme:** describe both verbs, not just the traffic one ([#699](https://github.com/oaverify/oaverify/issues/699)) ([ac43978](https://github.com/oaverify/oaverify/commit/ac439782700a4d8dea9efebbd3cc7d625df61033))
* **cli:** document the reader-containment flags ([#700](https://github.com/oaverify/oaverify/issues/700)) ([58465de](https://github.com/oaverify/oaverify/commit/58465de32aab4fa246ccf2af228a0fd81afb1067))
* publish the detection corpus by pointing at it, and answer the custom-rule question ([#689](https://github.com/oaverify/oaverify/issues/689)) ([519e283](https://github.com/oaverify/oaverify/commit/519e28330e873ca94a18d6a705dbb282f58d654b))

## [5.4.0](https://github.com/oaverify/oaverify/compare/core-v5.3.0...core-v5.4.0) (2026-08-04)

**New package: [`@oaverify/check`](https://www.npmjs.com/package/@oaverify/check).** The document check behind `oaverify check` is now published on its own, so you can call `checkSpec` from your own tooling and grade, address and render the findings the way the CLI does. The CLI behaves exactly as before. `@oaverify/core`'s surface is unchanged by the move; see [its changelog](https://github.com/oaverify/oaverify/blob/main/packages/check/CHANGELOG.md).


### Features

* **schema:** unknownFormats option, refusing a format nothing enforces ([#647](https://github.com/oaverify/oaverify/issues/647)) ([442610e](https://github.com/oaverify/oaverify/commit/442610ee02f34fb599e28bc58a296a51cfbff198))
* **spec:** bound file reads by maxBytes ([#650](https://github.com/oaverify/oaverify/issues/650)) ([7d8637a](https://github.com/oaverify/oaverify/commit/7d8637a8f43ac344988a623a425b49a82cb340de)), closes [#588](https://github.com/oaverify/oaverify/issues/588)


### Bug Fixes

* **validator:** stop reporting an unvalidatable example as fine ([#653](https://github.com/oaverify/oaverify/issues/653)) ([e251b65](https://github.com/oaverify/oaverify/commit/e251b6530f0de0ef2925bb96cd730f996b731ce5)), closes [#625](https://github.com/oaverify/oaverify/issues/625)


### Documentation

* define fatal as a rank, not as what happened to the document ([#648](https://github.com/oaverify/oaverify/issues/648)) ([c993ae6](https://github.com/oaverify/oaverify/commit/c993ae686bcf442af8bef367eba3634f34509ef0)), closes [#638](https://github.com/oaverify/oaverify/issues/638)
* map the old package names to the new ones ([#649](https://github.com/oaverify/oaverify/issues/649)) ([11bbe58](https://github.com/oaverify/oaverify/commit/11bbe58d0a5928ed0e1309e1360dab10fc335adc)), closes [#637](https://github.com/oaverify/oaverify/issues/637)
* point --severity at the code list it now validates against ([#642](https://github.com/oaverify/oaverify/issues/642)) ([bc9e3f1](https://github.com/oaverify/oaverify/commit/bc9e3f180e99be69e43b268213e96f179da5f8e3))
* **readme:** name @oaverify/check in the install table ([#657](https://github.com/oaverify/oaverify/issues/657)) ([77bfe86](https://github.com/oaverify/oaverify/commit/77bfe86207d8aa17518b302799262cb035662d9b))

## [5.3.0](https://github.com/oaverify/oaverify/compare/core-v5.2.0...core-v5.3.0) (2026-08-03)


### Features

* **cli:** accept a spec on stdin in every mode that takes one ([#617](https://github.com/oaverify/oaverify/issues/617)) ([272ca12](https://github.com/oaverify/oaverify/commit/272ca125e2f4e6c53b4d4ea56e676ee2628b8f5d))
* **cli:** let the consumer own severity with --severity ([#621](https://github.com/oaverify/oaverify/issues/621)) ([2c1c9a1](https://github.com/oaverify/oaverify/commit/2c1c9a1f0f92101de9ee985144f0a122c00640f6))
* **cli:** SARIF 2.1.0 output for check ([#622](https://github.com/oaverify/oaverify/issues/622)) ([163a0df](https://github.com/oaverify/oaverify/commit/163a0df5fb615108363b2cf702396477437852d4))
* **schema:** report enum members the sibling type cannot admit ([#620](https://github.com/oaverify/oaverify/issues/620)) ([56f338e](https://github.com/oaverify/oaverify/commit/56f338e68d9f06a07ef033ddc821caeb12d8ac10))
* **spec:** tell a finding which file it came from ([#614](https://github.com/oaverify/oaverify/issues/614)) ([d6035f8](https://github.com/oaverify/oaverify/commit/d6035f8b05ae2312233870dbf57f4e3ca2f74c5f))


### Bug Fixes

* **check:** report each rejected-example leaf once ([#616](https://github.com/oaverify/oaverify/issues/616)) ([86cb5fe](https://github.com/oaverify/oaverify/commit/86cb5fedebad8b74810db6a1d96d0c8982f1d11f))
* **check:** stop building a ref resolver the examples pass may not need ([#623](https://github.com/oaverify/oaverify/issues/623)) ([7af2bc4](https://github.com/oaverify/oaverify/commit/7af2bc4177608b3648c9b7cbf2fa1c0cdb0e4394))
* **spec:** follow $ref only where OpenAPI defines one ([#601](https://github.com/oaverify/oaverify/issues/601)) ([e8d96ca](https://github.com/oaverify/oaverify/commit/e8d96cae9af9eb85234e88f2748f5429c1ba6ad5))
* **spec:** name the document that failed to read, and what referenced it ([#599](https://github.com/oaverify/oaverify/issues/599)) ([472ccae](https://github.com/oaverify/oaverify/commit/472ccae3ded368cae3b931592be3f6b617db6f38))
* **spec:** stop treating a reference to the entry document as external ([#618](https://github.com/oaverify/oaverify/issues/618)) ([5f84d50](https://github.com/oaverify/oaverify/commit/5f84d5086638f0a6e95991037b05e207480b8986))


### Documentation

* cleanup ([#627](https://github.com/oaverify/oaverify/issues/627)) ([bb50269](https://github.com/oaverify/oaverify/commit/bb50269ff850f065d1ce4ec11154f0515b5d9580))
* **cli:** move the shipped contracts into the package that ships ([#615](https://github.com/oaverify/oaverify/issues/615)) ([f5a5f00](https://github.com/oaverify/oaverify/commit/f5a5f00563a5cff15d9e80fe892cd7c6bf4ba6b8))
* **cli:** note that target.pointer values moved for multi-file specs ([#619](https://github.com/oaverify/oaverify/issues/619)) ([86a9b9e](https://github.com/oaverify/oaverify/commit/86a9b9ea6608b556b0a98109f1596e36528b39a9))
* **schema:** state the frame SchemaLintIssue.path renders in ([#613](https://github.com/oaverify/oaverify/issues/613)) ([64189e7](https://github.com/oaverify/oaverify/commit/64189e7dc07a3a1f77573163d0135058b3c711d8))

## [5.2.0](https://github.com/oaverify/oaverify/compare/core-v5.1.0...core-v5.2.0) (2026-07-31)


### Features

* **check:** give findings a machine-readable address ([#593](https://github.com/oaverify/oaverify/issues/593)) ([8403f7e](https://github.com/oaverify/oaverify/commit/8403f7e24ae5dc45d8921691b53ad668c22226bb))
* **check:** lay the text report out over lines instead of one per finding ([#597](https://github.com/oaverify/oaverify/issues/597)) ([b4090dd](https://github.com/oaverify/oaverify/commit/b4090ddf9e08d45f52b870f75864a167db3a9799))
* **check:** report all example failure reasons and quiet 3.0 oneOf noise ([#582](https://github.com/oaverify/oaverify/issues/582)) ([c705558](https://github.com/oaverify/oaverify/commit/c7055581f9bb4c600e77ec4f62e3bac9994d1613)), closes [#517](https://github.com/oaverify/oaverify/issues/517)
* **spec:** add containment and outbound-request controls to the readers ([#585](https://github.com/oaverify/oaverify/issues/585)) ([de655a4](https://github.com/oaverify/oaverify/commit/de655a4350450b90ff75e65b73b24bf59cd5096d))


### Bug Fixes

* backlog sweep ([#570](https://github.com/oaverify/oaverify/issues/570), [#571](https://github.com/oaverify/oaverify/issues/571), [#573](https://github.com/oaverify/oaverify/issues/573), [#584](https://github.com/oaverify/oaverify/issues/584)) ([#592](https://github.com/oaverify/oaverify/issues/592)) ([8cfafc2](https://github.com/oaverify/oaverify/commit/8cfafc2ea72bd4b77be7ee908a032b03b3171a4e))
* complete the own-key sweep across the router, AOT, and stream engines ([#586](https://github.com/oaverify/oaverify/issues/586)) ([9ee91d3](https://github.com/oaverify/oaverify/commit/9ee91d3879b755cc90e4b9a729390d50ea40e872))
* **spec:** make confine and maxBytes enforce what they claim ([#589](https://github.com/oaverify/oaverify/issues/589)) ([6fd82d5](https://github.com/oaverify/oaverify/commit/6fd82d5ac7bd32322c79f0add309ca286b17a9cb))
* stop untrusted keys traversing the prototype chain ([#583](https://github.com/oaverify/oaverify/issues/583)) ([2da9fbb](https://github.com/oaverify/oaverify/commit/2da9fbb79c144c943f5e7874514c2dc0f56bf8bb))


### Performance

* **validator:** take the own-property check off the parameter hot path ([#590](https://github.com/oaverify/oaverify/issues/590)) ([1714a12](https://github.com/oaverify/oaverify/commit/1714a12a3e47a1f3282cb387a298d09eb0526b3d))


### Documentation

* **comparison:** cover the check verb and cite the detection corpus ([#577](https://github.com/oaverify/oaverify/issues/577)) ([5371a19](https://github.com/oaverify/oaverify/commit/5371a1947937e7d316dde4b12ba7e08537ec8b46))

## [5.1.0](https://github.com/oaverify/oaverify/compare/core-v5.0.0...core-v5.1.0) (2026-07-30)


### Features

* **check:** report a pattern with a proven ambiguity ([#569](https://github.com/oaverify/oaverify/issues/569)) ([f0913a7](https://github.com/oaverify/oaverify/commit/f0913a76c91518edaaa5530b03c684c28787ed4c)), closes [#563](https://github.com/oaverify/oaverify/issues/563)
* **check:** validate documented examples against their schemas ([#554](https://github.com/oaverify/oaverify/issues/554)) ([3de31b9](https://github.com/oaverify/oaverify/commit/3de31b927ef97d9f5873974ce26c7ecc69f0746e)), closes [#541](https://github.com/oaverify/oaverify/issues/541) [#552](https://github.com/oaverify/oaverify/issues/552)
* **cli:** document conformance as a check class, with severity ([#546](https://github.com/oaverify/oaverify/issues/546)) ([b9132d8](https://github.com/oaverify/oaverify/commit/b9132d87ad9ff7ff6dd6cde7a86ec33722ed50ce))
* **metaschema:** pin the published OpenAPI meta-schemas per version ([#544](https://github.com/oaverify/oaverify/issues/544)) ([708e96f](https://github.com/oaverify/oaverify/commit/708e96f5d80b934006e87362b5d505caccb48a60))
* **schema:** report a pattern that cannot satisfy its length bounds ([#551](https://github.com/oaverify/oaverify/issues/551)) ([f382a57](https://github.com/oaverify/oaverify/commit/f382a57c158d7e3e739fd2d9af6b82b2400255cf)), closes [#542](https://github.com/oaverify/oaverify/issues/542)
* **schema:** report wrong-typed annotation values through schemaLint ([#547](https://github.com/oaverify/oaverify/issues/547)) ([ca1ed00](https://github.com/oaverify/oaverify/commit/ca1ed0035a951b375c723c348eab0a911db0ec6c))
* **spec:** hoist external schemas into components instead of inlining them ([#562](https://github.com/oaverify/oaverify/issues/562)) ([a735fb8](https://github.com/oaverify/oaverify/commit/a735fb81f2814ff30e51f66aec275b0564747ffc))


### Bug Fixes

* **check:** validate Parameter, Header and Encoding-header examples ([#564](https://github.com/oaverify/oaverify/issues/564)) ([aa4fb9a](https://github.com/oaverify/oaverify/commit/aa4fb9a24aecf405ca0325ebcfe5d8b1f5d7d33c)), closes [#560](https://github.com/oaverify/oaverify/issues/560)
* **schema:** fall back to the composition when a discriminator cannot route ([#565](https://github.com/oaverify/oaverify/issues/565)) ([0236abe](https://github.com/oaverify/oaverify/commit/0236abe05f35ba3b6a5c99c24aa9be8420370f31)), closes [#561](https://github.com/oaverify/oaverify/issues/561)
* **schema:** report a Schema Object examples that is not an array ([#557](https://github.com/oaverify/oaverify/issues/557)) ([f5cdd3a](https://github.com/oaverify/oaverify/commit/f5cdd3ab0c5ec365f413dbf0f05b093363201842)), closes [#555](https://github.com/oaverify/oaverify/issues/555)
* **spec:** materialise non-schema cycles under an x- extension, not a root $defs ([#566](https://github.com/oaverify/oaverify/issues/566)) ([b6c74e7](https://github.com/oaverify/oaverify/commit/b6c74e729717843938da8e2d647ab0cfef9f4c6c)), closes [#559](https://github.com/oaverify/oaverify/issues/559)
* **validator:** match headers case-insensitively ([#575](https://github.com/oaverify/oaverify/issues/575)) ([8107595](https://github.com/oaverify/oaverify/commit/8107595c454e17e54088f4f06e9de57afb25a281))


### Documentation

* convert CLAUDE.md to AGENTS.md and correct the stale package tour ([#574](https://github.com/oaverify/oaverify/issues/574)) ([a440aca](https://github.com/oaverify/oaverify/commit/a440acac86db3af28d7d3cf5887a70728906bcf5))
* **examples:** add spec-check and Fetch-handler examples ([#576](https://github.com/oaverify/oaverify/issues/576)) ([556018e](https://github.com/oaverify/oaverify/commit/556018e01e8a5cbd37cccc85e1a09b0d0783a506))
* record that pnpm lint is not the whole lint gate ([#558](https://github.com/oaverify/oaverify/issues/558)) ([8871dcd](https://github.com/oaverify/oaverify/commit/8871dcdaf6377d3f7616db9c94c68eddd8874bbc))
* report bundle cost in kilobytes ([#568](https://github.com/oaverify/oaverify/issues/568)) ([5405961](https://github.com/oaverify/oaverify/commit/540596111d08f5d48b9846e6b702ab97ad521e1d))
* report the bundle cost of embedding the library ([#567](https://github.com/oaverify/oaverify/issues/567)) ([b716694](https://github.com/oaverify/oaverify/commit/b7166947f480281d9ab15e1da14e626c1e40cce0))

## [5.0.0](https://github.com/oaverify/oaverify/compare/core-v4.0.0...core-v5.0.0) (2026-07-29)

A naming and reporting release. Most of the upgrade is mechanical:
option names, result type names, and CLI verbs, each of which
TypeScript or a failed command points at directly. Three changes can
alter validation outcomes on a spec you did not edit, and those are the
ones to read first: malformed schemas behind a `$ref` now throw
(below), `$ref` siblings are applied at body roots (below), and
`dialect` now overrides the version the document declares (below).

[**docs/migration-v5.md**](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md)
is the upgrade guide, with before/after for every item here. The
section numbers below point into it.

These notes cover what changed for a 4.0.0 user. Surfaces introduced
during this release cycle and then corrected before it shipped are not
listed: `check`, `CheckFinding`, `precompile`'s `onMalformed` mode, and
the finding-collapse `occurrences` field all ship for the first time in
5.0.0, so their intermediate fixes are not upgrade material.

### ⚠ BREAKING CHANGES

* **`strict` is now `schemaLint`** ([#495](https://github.com/oaverify/oaverify/issues/495)). `strict: "warn-partial"` becomes `schemaLint: "warn"`; `strictIssues` becomes `schemaLintIssues`, and `StrictIssue` becomes `SchemaLintIssue`. `strictQueryParameters` and `validateSecurity` keep their names. (§1)
* **The v2 deprecated aliases are gone** ([#497](https://github.com/oaverify/oaverify/issues/497)). The `flat` / `predicate` booleans on `CompileOptions`, `FlatValidationResult`, and `CompiledFlatSchema` were documented for removal in v4 and survived it. Use `output: "flat" | "predicate"`, `ValidationResult`, and `CompiledSchema`. The `{ predicate: true }` overload and the two mutual-exclusion guards go with them. (§2)
* **Spec quality moved from `oaverify resolve --lint` to `oaverify check`** ([#502](https://github.com/oaverify/oaverify/issues/502)). `resolve` stitches a document; `check` answers whether the spec is good. `oaverify resolve spec.yaml --lint --fail-on warning` becomes `oaverify check spec.yaml --fail-on warning`. (§3)
* **Overlay `extend*` verbs take a `Partial` of the component** ([#509](https://github.com/oaverify/oaverify/issues/509)). `extendSchemas`, `extendParameters`, and the rest previously required a complete component object where only the changed fields were meaningful. (§4)
* **`$ref` siblings are applied at request and response body roots** ([#508](https://github.com/oaverify/oaverify/issues/508)). Under 3.1 a body schema written as `{ $ref, required: [...] }` had its siblings dropped at the root while they applied everywhere else. They now apply, so a constraint the spec declares and v4 ignored is enforced. **This can turn a passing request into a failing one.** (§5)
* **Malformed schemas behind a `$ref` now throw** ([#492](https://github.com/oaverify/oaverify/issues/492), [#494](https://github.com/oaverify/oaverify/issues/494), [#522](https://github.com/oaverify/oaverify/issues/522)). The well-formedness guard ran only on the schema handed to the compiler, so components reached through the resolver were compiled unchecked. An array-valued `items` inside a component compiled to a keyword-free schema and the array's elements went entirely unvalidated while the spec looked fine. Illegal `type` names and a string-valued `required` are rejected on the same path. No option suppresses this, including `schemaLint: "off"`. **This can turn a spec that built into one that throws.** Run `oaverify check` against your spec on v5 to find them all at once. (§6)
* **`required-not-in-properties` was rewritten** ([#501](https://github.com/oaverify/oaverify/issues/501), [#503](https://github.com/oaverify/oaverify/issues/503)). The rule asked whether the object composes, which over-fired on composition branches and suppressed itself exactly where the real cases live: 2.6% signal across 13 published specs. It now asks what property names are reachable at the instance position. The code is unchanged, so a filter keyed on `silent-rewrite/required-not-in-properties` keeps working; expect a different set of findings. (§7)
* **A CLI usage error exits 3** ([#533](https://github.com/oaverify/oaverify/issues/533)). An unknown command, unknown option, or missing argument returned Commander's 1, which the exit-code tables document as "a domain check failed". A CI script reading that saw a spec with findings where it had a typo. `--help` still exits 0. (§8)
* **`dialect` overrides the version the document declares** ([#538](https://github.com/oaverify/oaverify/issues/538)). The option was documented as forcing a dialect and was consulted only where version detection failed, so on a spec declaring a recognised `openapi` version it was read and discarded, and a custom `Dialect` had no way in. It now takes precedence. **If you pass `dialect` alongside a well-versioned spec, the option now does something.** `detectedVersion` still reports what the document declares. (§9)

### Features

* **`oaverify check`**, a verb for spec quality: hygiene, schema lint, and malformed-schema findings in one report, with `--only`, `--fail-on`, and `--format text|json` ([#502](https://github.com/oaverify/oaverify/issues/502))
* **`oaverify --version`** ([#526](https://github.com/oaverify/oaverify/issues/526))
* **`validateKeywordValue` on `KeywordDefinition`**, so a custom keyword can reject its own malformed value at compile time with a located error instead of failing obscurely at runtime ([#498](https://github.com/oaverify/oaverify/issues/498))
* **Lint findings carry operation context**, naming what was being compiled when the finding was produced ([#507](https://github.com/oaverify/oaverify/issues/507))
* **Schema lint follows `$ref`** ([#523](https://github.com/oaverify/oaverify/issues/523)). Rules other than `required-not-in-properties` saw one operation's inline schema plus at most the component named directly as its body: on one published spec, 1 of 278 components. Expect more findings on the same document.

### Bug Fixes

* **Polynomial backtracking removed from the router and the `uri` format** ([#487](https://github.com/oaverify/oaverify/issues/487)). Both patterns were reachable from request input.

### Documentation

* [**docs/migration-v5.md**](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md), the v4 to v5 upgrade guide ([#530](https://github.com/oaverify/oaverify/issues/530))

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
