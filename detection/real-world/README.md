# Real-world spec pass

A lead generator for finding oaverify bugs, pointed at a few hundred
published OpenAPI documents.

This is the opposite of the labelled corpus one directory up. There,
each document carries one known seeded defect and a tool either reports
it or does not, so a cell in the matrix means something. Here nothing is
known in advance, so nothing this directory produces is a measurement.
It sorts real specs into "worth a look" and "not", and every look has to
end at a hand-written reproducer before it becomes a claim. Three other
tools run alongside oaverify purely as a differential oracle; the output
is deliberately not a comparison table, because [#506] already covers
that ground with labelled cases.

[#506]: https://github.com/oaverify/oaverify/pull/506

## Run

```bash
pnpm --dir .. install      # shares the detection sub-root's deps
pnpm --dir ../.. build     # oaverify runs through its built CLI
./download.sh
node run.mjs               # ~40 min for ~300 specs across 4 tools
```

`run.mjs --tools oaverify` skips the comparators and finishes in about
two minutes, which is the loop worth using while chasing something.
`--limit N` takes the first N specs.

## Corpus

`download.sh` writes to `./specs/`, which is gitignored: the specs are
large, sometimes licensed, and this script regenerates them.

| source               | count | why                                                     |
| -------------------- | ----- | ------------------------------------------------------- |
| `$OAV_AUDITED_SPECS` | 13    | already audited, ground truth known. **Local only**     |
| large public specs   | 7     | GitHub, Stripe, Twilio, Box, Asana, DigitalOcean, Adyen |
| apis.guru            | ~293  | volume and variety                                      |

Only the last two are fetchable, so the corpus is about 300 specs on a
machine without the audited set and about 313 on the one that has it.
Counts in `results/` differ accordingly, which is the first thing to
check when a number moves.

The audited set is the harness's own test. It is expected to produce
exactly 5 `required-not-in-properties` findings and 3 exit-2 rejections,
2 of which carry no location ([#504] and the `policyinquiry` case in
[#512]). A run that disagrees means the harness broke, and that is worth
knowing before reading anything else.
It is skipped when `$OAV_AUDITED_SPECS` is unset and the default path is
absent, in which case the rest still runs.

`select-guru.mjs` picks the apis.guru sample: every 3.1 entry it has
(96, since 3.1 is where the interesting shapes are and apis.guru holds
few), then a 3.0 sample capped at 2 per provider and round-robined
across providers. Taking the first N alphabetically would produce a
corpus of Amazon and Azure.

Selection is deterministic given the same apis.guru index, so a finding
survives a re-run on an unchanged upstream. The index itself changes as
providers come and go, so two runs weeks apart measure different
populations and neither is wrong.

[#504]: https://github.com/oaverify/oaverify/issues/504

## Output

| file                    | contents                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `results/crashes.md`    | oaverify threw, timed out, or rejected without saying where |
| `results/leads.md`      | the two differential seams, generated                       |
| `results/triage.md`     | leads looked at and not filed, hand-written                 |
| `results/per-spec.json` | every tool's output, capped per spec                        |

**None of it is a baseline.** Every generated file opens with the count
and date it was measured on, because a bare `4 of 313 specs.` invites
the mistake it caused during the v7 review: a rule's finding count moved
and was nearly attributed to a code change when the corpus had moved
instead (#810). `specs/` is gitignored and `download.sh` re-selects from
live upstreams, so there is no revision to pin the way `conformance/`
pins its suites, and no CI job gates on these numbers. When a count
moves, rule out the corpus before reading anything into it.

`crashes.md` is the seam that needs no comparator and yielded the most.
An exit 2 with a located message is `check` doing its job and is not
listed.

`per-spec.json` keeps the first 25 findings per tool per spec and
records the number dropped in an `omitted` field on each entry. Uncapped
it is 26 MB, which is not a reasonable thing to put in a git history for
an artifact this script regenerates; capped it is 4 MB, and 439 of the
1252 tool runs are truncated (80,457 findings dropped, nearly all of
them Spectral and Redocly style rules firing per operation). The count
is always recorded, so a capped list can never be mistaken for a
complete one. Analysis that needs the full list re-runs the script.

## Reading the output

Two things will waste your time if you take them at face value.

**The harness is wrong before oaverify is.** Both scoring bugs in #506
were of this kind, and this pass added two more. `check --format json`
read through a pipe came back truncated, so three large specs appeared
to produce no findings at all; that turned out to be [#510] and the fix
here was to route the report through `-o`. Separately, the "is this
message located?" heuristic first scored the router's duplicate-route
rejections as unlocated, then, after being widened, matched the _prose_
of `expected one of "integer". Did you mean "boolean"?` and hid two
genuinely unlocated rejections. It now matches oaverify's own location
idioms and is checked against seven hand-labelled messages.

**A zero in the `crash` row is not reassuring.** The CLI catches throws
and reprints them as `check: <message>`, with no stack and usually no
type name, so an uncaught `TypeError` reaches this harness looking like
an ordinary exit 2. It lands in `rejected-unlocated` rather than
`crash`, which is where [#504] sits and where the `schemas.forEach is
not a function` failures behind [#512] would sit. Read the two rows
together.

**`leads.md` is mostly noise, by construction.** The in-scope filter is
a keyword heuristic over four tools' prose and it misjudges in both
directions. The Ajv column in particular is dominated by
`can't resolve reference`, which is an artifact of the sibling corpus's
probe rather than anything about the specs. `results/triage.md` records
which leads were followed and where each one stopped.

[#510]: https://github.com/oaverify/oaverify/issues/510

## What this pass found

Filed from this corpus, most to least urgent:

- [#512] the well-formed assertion never runs on nested `$ref` targets,
  so a malformed slot inside a component is accepted and its constraint
  dropped at runtime
- [#513] the schema lint never visits schemas behind a nested `$ref`;
  1 of Asana's 278 components is reachable by the rules today
- [#511] the `required` lint walk is exponential in `$ref` graph depth;
  `check` does not finish on Stripe's published spec
- [#510] piped stdout truncated at 64 KiB, silently, at exit 0
- [#514] no rule for enum members contradicting the sibling `type`
  (an enhancement, not a defect)

[#512] overlaps [#516], which arrived from an external usability report
while this pass was running and reaches the same cause from the
unlocated-message symptom alone.

No false positive was found in the whole corpus, which is the result the
`required-not-in-properties` rewrites were after.

[#511]: https://github.com/oaverify/oaverify/issues/511
[#512]: https://github.com/oaverify/oaverify/issues/512
[#513]: https://github.com/oaverify/oaverify/issues/513
[#514]: https://github.com/oaverify/oaverify/issues/514
[#516]: https://github.com/oaverify/oaverify/issues/516
