# Conformance report

Generated 2026-08-05 against commit `bfb8e00`.

Run against three upstream / hand-curated test corpora:

- **JSON Schema Test Suite**: the canonical draft-2020-12 cases at
  <https://github.com/json-schema-org/JSON-Schema-Test-Suite>,
  cloned at a pinned revision into
  `conformance/JSON-Schema-Test-Suite/` by `pnpm corpora`.
- **OpenAPI Overlay 1.0 Test Suite**: the envelope-schema fixtures
  at <https://github.com/OAI/Overlay-Specification>, cloned into
  `conformance/Overlay-Specification/` by `pnpm corpora:overlay`.
- **OpenAPI cases**: hand-curated request/response scenarios under
  `conformance/openapi-cases/<group>/`, covering the petstore shape
  across 3.0, 3.1, and 3.2.

## Summary

| Source                                | Cases | Pass | Mismatch | Error | % pass |
| ------------------------------------- | ----- | ---- | -------- | ----- | ------ |
| JSON Schema Test Suite (required)     | 1299  | 1293 | 2        | 4     | 99.5%  |
| JSON Schema Test Suite (+ optional)   | 1461  | 1452 | 5        | 4     | 99.4%  |
| OpenAPI Overlay 1.0 (envelope)        | 32    | 32   | 0        | 0     | 100%   |
| OpenAPI `petstore` via `oaverify` CLI | 32    | 32   | 0        | 0     | 100%   |

