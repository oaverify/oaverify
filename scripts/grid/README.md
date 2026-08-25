# The parameter grid: differential checking across revisions

```bash
pnpm grid-check              # this working tree against main
pnpm grid-check <rev>        # against any revision
pnpm grid-check <rev> --keep # leave the dumps and the worktree in place
```

Generates every request in the parameter grid (see [Coverage](#coverage) for
the count, which `gridSize()` is the source of), runs them against a build of
the base revision and a build of the working tree, and triages every
difference. This is the R3 relation from
[#753](https://github.com/oaverify/oaverify/issues/753).

It is a **review aid, not a gate**. A deliberate behaviour change lands in the
regression bucket, which is correct and expected. Nothing in CI runs it.

## What it is not

A conformance corpus. There are no expected values here and no specification
citations, so **a clean run means "nothing changed", never "this is correct".**
Both revisions being wrong the same way is a clean run.

That distinction decides where new cases belong. This grid grows by adding a
dimension to the generator, which is cheap and yields hundreds of cases at
once. A case that asserts what the specification requires needs a quoted
citation and a human to write it, and it does not belong here. Cross-
implementation conformance testing is expected to arrive as its own suite
rather than as a mode of this one.

## Why this exists

The defects that dominated the July/August 2026 fix run shared a shape: one
meaning reached by two code paths, and the paths had drifted. Conformance
testing does not catch that class. It replays documented cases against an
external authority, so it answers "do we agree with the specification here",
not "did our own change alter behaviour nobody wrote a case for".

The cautionary result is in #753. A metamorphic relation over `type` member
order ran 21,420 cases and found nothing, on a commit carrying a
request-breaking regression, because both spellings were broken identically. A
consistency check is blind to any defect symmetric under its own
transformation. The differential is what found it.

On the broad #742 fix this read 80 regressions / 448 fixes / 288 silent
changes; on the narrowed fix, 0 / 160 / 0. That contrast is what made the
narrowing defensible rather than merely smaller.

## The buckets

| bucket       | meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `regression` | base valid, head invalid. Read this first.                           |
| `fix`        | base invalid, head valid. Usually intended; confirm each one.        |
| `silent`     | both valid, different deserialized value.                            |
| `shape`      | both invalid, different error codes.                                 |
| `crash`      | a throw or refused build appeared or disappeared.                    |
| `drift`      | a case exists on one side only, so the two dumps are not comparable. |

`silent` is the bucket no other gate shows. A request that still passes while
arriving at the handler as a _different value_ is exactly what
[#751](https://github.com/oaverify/oaverify/issues/751) shipped:
`?filter[n]=0x1A` reached the handler as `26`. Running `pnpm grid-check main`
from that fix's branch reproduces it, with `main`'s `{"p":{"n":26}}` sitting in
the base column.

It is also the one bucket that can be switched off, and the summary line says
`silent off` rather than `silent 0` when it is. The value channel arrived with
`returnValues` in
[#745](https://github.com/oaverify/oaverify/issues/745), so a base older than
that has nothing to compare and the bucket cannot run. Comparing against the
last release tag is exactly that case, which is the invocation a release
sign-off reaches for: `pnpm grid-check oaverify-v6.0.0` reports `silent off`,
and `pnpm grid-check 2f74122` (the `#745` merge) is how to get the bucket back
over the same window.

`off` and `0` are one character apart in a tally and mean opposite things:
"nothing changed" against "nobody looked".

## The grid holds no opinion

Many cells are nonsense: `style: deepObject` on a `type: string` parameter,
`?p=0x1A` against `type: boolean`. They stay in.

A case earns its place by being a _probe_. Whatever the validator does with a
nonsense cell, it should keep doing until someone changes it on purpose.
Filtering down to combinations that "make sense" would encode one reading of
the OpenAPI serialization rules into the thing meant to detect changes in that
reading, which is how #742 got three review passes deep.

## Coverage

2 OpenAPI versions x 4 locations x their legal styles _and unset_ x `explode`
unset/false/true x the version's schema shapes, against 28 query / 17 path / 8
header / 7 cookie wire inputs. 1,248 declarations, 23,328 cases, well under a
second per side once both are built.

Known gaps, each a decision rather than an oversight:

- **OpenAPI 3.2.** 3.1 and 3.0 are generated.
- **Request bodies and response validation.** The grid is parameters only.
- **`content`-typed parameters** and **`allowReserved`.**
- **Exactly one parameter is declared per document, always.** So the grid
  cannot see a defect where one parameter captures another's input, which is a
  real class: matrix and label both assign by position, and whether the name
  label is honoured is a separate question the grid never asks.

### What the weighting looks like now

Worth knowing before trusting a clean run. Counting parameters in
`detection/real-world/specs` (301 published documents, 56,555 parameters):

| declared `style`   | share of real parameters | share of declarations |
| ------------------ | ------------------------ | --------------------- |
| none declared      | 92%                      | 31%                   |
| `form` / `simple`  | 7%                       | 31%                   |
| `deepObject`       | 0.65%                    | 8%                    |
| `matrix` / `label` | **0%**                   | 15%                   |

Until #766 the "none declared" row read 0% here and `matrix` / `label` took a
third of the declarations. Both moved by adding cells rather than deleting
any: `matrix` and `label` keep every case they had, and are simply no longer
most of the budget. The grid is still weighted well away from real documents,
and deliberately: a probe earns its place by being a probe, and rare shapes
are where the defects have been.

Two things the unset cells are for, since the first one is easy to
misread:

- **Leaving `style` and `explode` unset is a different code path**, because
  the library resolves the default before it deserializes anything. Writing
  `style: form` out and omitting `style` are therefore separate cells even
  though they should agree.
- **They agree today.** All 1,740 unset-style-and-explode cells produce a
  byte-identical result to the corresponding written-out default. That is the
  expected answer and not a wasted dimension: default resolution had no cell
  at all before, so a regression in it could not have been seen here. The
  point of a differential cell is to exist before it is needed.

### What the 3.0 half does and does not reach

87% of the real corpus is 3.0, which is why 3.0 is generated rather than
treated as a variant of 3.1. What differs is the compiler: 3.0 compiles under
`oas30Dialect`, a different `type` keyword plus `nullable` and boolean
`exclusive*`. Parameter _deserialization_ has one version-dependent branch and
it only fires for a `$ref`'d parameter schema, which this grid does not
generate, so the 3.0 half earns its place through the schema table or not at
all.

That is worth stating precisely, because most of it does not:

- **`nullable` is inert here.** No wire input can produce a JSON `null`, so
  `strNull` behaves exactly as `str` under 3.0 in all 714 comparable cells,
  and likewise for `intNull` and `arrNull`. The cells are future-change
  detectors, not a test of `nullable`.
- **`exclMax` is what makes the fork visible.** It is spelled per version
  (`exclusiveMaximum: 10` in 3.1, `maximum: 10` plus `exclusiveMaximum: true`
  in 3.0) and the two report different codes for the same request:
  `exclusiveMaximum` against `maximum`. 3.0 also gets `exclMaxNumeric`, the
  3.1 spelling in a 3.0 document, where the keyword is currently **ignored**
  and `?p=1000` is accepted against a bound of 10.
- Without those, 3.0 and 3.1 agreed on every one of the 8,568 comparable
  cells, which is the state this section exists to stop anyone assuming.

Nullability in 3.0 is a flag rather than a union member, so it has no order to
vary: `strNull` and `nullStr` collapse to one cell, and the null-first ids are
the ones absent. `strInt` / `intStr` are absent by choice rather than
necessity, since 3.0 has `anyOf`; spelling them by hand would test our reading
of a translation nobody writes.

## Running the halves separately

`grid-check` orchestrates; the two halves are usable on their own.

```bash
pnpm build
pnpm grid:dump out.json [--root <checkout>]   # record one side
pnpm grid:diff base.json head.json [--limit N] [--bucket regression]
```

`--root` names the checkout to load oaverify from, so one copy of the harness
drives any revision without that revision needing to contain it.

The dump drives the **public `@oaverify/core` surface against the built
`dist`**, never `packages/*/src`. A revision being diffed may not share our
module layout, so the public API is the only stable handle across revisions.
It also means the same script can drive another OpenAPI validator through its
own public API with the wire format unchanged, which is what a cross-library
comparison would need.

`grid-check` symlinks `node_modules` into the base worktree when the lockfile
is identical between the two revisions, and installs when it differs.
