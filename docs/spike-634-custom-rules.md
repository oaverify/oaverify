# Spike: custom rules for oaverify (#634)

Status: spike outcome, not a shipped feature. The prototype lives on
`spike/custom-rules-634` and exists to prove or kill the design.

## Recommendation

**Build it, and scope the claim to composition.**

The extension point is worth having. The reason usually given for it is
wrong, and shipping it under that reason would be a mistake.

- Do **not** sell this as a rules engine or a Spectral replacement. It
  is less expressive than Spectral and always will be.
- Do sell it as the one thing Spectral cannot give a team already
  running `oaverify check`: their house-policy findings in **one report,
  one exit code, one SARIF upload, one severity grammar, and addresses
  that were verified against the resolved document**.
- A rule that needs compiler knowledge should become a built-in, not
  stay a house rule. #645 is that having already happened once.

## What the issue got wrong, and what is actually missing

The report says the five house rules stayed in-house "not because they
are hard, but because there is no way to express them to the engine."
Measured on `main` at `e251b65`, expressiveness is not the gap.
`resolveSpec`, `resolveJsonPointer`, `sourceOf`, `walkSubschemas`,
`lintResolvedSpec` and `checkDocumentExamples` are all public, and every
one of the reported rule shapes is plain JS over the object `resolveSpec`
returns.

The ask decomposes into two halves:

1. **Express the rule.** Already solved.
2. **Grade, address and report the finding.** Not solved at all.

Only (2) is missing, and noticing that is what determines the shape of
the answer: solve (2) properly and (1) needs no framework, because the
user writes a plain function and the extension point's whole job is to
run it and grade what comes back.

This is why the design has **no DSL, no ruleset format and no targeting
language**. A declarative format is an answer to (1), the half that was
never broken.

## The shape

```
oaverify check spec.yaml --rules ./house-rules.mjs
```

```js
export const rules = [
  {
    code: "x-acme/operation-needs-owner", // family must start with "x-"
    severity: "error", // optional, default "warning"
    *run(ctx) {
      // ctx.document      the resolved document, after overlays
      // ctx.knownFormats  what this run's compiler validates
      yield { pointer: "/paths/~1pets/post", message: "no x-owner" };
    },
  },
];
```

A rule returns `{ pointer?, message, severity? }`. That is the whole
contract. See `packages/cli/src/custom-rules.ts` for the types, which
are the reference per "type as canonical contract".

## The hard cases, answered

### (i) Loading user code against the security posture

The boundary:

> oaverify executes code the **invoker** names, and never code a
> **document** names.

`--rules ./house.mjs` is typed into a shell by the person whose shell it
is, which is the same trust level as `node ./house.mjs`. A remote `$ref`
is named by a document that arrived from somewhere, which is #587's case.
The two are different acts.

What makes the boundary hold is what is absent:

- No config file, no cosmiconfig, no walk-up discovery. Discovery is the
  hazard: it turns "I cloned a repo and ran a linter" into arbitrary code
  execution. An explicit flag has never had that property.
- No `x-oaverify-rules` extension read from a spec or an overlay.
- The path is resolved as a filesystem path, so `--rules https://...`
  cannot fetch. The reader that _can_ fetch never sees it.

The cost, taken deliberately: there is no config file, so the flag is
repeated in CI. That is the price of the boundary.

**What `--only` does not guarantee.** Deselecting `custom` stops rules
running. It does not stop modules being imported, because their codes
must register for `--severity`. Module top-level code runs whenever
`--rules` is present.

### (ii) User codes against the closed registry (#641)

The registry stays closed. It closes **later**.

Codes are `x-<namespace>/<name>`. `parseSeverityMap` takes the loaded
rules' codes, so `--severity x-acme/typo=error` is still refused. #641's
property was "reject a key that grades nothing", not "the set is a
compile-time constant".

`--severity` parses in two passes, split on the `x-` prefix. Every
built-in key is validated **before any module is imported**, so a typo
in a CI flag still fails ahead of the side effect. Only an `x-` key
defers, and it must: the module is what defines whether that key is a
typo. The reserved prefix earns its keep twice, for collision avoidance
and for this split.

`custom` is the one class with no entry in `CODES_BY_CLASS`. An entry
would have to be empty (and false) or open (and unable to reject a typo).

### (iii) Class assignment

A new class, `custom`, rather than a label a rule picks from the existing
five. `class` means "which pass found this", and letting a rule declare
`conformance` would make `--only conformance` a command whose name says
nothing about the user code it runs.

Two halves of one rule: **a report never claims the custom class ran when
it could not.**

- Unnamed with no `--rules`: quietly out of the default set, so
  `check: no findings (...)` does not list a class that could not run.
- Named with no `--rules`: a usage error (exit 3). Exit 0 and
  `no findings (custom)` reads as "the house rules passed" when no house
  rule ran, and a dropped `--rules` in a CI edit is how that happens.

### (iv) Addressing is a contract

A rule supplies a pointer and nothing else. `class`, `severity`,
`location`, `target.anchor` and `target.source` are all derived. The
four-referent contract is therefore **structurally unavailable to get
wrong**: the only referent a rule can supply is the one it is in a
position to know.

A supplied pointer is resolved against the document before it is
accepted. An unresolvable one stops the run naming the rule, rather than
being reported. A target that resolves nowhere is the failure that field
exists to prevent, and "usually accurate" is the outcome being avoided.

