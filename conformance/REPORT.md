# Conformance report

Generated 2026-06-19 against commit `b8d5dd7`.

Run against three upstream / hand-curated test corpora:

- **JSON Schema Test Suite**: the canonical draft-2020-12 cases at
  <https://github.com/json-schema-org/JSON-Schema-Test-Suite>,
  cloned into `conformance/JSON-Schema-Test-Suite/` by `pnpm setup`.
- **OpenAPI Overlay 1.0 Test Suite**: the envelope-schema fixtures
  at <https://github.com/OAI/Overlay-Specification>, cloned into
  `conformance/Overlay-Specification/` by `pnpm setup:overlay`.
- **OpenAPI cases**: hand-curated request/response scenarios under
  `conformance/openapi-cases/<group>/`, covering the petstore shape
  across 3.0, 3.1, and 3.2.

## Summary

| Source                                | Cases | Pass | Mismatch | Error | % pass |
| ------------------------------------- | ----- | ---- | -------- | ----- | ------ |
| JSON Schema Test Suite (required)     | 1290  | 1270 | 16       | 4     | 98.4%  |
| JSON Schema Test Suite (+ optional)   | 1452  | 1429 | 19       | 4     | 98.4%  |
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

The 20 non-passing required-suite cases (16 mismatch + 4 error) fall
into three groups.

### `$dynamicRef` with runtime dynamic scope (12 cases)

Partial implementation. Our `$dynamicRef` resolves statically against
the anchor map, so tests that rely on a `$dynamicRef` rebinding at the
outermost `$dynamicAnchor` encountered during validation fail
(`dynamicRef.json`). Documented in `CLAUDE.md`.

Fix path: maintain a runtime stack of `$dynamicAnchor` scopes during
validation, resolve `$dynamicRef` at call time.

### External / cross-document `$ref` loading (4 errors)

`defs.json` and `ref.json` surface 2 errors each where a referenced
document is not loaded into the schema map.

### Residual singletons (4 mismatches)

One mismatch each in `multipleOf.json`, `unevaluatedItems.json`,
`unevaluatedProperties.json`, and `vocabulary.json`.

## Optional-suite breakdown

Running with `--optional` widens to 1452 cases. The extra 162 cases
live under `tests/draft2020-12/optional/`. The 23 non-passing optional
cases (19 mismatch + 4 error):

| File                                                                                        | Status                                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `dynamicRef.json`                                                                           | 12 mismatches, the `$dynamicRef` runtime-scope group.     |
| `defs.json`, `ref.json`                                                                     | 4 errors, external / cross-document ref loading.          |
| `cross-draft.json`                                                                          | 1 mismatch, same ref-loading root.                        |
| `format-assertion.json`                                                                     | 2 mismatches, requires meta-schema loading via `$schema`. |
| `multipleOf.json`, `unevaluatedItems.json`, `unevaluatedProperties.json`, `vocabulary.json` | 1 mismatch each.                                          |

All other optional files pass. The per-format subtree (`optional/format/*.json`) isn't traversed by
our runner. Those tests target strict-format-assertion behavior; by
spec default and our default, format is annotation-only, so most tests
there would vacuously pass. Enabling format-assertion and running them
is a separate exercise: each format brings its own tail of RFC edge
cases that the suite tightens every few revisions.

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
pnpm setup                      # clones JSON-Schema-Test-Suite (gitignored)
pnpm setup:overlay              # clones Overlay-Specification   (gitignored)
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
