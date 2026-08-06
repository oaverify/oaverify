# @oaverify-dev/detection

Which OpenAPI defects does each tool actually catch? A labelled corpus of
minimal documents, each carrying exactly one seeded defect, run through
oaverify, Spectral, Redocly and Ajv.

Counting findings does not answer that question. Spectral ships dozens of
style rules and oaverify ships a handful of correctness rules, so a
finding-count table measures rule inventory and nothing else. It is also
the mistake that made oaverify's own `required-not-in-properties` rule look
useful while running at 2.6% signal (77 findings, 2 true positives across 13
published specs) before #503.

So this corpus is labelled instead, and a tool scores only when it reports
_that_ case's defect.

## What it needs

- **Its own `pnpm install`.** A separate pnpm root; these deps are not in
  the main workspace install.
- **Three competing tools**, installed here as dev dependencies:
  [`@stoplight/spectral-cli`](https://github.com/stoplightio/spectral),
  [`@redocly/cli`](https://github.com/Redocly/redocly-cli) and
  [`ajv`](https://github.com/ajv-validator/ajv). Each runs on its default
  ruleset; see Methodology limits.
- **A prior root `pnpm build`.** oaverify is exercised through its built
  CLI, not through its source, so `pnpm --dir .. build` has to have run.

## Run

```bash
cd detection
pnpm install
pnpm --dir .. build        # oaverify runs through its built CLI
pnpm detect

pnpm check                 # typecheck only; see below
pnpm typecheck
```

`pnpm check` runs the typecheck and stops there. `pnpm detect` rewrites the
three committed files below, and a command called `check` should not leave a
dirty working tree.

## What it gates

Nothing. This is not wired into CI, deliberately: the matrix would turn red
whenever Spectral ships a rule, which is noise rather than a regression.
`results/` is committed so a change in the matrix shows up as a reviewable
diff instead of a number somebody has to re-derive.

## Reading the results

`pnpm detect` writes three files to `results/`:

| file        | contents                                          |
| ----------- | ------------------------------------------------- |
| `matrix.md` | the detection matrix and per-class totals         |
| `audit.md`  | for every scored cell, the finding that scored it |
| `raw.json`  | every tool's complete output, unmodified          |

`audit.md` is the point. A matrix whose cells cannot be traced back to what
the tool actually said is a marketing asset, not a measurement.

Tools are not interchangeable and the matrix is not a ranking. Spectral and
Redocly are OpenAPI document linters; oaverify checks whether a spec will
validate traffic the way its author intended; Ajv does not lint specs at
all, so the comparable operation is compiling each schema the document
carries with `strict` and `strictRequired` on. That is a deliberate choice
about what to measure, and it is the only reason Ajv appears in a
spec-linting table.

`total findings raised` counts everything each tool said across the whole
corpus, including the four clean controls. It is not a score. A tool with
more rules legitimately says more. It is there because it is what a reader
has to wade through to reach the finding they needed.

## Why some cells are deliberately empty

The corpus is only worth reading if it can show oaverify losing, so two
`structural` cases exist to record exactly that:
`dangling-discriminator-mapping` and `undeclared-server-variable`. Both
need a graph walk. Document conformance validates a node against a
subschema and cannot ask whether a name resolves, so no amount of
meta-schema coverage reaches them, and `misses` is the correct entry rather
than a gap to close.

The `style` class carries the same load in the other direction: six cases
oaverify mostly does not report. "Mostly" is doing real work there. Some
are conventions (a missing `operationId`), and oaverify having no opinion is
the point. But it catches two, and one of those, `undeclared-path-param`, is
a specification violation rather than a matter of taste: a path template
naming a variable the operation never declares means unvalidated input
reaches the handler. `check` reports it at `error` severity for exactly that
reason.

So read the empty cells in `style` as "outside oaverify's scope", not as
"not a real problem". The class name predates the severity field and is the
looser of the two labels.

## Classes

| class        | what it holds                                             |
| ------------ | --------------------------------------------------------- |
| `malformed`  | the schema is not a schema; constraints are silently lost |
| `lint`       | valid schema, behaviour that will surprise its author     |
| `structural` | not a valid OpenAPI document                              |
| `style`      | conventions and hygiene, outside oaverify's stated scope  |
| `control`    | nothing is wrong; any finding here is a false positive    |

The `style` and `control` classes are what keep this honest. `style` exists
so the corpus can show oaverify losing, and it does. `control` holds the
shapes that made the old `required` rule noisy, so a regression toward
over-firing shows up as a false positive rather than as a better-looking
score.

## Methodology limits

Read these before quoting a number.

- **Signal matching is substring-based.** A case declares the strings that
  identify its defect, and one finding matching one signal scores the cell.
  Signals have to be discriminating (`"nam"` quoted, so it cannot match
  `name`) or a generic "schema is invalid" scores everywhere. Every match is
  recorded in `audit.md`; a cell that is not in there did not happen.
- **A miss can be a wording mismatch.** Redocly reports several malformed
  cases as `Expected type array but got integer` without naming the
  keyword, so matching also considers each finding's location pointer.
  Before that fix Redocly scored 2/6 on `malformed` rather than 5/6. If a
  tool catches something and the matrix says otherwise, the signals are
  wrong, not the tool.
- **Default rulesets only.** Spectral runs `spectral:oas` and Redocly its
  built-in defaults. Both are configurable, and a tuned ruleset would score
  differently. The comparison is about what each tool gives a reader out of
  the box.
- **Seeded fixtures, not prevalence.** These are minimal documents with one
  planted defect each. They show what a tool _can_ catch, not how often the
  defect occurs, and not precision against real-world noise. A labelled
  real-world pass would answer that and is not done here.
- **Versions move.** Results are from the versions in `package.json` at the
  time of the run.

## What it found

`cases/lint/ref-siblings-oas30.yaml` was the one case oaverify should have
caught and did not. Chasing it turned up a validation bug well past the
missing warning: the body-schema transform followed a root `$ref`
unconditionally, so under OpenAPI 3.1, where `$ref` siblings are part of
the schema, `{ $ref: Pet, required: [name] }` at a body root silently
stopped enforcing `required`. Fixed in #505.

Worth recording how that went, because the corpus nearly buried it. The
first diagnosis was wrong, and a probe written to test it appeared to clear
oaverify: the request came back invalid, which looked like the sibling being
enforced. It was a `content-type` error, and the schema had never been
compiled. The second probe printed the error codes instead of the verdict,
and the real behaviour showed up immediately.

Assert on the reason, not the verdict. A test that only checks
`valid === false` passes for any reason at all, including the fix being
absent, and one of the tests shipped with that fix had to be rewritten for
exactly that.
