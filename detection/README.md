# Detection corpus

Which OpenAPI defects does each tool actually catch?

Counting findings does not answer that. Spectral ships dozens of style
rules and oaverify ships a handful of correctness rules, so a
finding-count table measures rule inventory and nothing else. It is also
the mistake that made oaverify's own `required-not-in-properties` rule
look useful while running at 2.6% signal (77 findings, 2 true positives
across 13 published specs) before #503.

So this corpus is labelled instead. Each case is a minimal OpenAPI
document carrying exactly one seeded defect, and a tool scores only when
it reports _that_ defect.

## Run

```bash
pnpm install
pnpm --dir .. build        # oaverify runs through its built CLI
pnpm detect
```

Writes three files to `results/`:

| file        | contents                                          |
| ----------- | ------------------------------------------------- |
| `matrix.md` | the detection matrix and per-class totals         |
| `audit.md`  | for every scored cell, the finding that scored it |
| `raw.json`  | every tool's complete output, unmodified          |

`audit.md` is the point. A matrix whose cells cannot be traced back to
what the tool actually said is a marketing asset, not a measurement.

## Classes

| class        | what it holds                                             |
| ------------ | --------------------------------------------------------- |
| `malformed`  | the schema is not a schema; constraints are silently lost |
| `lint`       | valid schema, behaviour that will surprise its author     |
| `structural` | not a valid OpenAPI document                              |
| `style`      | conventions and hygiene, outside oaverify's stated scope  |
| `control`    | nothing is wrong; any finding here is a false positive    |

The `style` and `control` classes are what keep this honest. `style`
exists so the corpus can show oaverify losing, and it does. `control`
holds the shapes that made the old `required` rule noisy, so a
regression toward over-firing shows up as a false positive rather than
as a better-looking score.

## Reading the result

Tools are not interchangeable and the matrix is not a ranking. Spectral
and Redocly are OpenAPI document linters; oaverify checks whether a spec
will validate traffic the way its author intended; Ajv does not lint
specs at all, so the comparable operation is compiling each schema the
document carries with `strict` and `strictRequired` on. That is a
deliberate choice about what to measure, and it is the only reason Ajv
appears in a spec-linting table.

`total findings raised` counts everything each tool said across the
whole corpus, including the four clean controls. It is not a score. A
tool with more rules legitimately says more. It is there because it is
what a reader has to wade through to reach the finding they needed.

## Methodology limits

Read these before quoting a number.

- **Signal matching is substring-based.** A case declares the strings
  that identify its defect, and one finding matching one signal scores
  the cell. Signals have to be discriminating (`"nam"` quoted, so it
  cannot match `name`) or a generic "schema is invalid" scores
  everywhere. Every match is recorded in `audit.md`; a cell that is not
  in there did not happen.
- **A miss can be a wording mismatch.** Redocly reports several
  malformed cases as `Expected type array but got integer` without
  naming the keyword, so matching also considers each finding's
  location pointer. Before that fix Redocly scored 2/6 on `malformed`
  rather than 5/6. If a tool catches something and the matrix says
  otherwise, the signals are wrong, not the tool.
- **Default rulesets only.** Spectral runs `spectral:oas` and Redocly
  its built-in defaults. Both are configurable, and a tuned ruleset
  would score differently. The comparison is about what each tool gives
  a reader out of the box.
- **Seeded fixtures, not prevalence.** These are minimal documents with
  one planted defect each. They show what a tool _can_ catch, not how
  often the defect occurs, and not precision against real-world noise.
  A labelled real-world pass would answer that and is not done here.
- **Versions move.** Results are from the versions in `package.json` at
  the time of the run. Nothing here is wired into CI, because a matrix
  that turns red when Spectral ships a rule is noise.

## What it found

Building the corpus turned up a real bug in oaverify:
`silent-rewrite/ref-siblings-oas30` never fires when the `$ref` sits at
a body-schema root, because the validator unwraps root refs before the
lint runs (#505). It fires correctly one level down. That is the same
root-unwrap behaviour that hid a true positive from the `required` rule
in #503, from the other side.

Finding that was worth more than the table.
