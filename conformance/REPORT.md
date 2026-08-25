# Conformance report

`pnpm check:conformance-report`, which `pnpm lint` runs, holds this file
to the committed baselines, so it tracks `main` rather than a date. What
that covers is worth stating exactly, since the parts it does not cover
are where the last two drifts happened:

- **Gated against a committed baseline**: the required-suite row and the
  sentence restating it, the Overlay row and all three translator
  buckets, the format subtree's size, score and both failure directions,
  and the headline `README.md` quotes.
- **Gated by agreement**: the `+ optional` row, whose runner writes a
  gitignored file. It is bounded by the required baseline and checked
  against both places below that enumerate its non-passing cases, so
  moving any one of the three alone fails.
- **Not gated**: the OpenAPI petstore row, for the same gitignored-runner
  reason and with nothing here stating it twice, and figures derived in
  prose (the 162 extra optional cases, the 425 that expect a rejection,
  "58 of the 61 failures").

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
| JSON Schema Test Suite (required)     | 1299  | 1294 | 1        | 4     | 99.6%  |
| JSON Schema Test Suite (+ optional)   | 1461  | 1453 | 4        | 4     | 99.5%  |
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

The 5 non-passing required-suite cases (1 mismatch + 4 error) fall into
two groups. Every one of them is also a divergence from the ecosystem
majority, measured through Bowtie against eight other JS/TS
implementations plus boon, go-jsonschema and python-jsonschema.

### External / cross-document `$ref` loading (4 errors)

`defs.json` and `ref.json` surface 2 errors each where a referenced
document is not loaded into the schema map. `defs.json` is the pair
that validates a definition against the 2020-12 meta-schema, so these
four are what stands between us and shipping the JSON Schema
meta-schema documents.

### Residual singletons (1 mismatch)

One mismatch in `vocabulary.json`, a custom meta-schema that declares no
validation vocabulary.

### Closed since the last report

`multipleOf` float division reaching infinity, 2 cases, fixed in #709:
the `multipleOf.json` singleton and the optional `float-overflow.json`
case. The tolerance scaled with the quotient without an upper bound, so
a quotient that overflowed to `Infinity` produced a `NaN` comparison no
tolerance could fail. The tolerance is now capped, and an overflowing
quotient falls back to a remainder test, which separates the two cases:
`1e308` is a multiple of `0.5` and is not one of `0.123456789`.

`$dynamicRef` runtime dynamic scope, 14 cases, fixed in #663. The
12 `dynamicRef.json` cases plus the `unevaluatedItems` and
`unevaluatedProperties` "with `$dynamicRef`" singletons. `$dynamicRef`
now resolves against a runtime stack of schema resources rather than a
flattened anchor map. See #662 for what the old behaviour got wrong,
which was a silent pass rather than a wrong rejection.

## Optional-suite breakdown

Running with `--optional` widens to 1461 cases. The extra 162 cases
live under `tests/draft2020-12/optional/`. The 8 non-passing optional
cases (4 mismatch + 4 error):

| File                    | Status                                                    |
| ----------------------- | --------------------------------------------------------- |
| `defs.json`, `ref.json` | 4 errors, external / cross-document ref loading.          |
| `cross-draft.json`      | 1 mismatch, same ref-loading root.                        |
| `format-assertion.json` | 2 mismatches, requires meta-schema loading via `$schema`. |
| `vocabulary.json`       | 1 mismatch.                                               |

All other optional files pass, including `dynamicRef.json` since #663.

The per-format subtree (`optional/format/*.json`) has its own runner,
`pnpm format-suite`, because `suite:optional` cannot measure it. The
subtree is 822 cases across 21 formats, of which 425 expect a rejection.
By spec default and ours, `format` is annotation-only, so those 425
vacuously fail for every implementation that follows the default: a
Bowtie run across ajv, hyperjump, boon, go-jsonschema and
python-jsonschema returned the same failures for all of them, with zero
divergence between any two. That run was made at the 2026-08-05 pin,
when the subtree was 720 cases, and has not been repeated since. Its
shape carries over; its count does not. No published comparative format number exists for
anyone, which is why this one is measured locally.

`format-suite` compiles with the OpenAPI 3.1 dialect, which promotes
`format` to an assertion, and scores **761/822**. It
reports the two directions separately, because they carry different
consequences: 40 **false accepts** (we allowed a value the format
forbids, a missed catch) and 21 **false rejects** (we refused a value
the format allows, which under the OpenAPI dialects refuses live
traffic).

The gap is concentrated rather than spread. `hostname` and
`idn-hostname` are 58 of the 61 failures and are almost entirely
IDNA / UTS-46 rules, deliberately punted (#669). The other three are
`email` accepting a domain that ends in a dot and rejecting a lowercase
`ipv6:` tag in an address literal (#944), and `idn-email` rejecting a
domain label that is not in Unicode NFC.

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