"Mismatch" = our verdict differs from upstream; "error" = our compiler
crashed (we couldn't produce a verdict at all).

The OpenAPI cases live in `conformance/openapi-cases/<group>/spec.yaml` +
`cases.json` and run through the real `oaverify` CLI binary. `expectCodes` on
each case lists the leaf error `code`s that must appear in our error
tree. Full parity on messages isn't required: oaverify uses its own
message strings, but the machine-readable `code`s are stable and
checkable.

## Where we diverge from the JSON Schema suite

The 6 non-passing required-suite cases (2 mismatch + 4 error) fall into
two groups. Every one of them is also a divergence from the ecosystem
majority, measured through Bowtie against eight other JS/TS
implementations plus boon, go-jsonschema and python-jsonschema.

### External / cross-document `$ref` loading (4 errors)

`defs.json` and `ref.json` surface 2 errors each where a referenced
document is not loaded into the schema map. `defs.json` is the pair
that validates a definition against the 2020-12 meta-schema, so these
four are what stands between us and shipping the JSON Schema
meta-schema documents.

### Residual singletons (2 mismatches)

One mismatch each in `multipleOf.json` (float division reaching
infinity) and `vocabulary.json` (a custom meta-schema that declares no
validation vocabulary).

### Closed since the last report

`$dynamicRef` runtime dynamic scope, 14 cases, fixed in #663. The
12 `dynamicRef.json` cases plus the `unevaluatedItems` and
`unevaluatedProperties` "with `$dynamicRef`" singletons. `$dynamicRef`
now resolves against a runtime stack of schema resources rather than a
flattened anchor map. See #662 for what the old behaviour got wrong,
which was a silent pass rather than a wrong rejection.

## Optional-suite breakdown

Running with `--optional` widens to 1461 cases. The extra 162 cases
live under `tests/draft2020-12/optional/`. The 9 non-passing optional
cases (5 mismatch + 4 error):

| File                                 | Status                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| `defs.json`, `ref.json`              | 4 errors, external / cross-document ref loading.          |
| `cross-draft.json`                   | 1 mismatch, same ref-loading root.                        |
| `format-assertion.json`              | 2 mismatches, requires meta-schema loading via `$schema`. |
| `multipleOf.json`, `vocabulary.json` | 1 mismatch each.                                          |

All other optional files pass, including `dynamicRef.json` since #663.

The per-format subtree (`optional/format/*.json`) has its own runner,
`pnpm format-suite`, because `suite:optional` cannot measure it. The
subtree is 720 cases across 21 formats, of which 363 expect a rejection.
By spec default and ours, `format` is annotation-only, so those 363
vacuously fail for every implementation that follows the default: a
Bowtie run across ajv, hyperjump, boon, go-jsonschema and
python-jsonschema returns the same 363 failures for all of them, with
zero divergence between any two. No published comparative format number
exists for anyone, which is why this one is measured locally.

`format-suite` compiles with the OpenAPI 3.1 dialect, which promotes
`format` to an assertion, and scores **629/720**. It reports the two
directions separately, because they carry different consequences: 63
**false accepts** (we allowed a value the format forbids, a missed
catch) and 28 **false rejects** (we refused a value the format allows,
which under the OpenAPI dialects refuses live traffic).

The gap is concentrated rather than spread. `hostname` and
`idn-hostname` are 56 of the 91 failures and are almost entirely
IDNA / UTS-46 rules, deliberately punted. The rest are bounded:
`uri` / `uri-reference` / `iri-reference` character and host handling,
`duration` RFC 3339 ABNF ordering, `email` RFC 5321 quoted local parts
and address literals, and one `regex` case.

`format-results.json` is the committed baseline, gated per format so a
fix in one cannot pay for a regression in another.

## OpenAPI Overlay 1.0

The upstream Overlay test suite is purely
envelope-schema-validation: every fixture under `tests/v1.0/pass/`
must match the canonical overlay JSON Schema, every fixture under
`tests/v1.0/fail/` must not. We compile that schema through
`@oaverify/internal-schema` and run it as our envelope check. Current state:
**32/32 envelope parity** (12 pass + 20 fail).

The runner also feeds every pass fixture through
`@oaverify/internal-overlay-spec`'s `translateOverlay()` and classifies the result
as `ok` / `unrecognised-target` / `translator-error`. This is
informational (upstream does not assert semantic translation), but
it surfaces translator-coverage gaps next to the envelope numbers.

Current translator classification on pass fixtures (12 total):

| Bucket                | Count | Notes                                                                                                                                                            |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                  | 1     | `actions-targeted-overlay-example.yaml` (`$.info`, `$.paths['/...']`, `$.servers[*]`).                                                                           |
| `unrecognised-target` | 5     | wildcards (`$.paths.*.get.parameters`), JSONPath filters / array indexing the closed-form recogniser doesn't accept.                                             |
| `translator-error`    | 6     | "no-op" actions (target-only, no `update`/`remove`) and the `update + remove: true` ambiguity. Permitted by the envelope schema but our translator rejects them. |

The translator-error bucket is a translator design choice (we'd
rather reject ambiguous / no-op actions than silently no-op). The
`unrecognised-target` bucket is the documented closed-form
limitation of the JSONPath recogniser. Neither is a regression
against an established baseline. CI compares envelope-pass and
translator-ok counts against `overlay-results.json`; widening the
recogniser or relaxing the translator both move the baseline up
rather than introducing failures.

## Behavioral parity notes

Where we agree with upstream on pass/fail, we don't try to match their
error-message text. Our error `code`s, `path`s, and `params` are the
parity surface. For the petstore OpenAPI cases the leaf codes are:

- `request` / `response` (root wrapper)
- `route` (no matching path)
- `body`, `path-param`, `query-param`, `header-param`, `cookie-param`
- `content-type` (media-type mismatch)
- `status` (undeclared response status)
- every JSON Schema keyword code: `type`, `minimum`, `required`, ...

Any consumer can drive alerting off these `code` values without parsing
message text.

## Reproduce

`conformance/` is a standalone package (its deps aren't in the main
workspace install). Bootstrap it once, then run the harness:

```bash
cd conformance
pnpm install
pnpm corpora                    # clones all three corpora at their pins
cd ..
pnpm build                      # builds the CLI the OpenAPI runner shells out to

cd conformance
pnpm suite                      # required suite
pnpm suite:optional             # + optional (format-edge-cases etc.)
pnpm suite -- --filter=ref      # just ref.json / refRemote.json
pnpm overlay                    # OpenAPI Overlay 1.0 envelope + translator
pnpm openapi                    # CLI-driven OpenAPI scenarios
```

Detailed per-case output lands in `conformance/json-schema-results.json`,
`conformance/overlay-results.json`, and `conformance/openapi-results.json`.
`json-schema-results.json` and `overlay-results.json` are committed
baselines that CI compares against with `--check-baseline`;
`openapi-results.json` and the `+optional` JSON Schema variant are
gitignored.
