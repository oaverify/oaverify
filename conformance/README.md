# @oaverify-dev/conformance

Runs oaverify against upstream conformance corpora and reports verdict
parity, flagging every mismatch. Four targets:

- The canonical
  [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
  against `@oaverify/internal-schema`, both the required suite and the
  `optional/format` subtree.
- The [JSONTestSuite](https://github.com/nst/JSONTestSuite) parser corpus
  against `@oaverify/stream`'s SAX tokenizer.
- The
  [OpenAPI Overlay 1.0 test suite](https://github.com/OAI/Overlay-Specification)
  against the envelope schema (compiled through `@oaverify/internal-schema`)
  plus `@oaverify/internal-overlay-spec`'s translator.
- Hand-curated OpenAPI request/response scenarios against the built
  `oaverify` CLI.

## What it needs

- **Its own `pnpm install`.** A separate pnpm root; these deps are not in
  the main workspace install.
- **`pnpm corpora`**, which fetches all three upstream corpora at the
  revisions pinned in `corpora.json`. Needs network the first time. The
  checkouts are gitignored and total ~225 MB at depth 1, nearly all of
  it JSONTestSuite (the two schema corpora are ~9 MB together).
- **A prior root `pnpm build`** for `pnpm openapi` only, which drives
  `packages/oav/dist/cli.js` as a subprocess. It errors telling you so if
  the binary is absent.

The fetch script is `pnpm corpora`, not `pnpm setup`: `setup` is one of
pnpm's own built-in commands and silently shadows a script of that name.

## Run

```bash
cd conformance
pnpm install
pnpm corpora                        # all three corpora at their pins
cd .. && pnpm build                 # only needed for `pnpm openapi`

cd conformance
pnpm check                          # typecheck + the five gating runners, as CI runs them
pnpm suite                          # JSON Schema Test Suite (required only)
pnpm suite:optional                 # + optional/ suite (format edge cases, etc.)
pnpm suite -- --filter=ref          # just files matching "ref"
pnpm format-suite                   # optional/format under an asserting dialect
pnpm format-suite -- --filter=uri   # just files matching "uri"
pnpm parse                          # JSONTestSuite parser corpus vs the stream tokenizer
pnpm parse -- --filter=number       # just files matching "number"
pnpm overlay                        # OpenAPI Overlay 1.0 envelope + translator
pnpm openapi                        # CLI-driven OpenAPI scenarios
pnpm corpora:stale                  # which pinned corpora are behind upstream
pnpm typecheck
```

`pnpm corpora:json-schema` / `:json-parse` / `:overlay` fetch one at a
time (~12k schema cases, ~318 parser cases, ~32 overlay fixtures).

## What it gates

Every runner here gates pull requests, in the `conformance` job, which is
a required check on `main`. `pnpm check` is the same set locally.

The four baseline runners (`suite`, `format-suite`, `parse`, `overlay`)
take `--check-baseline`, the form CI uses: it compares against the
committed results file and fails on a regression rather than on any
single mismatch. `openapi` has no baseline and takes no flags; it fails
on any mismatch. What counts as a regression differs per runner,
deliberately:

| Runner         | Fails when                                                      |
| -------------- | --------------------------------------------------------------- |
| `openapi`      | **any** case mismatches; there is no baseline to drift from     |
| `suite`        | the total pass count drops below baseline                       |
| `format-suite` | any single format's false accepts, false rejects or errors grow |
| `parse`        | the pass count drops, or the mismatch count grows               |
| `overlay`      | the envelope-pass or translator-ok count drops                  |

`format-suite` also fails on **improvement**: a case that starts passing
is good news the baseline has not been told about, so the run tells you to
ratchet it. Exit code 2 throughout means "could not measure" (missing
corpus, drifted pin, missing baseline) rather than "regressed".

`pnpm corpora:stale` is the exception: it exits 0 whether or not a pin is
behind, because being behind is expected most of the time. The scheduled
`pins` workflow passes `--fail-if-stale`, where the exit code is what
colours the badge.

The PR gate never reaches the network: CI caches the corpora keyed on
`corpora.json`, so a required check does not depend on GitHub's git
endpoints being up.

Two things run nightly instead, because the pin cannot answer them:

- `pnpm corpora --latest JSON-Schema-Test-Suite` fetches that corpus at
  upstream HEAD, and `suite` / `format-suite` run with `--floating`. That
  swaps the strict ratchet for the classification in
  [`floating.ts`](./floating.ts), which separates "we regressed" from
  "upstream added cases we fail" by whether the unit's case count grew.
  Without that split the nightly is noise and gets muted. The other two
  corpora have no floating runner, deliberately: both are frozen enough
  upstream that the staleness check is their radar, and their
  measurement happens at the pin bump.
- `pnpm corpora:stale --fail-if-stale`, as above.

Neither blocks a pull request, and they run in separate workflows so that
one red means one thing. A failure of the `nightly` workflow opens or
updates one labelled issue, because a red scheduled workflow notifies
almost nobody. A stale pin gets no issue (that is the expected state much
of the time) and shows on the `pins` badge in the root README instead.

## Reading the results

A per-file table on stdout, plus raw JSON per runner:

| File                                     | Tracked?                                          |
| ---------------------------------------- | ------------------------------------------------- |
| `json-schema-results.json`               | committed baseline                                |
| `format-results.json`                    | committed baseline                                |
| `json-parse-results.json`                | committed baseline                                |
| `overlay-results.json`                   | committed baseline                                |
| `openapi-results.json`                   | gitignored, no baseline                           |
| `json-schema-results-with-optional.json` | gitignored; the optional suite is a moving target |

See [`REPORT.md`](./REPORT.md) for a current analysis of what passes, what
fails, and whether each divergence is design, documented limitation, or a
bug worth fixing.

## What the less obvious runners assert

**`parse`** drives `@oaverify/stream`'s SAX tokenizer over JSONTestSuite's
`y_`/`n_`/`i_` corpus. The tokenizer's contract is to match `JSON.parse`,
so the oracle for every case is `JSON.parse` rather than the filename
label. The suite also asserts the verdict is chunk-invariant (single-shot
against a split feed) and that accepted values reconstruct to the same
value `JSON.parse` produces. The streaming-specific replay at every byte
boundary lives in `packages/stream-validator/test/tokenizer.test.ts` and
runs under the root `pnpm test`; this suite adds corpus breadth.

**`format-suite`** is separate from `suite:optional` because `format` is
annotation-only under the default dialect. Run that way, every
`"valid": false` format case passes without asserting anything, and 368 of
the 720 cases expect a rejection, so `suite:optional` is not a measurement
of format behaviour at any pass rate it reports. `format-suite` compiles
with `openapi31Dialect`, where `format` is an assertion, and splits the two
directions because they carry different consequences:

- **false accept**: we allowed a value the format forbids. A missed catch.
- **false reject**: we refused a value the format allows. Under the
  OpenAPI dialects this refuses live request and response traffic, so it
  is the more serious direction.

## The pin, and why there is a second half

The checkouts are gitignored, so the revision each committed baseline was
measured against lives in `corpora.json` and nowhere else. Every runner
that compares against a baseline asserts its checkout is at the pin and
refuses to report numbers otherwise. A floating clone is how a measurement
recorded in an issue and a measurement from a fresh clone come to disagree
with nothing in the repo to point at.

A pin alone would trade that problem for a worse one: a frozen corpus
means every run goes green forever while upstream adds cases we have never
been measured against, so the conformance claim ages silently.
`pnpm corpora:stale` is the other half. It asks upstream for its HEAD and
reports which pins are behind and what landed. The pin is the gate; that
is the radar.

So bumping is a deliberate act: change `rev`, run `pnpm corpora`, and
re-measure the affected baselines in the same commit. Expect a bump to add
failures. That is the reason to look.

## Cross-checking against other implementations

[`bowtie/`](./bowtie) runs the same engine through
[Bowtie](https://docs.bowtie.report/), which drives every JSON Schema
implementation over one protocol. That answers a question this package
cannot: when a case fails, whether the rest of the ecosystem agrees with us
or with the suite. It needs Docker and the `bowtie` CLI rather than a
`pnpm install`, and it is not part of `pnpm test`. See its README.

## Where to add new cases

- **Schema-level**: upstream. The harness reads
  `JSON-Schema-Test-Suite/tests/draft2020-12/*.json` as-is. Add schemas
  there only if you're upstreaming; prefer to express schema corners in
  `packages/schema/test/`.
- **HTTP-level**: create `openapi-cases/<group>/spec.yaml` plus
  `cases.json`. Each case is
  `{name, kind: "request"|"response", method, path, ..., expect: "valid"|"invalid", expectCodes?: string[]}`.
  The runner spawns the CLI, diffs exit code + leaf error `code`s.
- **Overlay-level**: upstream. The harness reads
  `Overlay-Specification/tests/v1.0/{pass,fail}/*.yaml` as-is. Add
  fixtures there only if you're upstreaming. Translator coverage for
  specific JSONPath shapes belongs in
  `packages/overlay-spec/test/translate.test.ts`.
