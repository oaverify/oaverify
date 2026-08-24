# @oaverify-dev/detection

Which OpenAPI defects does each tool actually catch? A labelled corpus of
minimal documents, each carrying exactly one seeded defect, run through
oaverify, Spectral, Redocly and Ajv.

Counting findings does not answer that question. Spectral ships dozens of
style rules and oaverify ships a handful of correctness rules, so a
finding-count table measures rule inventory. It is also the mistake that
made oaverify's own `required-not-in-properties` rule look useful while
running at 2.6% signal (77 findings, 2 true positives across 13 published
specs) before #503.

So the corpus is labelled, and a tool scores only when it reports _that_
case's defect.

## Results

`pnpm detect` writes three files to `results/`, all committed so a change
shows up as a reviewable diff:

| file        | contents                                          |
| ----------- | ------------------------------------------------- |
| `matrix.md` | the detection matrix and per-class totals         |
| `audit.md`  | for every scored cell, the finding that scored it |
| `raw.json`  | every tool's complete output, unmodified          |

`matrix.md` opens with the run date and the four tool versions that
produced it, read from the installed tree.

`audit.md` is the point. A matrix whose cells cannot be traced back to
what the tool actually said is a marketing asset rather than a
measurement.

The matrix is not a ranking, because the tools are not interchangeable.
Spectral and Redocly are OpenAPI document linters; oaverify checks
whether a spec will validate traffic the way its author intended; Ajv
does not lint specs at all, so the comparable operation is compiling each
schema the document carries with `strict` and `strictRequired` on. That
is the only reason Ajv appears in a spec-linting table.

`total findings raised` counts everything each tool said across the whole
corpus, including the four clean controls. A tool with more rules
legitimately says more, so it is not a score. It is there because it is
what a reader has to wade through to reach the finding they needed.

## Run

```bash
cd detection
pnpm install               # separate pnpm root; deps are not in the main workspace
pnpm --dir .. build        # oaverify runs through its built CLI
pnpm detect
```

The three comparators are dev dependencies here:
[`@stoplight/spectral-cli`](https://github.com/stoplightio/spectral),
[`@redocly/cli`](https://github.com/Redocly/redocly-cli) and
[`ajv`](https://github.com/ajv-validator/ajv).

`pnpm check` runs the typecheck and stops there, because `pnpm detect`
rewrites the three committed files and a command called `check` should
not leave a dirty tree.

The corpus is not re-run in CI. The matrix would turn red whenever
Spectral ships a rule, which is news rather than a regression.

What does gate CI is agreement: `pnpm check:detection-table`, wired into
the root `pnpm lint`, asserts that
[docs/comparison.md](../docs/comparison.md) still quotes what
`results/matrix.md` says. So a `pnpm detect` whose numbers move fails
the build until the doc follows.

## Classes

| class        | what it holds                                             |
| ------------ | --------------------------------------------------------- |
| `malformed`  | the schema is not a schema; constraints are silently lost |
| `lint`       | valid schema, behaviour that will surprise its author     |
| `structural` | not a valid OpenAPI document                              |
| `style`      | conventions and hygiene, outside oaverify's stated scope  |
| `control`    | nothing is wrong; any finding here is a false positive    |

`control` holds the shapes that made the old `required` rule noisy, so a
regression toward over-firing shows up as a false positive rather than as
a better-looking score.

## Where oaverify loses

Two `structural` cases record it: `dangling-discriminator-mapping` and
`undeclared-server-variable`. Both need a graph walk. Document
conformance validates a node against a subschema and cannot ask whether a
name resolves, so no amount of meta-schema coverage reaches them.

`style` is six cases oaverify mostly does not report, and oaverify does
not compete on style. Most of them are conventions, such as a missing
`operationId`. It catches three, and one of those, `undeclared-path-param`,
is a specification violation rather than a matter of taste: a path
template naming a variable the operation never declares means unvalidated
input reaches the handler. `check` reports it at `error` severity for
that reason.

## Methodology limits

Read these before quoting a number.

- **Signal matching is substring-based.** A case declares the strings
  that identify its defect, and one finding matching one signal scores
  the cell. Signals have to be discriminating (`"nam"` quoted, so it
  cannot match `name`) or a generic "schema is invalid" scores
  everywhere. Every match is recorded in `audit.md`; a cell that is not
  in there did not happen.
- **A miss can be a wording mismatch.** Redocly reports several malformed
  cases as `Expected type array but got integer` without naming the
  keyword, so matching also considers each finding's location pointer.
  Before that fix Redocly scored 2/6 on `malformed` rather than 5/6. If a
  tool catches something and the matrix says otherwise, the signals are
  wrong rather than the tool.
- **Default rulesets only.** Spectral runs `spectral:oas` and Redocly its
  built-in defaults. Both are configurable, and a tuned ruleset would
  score differently. The comparison is about what each tool gives a
  reader out of the box.
- **Seeded fixtures, not prevalence.** These are minimal documents with
  one planted defect each. They show what a tool _can_ catch, not how
  often the defect occurs, and not precision against real-world noise. A
  labelled real-world pass would answer that and is not done here.

`real-world/` is a separate, unlabelled pass over a few hundred published
specs. It is a lead generator for oaverify bugs, and it produces no
measurement; see its README.
