# The AOT parity grid

A generated differential between `oaverify compile-spec`'s emitted
module and `createValidator(document)` on the same document and the same
request. It gates: `pnpm vitest run packages/cli`.

```bash
pnpm vitest run packages/cli/test/aot-parity-grid.test.ts
AOT_GRID_REPORT=1 pnpm vitest run packages/cli/test/aot-parity-grid.test.ts   # print the report on a pass too
```

19,712 cases from 1,393 declarations in ~800ms.

| file             | what it holds                                           |
| ---------------- | ------------------------------------------------------- |
| `cases.ts`       | the generator: documents, and the wire inputs for each  |
| `run.ts`         | drives both sides, records the five channels below      |
| `gate.ts`        | the accounting: which differences an entry accounts for |
| `divergences.ts` | the registry of differences this gate accepts           |

## What a green run does not certify

`createValidator` is not an independent authority. `emit-spec.ts` was
written by copying `validate-step.ts` and its comments say so
throughout, so the two implementations are correlated by authorship and
**a defect present in both is invisible here by construction**. This is
the blindness `scripts/grid/README.md` documents for metamorphic
relations, and the one behind #753, where 21,420 cases passed on a
commit carrying a request-breaking regression because both spellings
were broken identically.

A green run means the two implementations agree. It does not mean either
is right. It is not a conformance result, and no case here cites a
specification.

## Two products, not one cross-product

The defects this exists to catch sit in two places that do not interact
across most of their cells.

**Product A**, parameter deserialization: one `get` operation, no
security, 3.1, every parameter axis crossed. Folded into one document
per location, so each location is one compile.

**Product B**, request-level dispatch: a deliberately boring parameter
set, with the document shape crossed instead. Not folded, because here
the document shape is the thing under test.

Crossing the two fully would multiply ~5,000 parameter cases by ~16
document shapes to re-derive one short-circuit thousands of times. The
interactions worth cells are enumerated instead: today that is
`security` against a parameter that fails its schema, which is the only
place to see whether both sides gate _before_ recording a value.

### Axes

Product A: location x (style x explode, including either field left
undeclared) x 17 schema shapes x `required` x (`schema` | `content`)
x `allowEmptyValue`, against the per-location wire tables.

Product B: declared methods driven by five HTTP methods; `security`
undeclared / operation / document / both / operation-empty, each against
the runtime's `validateSecurity` in both settings; a runtime option with
no emitter counterpart, each shape run at the default and with the
option set; one parameter and two
contending in one location; parameters named `constructor`, `__proto__`
and `toString`, in all four locations, against an empty frame and a
supplied value; OpenAPI 3.0, 3.1 and 3.2; and 3.2's `style: cookie`.

`runtimeOptions` is an axis over the **runtime's own options**, not the
document. The emitted module takes no options at all, so every option
`createValidator` accepts is a place the two sides can disagree by
configuration rather than by defect, and #895 is exactly that shape.
Crossing `validateSecurity` is what makes both halves of #895 visible:
without it the grid sees only the half where the AOT is stricter and
reports the issue as covered.

## The grid holds no opinion