Nothing in the source-addressing pass needed changing: a custom finding
gains `target.source` from the same loop that gives a hygiene finding one.

### (v) Custom keywords versus custom rules: two systems

They do not merge. Custom keywords are schema-level, run per value, on
traffic, and change what `validate` accepts. Custom rules are
document-level, run once, never on traffic.

> Does your rule decide whether a **payload** is acceptable, or whether
> the **document** is acceptable?

Payload is a keyword. Document is a rule. Unifying them would require a
document rule to run per request. (Interaction with #349 noted, not
pursued.)

### (vi) The "Spectral but worse" test

Answered directly, and the answer is narrower than #634 assumes.

Spectral has JSONPath targeting, rulesets, inheritance, formats,
overrides and a published ecosystem. This design has none of that and
should not pretend to. On expressiveness, a team should use Spectral.

The evidence from the acceptance cases is worth stating plainly, because
it cuts against the issue:

- Five of the six reported rules are house policy that Spectral expresses
  at least as well.
- The sixth is the only one that needed oaverify-specific knowledge, and
  **#645 shipped it as a built-in**, so the reporter no longer needs a
  custom rule for it.

That is a real argument for not building this, and it is why the
recommendation is scoped rather than enthusiastic. What survives it:
those five findings still have to reach one report with one exit code
and verified addresses, and a team already running `oaverify check` in
CI would otherwise run two tools and glue two JSON files together.

The line between built-in and custom follows from the same evidence:
**a rule reaching for compiler knowledge is a rule that wants to be a
built-in.** The prototype's `x-acme/format-must-validate` and the
built-in `format-not-validated` fire on the same node, which is that
line demonstrated rather than asserted.

## Coverage (brief §3e)

Every cell is covered by a test in
`packages/cli/test/custom-rules-acceptance.test.ts`.

|                              | can express                         | reaches CLI | addressed                     | graded                        | `--only` | SARIF                   |
| ---------------------------- | ----------------------------------- | ----------- | ----------------------------- | ----------------------------- | -------- | ----------------------- |
| set-operation over document  | JS rule                             | `--rules`   | pointer, then target + source | rule / finding / `--severity` | `custom` | rule + result           |
| regex over a field           | JS rule                             | `--rules`   | pointer, then target + source | same                          | `custom` | rule + result           |
| business rule, external data | JS rule (reads a file or a service) | `--rules`   | pointerless, `<document>`     | same                          | `custom` | result, `locations: []` |
| compiler knowledge (formats) | `ctx.knownFormats`                  | `--rules`   | pointer, then target + source | same                          | `custom` | rule + result           |
| reject the whole document    | pointerless finding                 | `--rules`   | none, contractually           | `fatal`, gated by `--fail-on` | `custom` | result, no location     |

**The last row, on exit 4.** A custom rule may be graded `fatal` and
never produces exit 4. Exit 4 means the compiler could not compile the
document, which is a fact rather than a severity; `--severity` can
already promote a finding to `fatal` without touching it. A fatal custom
finding trips `--fail-on fatal` into exit 1. No change was needed, and
routing it to exit 4 would have been the mistake.

## Alternatives considered

**A declarative rule file (the brief's §9 sketch).** Rejected. It dodges
hard case (i) by executing nothing, and then fails the acceptance cases:
the business rule needs external data, so the format grows IO and
becomes a query language, which is Spectral's ground.

**`--merge-findings <file.json>`: accept findings from any tool, grade
and render them.** The strongest runner-up. It executes no user code at
all, and it composes with a Spectral ruleset a team already has. It lost
on addressing: it imports addresses it cannot verify, and if the missing
piece is the four-referent contract, a design that accepts unverifiable
addresses has solved the wrong half. Worth revisiting if the goal ever
becomes report aggregation rather than one tool's report.

**Nothing at all, plus a documented recipe** for running your own checks
over `resolveSpec` and merging them into `check --format json` yourself.
This is what a consumer does today. It costs them a reimplementation of
severity mapping, `--only`, the `--fail-on` threshold, exit-code
arithmetic and the SARIF merge, per team, and it produces addresses
nothing validated.

## What shipping would need

- **#572** is the real home. The loader, the rule contract and the
  grading of a rule finding are business logic, and `packages/cli/src` is
  a thin renderer. The prototype puts them in the CLI deliberately, with
  the rule normalisation kept separate from the Commander wiring so the
  seam is where #572 would lift. This is a dependency, not a detail.
- Docs: `docs/extending.md` gains a rules section next to keywords,
  formats and output formats, saying plainly when to reach for Spectral
  instead.
- The `--rules` help text must say it executes local code. It does.

## Prototype

| sha       | what                                                                |
| --------- | ------------------------------------------------------------------- |
| `38718f9` | the rule contract and loader, no wiring                             |
| `2e819bb` | `--rules`, the `custom` class, the split severity parse             |
| `7d34502` | the six acceptance cases as a fixture module, plus two review fixes |
| `fb6ee22` | narrowed the `--only` guarantee to what holds                       |

Each passes `pnpm test`, `pnpm typecheck`, `pnpm lint` and
`pnpm lint:type-aware`, and the surface was exercised end to end from a
shell against the built binary as well as in-process.
