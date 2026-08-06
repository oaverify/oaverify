# @oaverify-dev/conformance

Conformance harness for oaverify. Runs three upstream / hand-curated
corpora:

- The canonical
  [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
  against `@oaverify/internal-schema`.
- The
  [OpenAPI Overlay 1.0 test suite](https://github.com/OAI/Overlay-Specification)
  against the envelope schema (compiled through `@oaverify/internal-schema`) plus
  `@oaverify/internal-overlay-spec`'s translator.
- A set of OpenAPI request/response scenarios against the built `oaverify`
  CLI.

Reports verdict parity and flags any mismatches.

This is a **standalone package** inside the monorepo. Its deps aren't
pulled by the main `pnpm install`; bootstrap it on its own:

```bash
cd conformance
pnpm install
pnpm corpora          # clones all three corpora at their pinned revisions
cd ..
pnpm build            # the OpenAPI runner shells out to packages/oav/dist/cli.js
```

`pnpm corpora:json-schema` / `:json-parse` / `:overlay` fetch one at a
time (~12k schema cases, ~318 parser cases, ~32 overlay fixtures).

The script is `pnpm corpora`, not `pnpm setup`, because `setup` is one
of pnpm's own built-in commands and shadows a script of that name.

## The pin, and why there is a second half

The checkouts are gitignored, so the revision each committed baseline
was measured against lives in `corpora.json` and nowhere else. Every
runner that compares against a baseline asserts its checkout is at the
pin and refuses to report numbers otherwise. A floating clone is how a
measurement recorded in an issue and a measurement from a fresh clone
come to disagree with nothing in the repo to point at.

A pin alone would trade that problem for a worse one: a frozen corpus
means every run goes green forever while upstream adds cases we have
never been measured against, so the conformance claim ages silently.
`pnpm corpora:stale` is the other half. It asks upstream for its HEAD,
reports which pins are behind and what landed, and exits non-zero so
the nightly `corpus-freshness` job surfaces it. The pin is the gate; that
is the radar.

So bumping is a deliberate act: change `rev`, run `pnpm corpora`, and
re-measure the affected baselines in the same commit. Expect a bump to
add failures. That is the reason to look.

## Commands

```bash
cd conformance
pnpm suite                          # JSON Schema Test Suite (required only)
pnpm suite:optional                 # + optional/ suite (format edge cases, etc.)
pnpm suite -- --filter=ref          # just files matching "ref"
pnpm format-suite                   # optional/format under an asserting dialect
pnpm format-suite -- --filter=uri   # just files matching "uri"
pnpm corpora:stale                  # which pinned corpora are behind upstream
pnpm parse                          # JSONTestSuite parser corpus vs the stream-validator tokenizer
pnpm parse -- --filter=number       # just files matching "number"
pnpm overlay                        # OpenAPI Overlay 1.0 envelope + translator
pnpm openapi                        # CLI-driven OpenAPI scenarios
```

The `parse` suite drives the stream-validator package's SAX tokenizer over
the [JSONTestSuite](https://github.com/nst/JSONTestSuite) `y_`/`n_`/`i_`
parser corpus. The tokenizer's contract is to match `JSON.parse`, so the
oracle for every case is `JSON.parse` (not the filename label); the suite
also asserts the verdict is chunk-invariant (single-shot vs. a split feed)
and that accepted values reconstruct to the same value `JSON.parse`
produces. The streaming-specific replay at every byte boundary lives in
`packages/stream-validator/test/tokenizer.test.ts` (run by `pnpm test`);
this suite adds the breadth of a real-world corpus.

`format-suite` is separate from `suite:optional` because `format` is
annotation-only under the default dialect: run that way, every
`"valid": false` format case passes without asserting anything, and 363
of the 720 cases expect a rejection. So `suite:optional` is not a
measurement of format behavior at any pass rate it reports.
`format-suite` compiles with `openapi31Dialect`, where `format` is an
assertion, and splits the two directions, which carry different
consequences:

- **false accept**: we allowed a value the format forbids. A missed
  catch.
- **false reject**: we refused a value the format allows. Under the
  OpenAPI dialects this refuses live request and response traffic, so
  it is the more serious direction.

`--check-baseline` gates per format rather than on the total, so a fix
in one format cannot pay for a regression in another, and it fails on
_improvements_ too: a case that starts passing is good news the
baseline has not been told about, so the run tells you to ratchet it.

Output: per-file table on stdout, raw JSON written to
`json-schema-results.json` / `format-results.json` /
`json-parse-results.json` / `overlay-results.json` /
`openapi-results.json`. `json-parse-results.json`,
`json-schema-results.json`, `format-results.json`, and
`overlay-results.json` are committed baselines that CI compares against
with `--check-baseline`; `openapi-results.json` and the `+optional`
JSON Schema variant are gitignored as moving targets.

## Cross-checking against other implementations

[`bowtie/`](./bowtie) runs the same engine through
[Bowtie](https://docs.bowtie.report/), which drives every JSON Schema
implementation over one protocol. That answers a question this package
cannot: when a case fails, whether the rest of the ecosystem agrees with
us or with the suite. It needs Docker and the `bowtie` CLI rather than a
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

## Latest results

See [`REPORT.md`](./REPORT.md) for a current analysis: what passes, what
fails, and whether each divergence is design, documented limitation, or
a bug worth fixing.