Many cells are nonsense: `style: deepObject` on a `type: string`
parameter, `?p=0x1A` against `type: boolean`. They stay in. A case earns
its place by being a probe, and filtering to the combinations that
"make sense" would encode one reading of the serialization rules into
the instrument meant to detect changes in that reading. Same rule as
`scripts/grid`, same reason (#742).

## The registry, and why it is not a hiding place

`divergences.ts` holds the differences this gate accepts. An entry does
not excuse a case; **an entry asserts what the difference is**, and four
rules keep it that way. `gate.ts` enforces the first three at run time.
The fourth is the shape of `DivergenceEntry` itself, so `pnpm typecheck`
is what rejects it.

1. An entry matching no case fails the run, so a fixed defect cannot
   leave a stale exemption behind.
2. A **listed signature** no case produced fails the run too. Entry-level
   staleness is not enough once an entry lists several: fix two
   locations of a four-location defect and the entry still matches while
   two dead signatures wait in the registry for the next difference
   shaped like them. With multiple signatures, the signature is the
   exemption.
3. A case an entry claims whose observed signature the entry does not
   list fails the run. Widening an entry is a visible edit to a
   signature rather than a predicate quietly growing.
4. `open-defect` and `intentional` are separate kinds, and an
   `intentional` entry has to say why the difference is correct.
   `DivergenceEntry` is a union of the two rather than one interface
   with an optional `why`, so an unjustified `intentional` entry does
   not compile. It was prose here and in `divergences.ts` before it was
   a rule anything applied, which is this instrument's own failure mode
   one level up.

Predicates read the structured axes of a case, never its id: an id
changes whenever the generator gains an axis, which is exactly when
nobody wants to rewrite the table.

`gate.ts`'s rules are themselves tested, on synthetic cases, in
`../aot-grid-gate.test.ts`.

## The first run

The registry was written from this run, and not before it. Reproducing
it is one edit: empty `DIVERGENCES` and run.

```
grid: 19688 cases from 1381 declarations in 761ms
  verdict      13 differing,     0 signed by an entry,    13 unexplained
  leaves       30 differing,     0 signed by an entry,    30 unexplained
  value        13 differing,     0 signed by an entry,    13 unexplained
  operation     2 differing,     0 signed by an entry,     2 unexplained
  16 unexplained signature(s):
    x2  A|query|-|explode=-|json-obj|required=false :: validJson
    x2  A|query|-|explode=-|json-obj|required=false :: schemaInvalidJson
    x2  A|query|-|explode=-|json-obj|required=false :: notJson
    (the same three for path, header and cookie: 12 signatures)
    x2  B|methods=get :: HEAD
    x2  B|security=operation|runtime=off :: noCredential
    x1  B|security=document|runtime=shape :: noCredential
    x1  B|security-vs-bad-parameter|runtime=shape :: badParamNoCredential
```

Those are #903 (twelve signatures, four locations x three payloads),
#899, and #895 by three separate routes. The grid was not told about any
of them.

Two things that run settled:

- **#903 is the JSON parse step, not `content` as a whole.** A
  `text/plain` `content` parameter agrees on both sides, because the
  emitter compiles the content schema and a raw string reaches it
  unchanged. The three JSON payloads fail in three different channels,
  which is why the registry carries three entries rather than one.
- **The value channel earns its place.** `content-json/valid-payload`
  and `security/gate-ordering` both differ in ways a verdict comparison
  reports as agreement or as noise.

## What this does not replace

`compile-spec.test.ts` keeps every one of its blocks, including
`describe("compile-spec: equivalence vs createValidator")`.

The reading that the grid would subsume that block does not survive
looking at it: one of its nine tests is about parameters, and the other
eight are request bodies, response headers, content-type message
wording, `detectedVersion`, `warnings` and `getOperation` shape, all of
which this grid excludes by scope. The parameter one pins the codes for
a required parameter named `constructor`, which is a claim about what
the answer should be, and by `scripts/grid/README.md`'s rule a case
asserting a required answer needs a citation and a human and does not
belong in a differential.

What the grid adds there is the differential half of the same class: the
hostile-name cells above put those names under the comparison, where the
pinned test says what the answer has to be.

## Five channels

`verdict`, `leaves`, `value`, `operation`, `error`.

`leaves` are `(code, path)` tuples with `path` kept as the array the
validator produced. Joining it on `.` would make `["query", "a.b"]` and
`["query", "a", "b"]` compare equal, and a name containing a dot is
legal, so the flattened form can call an attribution mistake identical.

`error` carries the message of a `throw` or a `build-error`. Two sides
refusing the same document for unrelated reasons agree on the verdict
and are not the same event. The wording comes from two independently
written implementations, so a difference here is expected to need an
entry rather than to be a defect by itself, and the entry is where a
human says which it is. No case reaches it today.

## Coverage gaps

Each a decision rather than an oversight. This list is part of the
instrument: a gap nobody wrote down reads as coverage.

- **Product A is 3.1 only.** 3.0 spells nullability with `nullable`, so
  the 17 schema shapes fork per version. 87% of real published documents
  are 3.0 (`scripts/grid/README.md`), so the deserialization surface
  this exercises hardest is the one it exercises on the least common
  version. Product B carries 3.0 and 3.2 with string-schema parameters
  only.
- **Request bodies and response validation are absent.** Requests only,
  parameters and dispatch.
- **The runtime-option axis lives in product B only.** Product A runs at
  `createValidator`'s defaults throughout, so an option that changes
  parameter deserialization is measured against one boring parameter
  rather than across the parameter surface. Crossing it into product A
  would multiply ~1,300 declarations by each option; the shapes in
  product B are hand-built to make each option decide the answer
  instead. `strictQueryParameters` is the one where that trade is
  visible, since product A's wire table sends undeclared query keys in
  several cells.
- **`allowReserved` is absent**, as it is from the runtime grid.
- **No `$ref`-ed parameters or path-item-level parameters.** Every
  declaration is inline on the operation.
- **The wire lexemes and the 17 schema shapes are a copy**, seeded from
  `scripts/grid/cases.mjs` at `9577133`. That module is a review aid and
  deliberately not a gate; importing it would make an edit there an edit
  to this gate. The cost is that the two sets can drift and nothing will
  notice.
- **Product A folds, so a refused document costs a location.** One
  declaration the compiler rejects takes its whole location's document
  with it, where one document per declaration would have recorded a
  single `build-error` cell. No declaration does today.
- **`getOperation` is compared; `validateResponse` and the `Fetch`
  wrappers are not.**
