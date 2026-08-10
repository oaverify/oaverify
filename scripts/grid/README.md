# The parameter grid: differential checking across revisions

```bash
pnpm grid-check              # this working tree against main
pnpm grid-check <rev>        # against any revision
pnpm grid-check <rev> --keep # leave the dumps and the worktree in place
```

Generates ~5,100 requests across the parameter surface, runs them against a
build of the base revision and a build of the working tree, and triages every
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

## The grid holds no opinion

Many cells are nonsense: `style: deepObject` on a `type: string` parameter,
`?p=0x1A` against `type: boolean`. They stay in.

A case earns its place by being a _probe_. Whatever the validator does with a
nonsense cell, it should keep doing until someone changes it on purpose.
Filtering down to combinations that "make sense" would encode one reading of
the OpenAPI serialization rules into the thing meant to detect changes in that
reading, which is how #742 got three review passes deep.

So there are no expected values here and no baseline to maintain. The grid
produces inputs, the dump records what happened, the diff compares two dumps.
There is no oracle at this layer and this harness does not pretend to be one.

## Coverage

4 locations x their legal styles x `explode` x 17 schema shapes, against 25
query / 13 path / 6 header / 5 cookie wire inputs. 306 declarations, 5,100
cases, a few seconds per side once both are built.

Known gaps, each a decision rather than an oversight:

- **OpenAPI 3.0 and 3.2.** 3.1 only. 3.0 spells nullability with `nullable`,
  so the schema set has to fork per version before those can be added.
- **Request bodies and response validation.** The grid is parameters only.
- **`content`-typed parameters** and **`allowReserved`.**
- **Exactly one parameter is declared per document, always.** So the grid
  cannot see a defect where one parameter captures another's input, which is a
  real class: matrix and label both assign by position, and whether the name
  label is honoured is a separate question the grid never asks.

### The coverage is weighted away from real documents

Worth knowing before trusting a clean run. Counting parameters in
`detection/real-world/specs` (301 published documents, 56,555 parameters):

| declared `style`   | share of real parameters | share of this grid          |
| ------------------ | ------------------------ | --------------------------- |
| none declared      | 92%                      | **0%**                      |
| `form` / `simple`  | 7%                       | some                        |
| `deepObject`       | 0.65%                    | some                        |
| `matrix` / `label` | **0%**                   | a third of the declarations |

`explode` is unset on 94% of real parameters and always set here. 87% of real
documents are 3.0 and this grid is 3.1 only.

The largest hole is that leaving `style` and `explode` unset is a different
code path: the library resolves the default before deserializing anything. A
hand-written or generated corpus reaches for the declared form by habit, so
that path is untested no matter how many cases the grid runs. By the rule two
sections up, it is this grid's own held-constant.

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
