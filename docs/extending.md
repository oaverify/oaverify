# Extending the compiler

Recipes for adding to `@oaverify/core/schema`: new keywords, new string formats,
new output formats. The canonical contract for each lives in TSDoc on
the relevant type; this page is the worked procedure.

## Add a new keyword

1. Create `packages/schema/src/keywords/<area>.ts` exporting a
   [`KeywordDefinition`](../packages/schema/src/keywords/types.ts) with
   `keyword`, `vocabulary`, and `compile(ctx)`. The flags on the
   definition drive compiler specialization; set them correctly or
   optimizations silently mis-fire. See the TSDoc on `applicator`,
   `annotation`, and `evaluates` for what each does and what breaks
   when it's wrong.
2. Add it to the vocabulary's `keywords` array in `vocabulary.ts`.
3. Re-export from `keywords/index.ts` and top-level `src/index.ts`.
4. Add `test/keyword-<name>.test.ts` that compiles a schema, validates
   good + bad data, and asserts on `code` / `path` / `params` /
   `children` structure. Never assert on generated code strings.
5. Add an entry to `BuiltInErrorParams` in
   `packages/core/src/errors.ts` describing the new error `code` and
   the shape of its `params`. The compiler can't check this (errors
   are emitted through generated JS source), so it's the documented
   contract consumers narrow against; drift here is a silent bug.

### The compile context

`compile(ctx)` receives a
[`KeywordCompileContext`](../packages/schema/src/keywords/types.ts),
whose TSDoc is the field-by-field reference. Read it there rather than
here; what is worth knowing before you open it is that its members fall
into three groups, and that a leaf keyword needs one of them.

**Intent helpers**, which is what you are almost certainly writing.
Where you are (`schema`, `parentSchema`, `data`, `path`, `errors`),
emitting (`gen`), descending (`validateSubschema`, and
`compileSubschema` / `compileAndCallSubschema` when you need the
sub-validator's verdict), failing (`emitError`, `errorStatement`,
`leafErrorExpr`, `branchErrorExpr`), asking (`formatTypeOf`,
`declineImplements`) and paying less (`hoistConstant`, `scopeLocal`,
`emitBudgetBreak`). These say what the keyword means and emit source
that is right for whichever mode the compile is in.

**Mode flags**: `predicate`, `flat`, `gated`, `depthGated`,
`unevaluatedTracking`. Skip these. They are for keywords that inspect a
sub-validator's return value, whose type changes with the mode;
`composition.ts`, `ref.ts`, `object-validation.ts`, `discriminator.ts`
and `items.ts` are the only files that read one. A leaf keyword
branching on a flag is a sign the intent helper it wanted already
exists.

**Raw mechanism**: `resolveRef`, `isRecursiveRef`, `resolveDynamicRef`,
the dynamic-scope names, the unevaluated-tracking vars, `pathSegments`,
`effectivePathExpr`, `appendErrorsStatement`, `budgetBreakStatement`.
Emitter-level, one or two readers each, and each names its readers in
its own TSDoc.

For scale: `string.ts` and `number.ts` between them use `data`,
`schema`, `gen`, `emitError`, `leafErrorExpr`, `hoistConstant` and
`formatTypeOf`, and read no flag. That is the shape of a leaf
keyword.

Four cross-cutting behaviors change how `compile` is written.

### Validating `ctx.schema`

`ctx.schema` is whatever the schema author wrote. It is not checked for
you, so casting it is a bug waiting to happen:

```ts
const names = ctx.schema as string[]; // don't
```

A bare string survives that cast and then iterates as its own
characters, which is exactly how `required: "id"` came to demand
properties `"i"` and `"d"` while rejecting `{ "id": 1 }`. Nothing looks
broken from outside; the validator just enforces a contract nobody
wrote.

Declare the contract once with `validateKeywordValue`, and the compiler
checks it across the whole schema before generating any code:

```ts
export const myKeyword: KeywordDefinition = {
  keyword: "myKeyword",
  vocabulary: MY_VOCAB,
  validateKeywordValue: (value) =>
    Array.isArray(value) ? undefined : `requires an array; got ${typeof value}`,
  compile(ctx) {
    const names = parseMyValue(ctx.schema);
    // ...
  },
};
// keyword "myKeyword" at "properties.a.myKeyword" requires an array; got string
```

Return `undefined` to accept, or a short reason to reject; the compiler
supplies the keyword name and the path. Two rules:

- **Keep the check in `compile` too**, or have both call one shared
  parser. `compile` is reachable through paths that did not go through
  the pre-pass, and a cast justified by "the pre-pass guarantees it" is
  the same reasoning that produced `required: "id"`.
- **Keyword-local contracts only.** Anything that needs an ancestor, a
  sibling, or the whole document belongs in a lint pass. This hook
  cannot see them, and a rule that pretends otherwise is wrong under
  `not` and inside dead composition branches.

For values that land in generated source, use the guards. Each
validates, then returns a value safe to interpolate, and names the
keyword in its error:

| Helper                      | Requires                          |
| --------------------------- | --------------------------------- |
| `numberLiteral`             | a finite number                   |
| `nonNegativeIntegerLiteral` | an integer >= 0                   |
| `positiveNumberLiteral`     | a finite number > 0               |
| `stringArrayValue`          | an array of strings               |
| `checkStringArray`          | (non-throwing half, for the hook) |
| `quoteString`               | (escapes a string literal)        |

All six live on the `/internals` subpath, not on `@oaverify/core/schema`
itself:

```ts
import { stringArrayValue } from "@oaverify/core/schema/internals";

const names = stringArrayValue(ctx.schema, "myKeyword");
```

`/internals` is deliberately outside the semver contract, which is the
trade a keyword author is making: these are the compiler's own helpers,
and adding a keyword means reaching into codegen either way. A minor
release may change them.

Prefer throwing at compile time over emitting a validator that cannot
be satisfied. An author who wrote something impossible wants to hear it
when they build the validator, not from a 400 on production traffic
whose message points at the payload.

### Error budget (`maxErrors`)

The `kind` argument on `ctx.emitError` / `ctx.errorStatement` carries
the budget semantics:

- `ctx.emitError("leaf", expr)`: a fresh leaf error, created in this
  call. Counts against the `maxErrors` budget; short-circuits cleanly
  once the cap is hit.
- `ctx.emitError("lift", expr)`: an already-counted error being
  propagated up (a sub-validator's return value), or a branch wrapper
  around already-counted children. Always unconditional, never touches
  the counter.

Using the wrong kind silently miscounts errors against the budget.
TypeScript enforces that you pass one of the two names; the
correctness of the choice is on you. Put `ctx.emitBudgetBreak()` at
the tail of hot loops (array items, property keys, applicator
branches) so they stop once the cap is exhausted.

### Verdict safety under a finite budget

A finite `maxErrors` must never change a valid/invalid verdict. It caps
how many errors are _reported_ and nothing else. Honoring that is what
makes the short-circuit conditional rather than unconditional.

The short-circuit is unsafe under evaluated-key tracking. A cap can
exhaust mid-evaluation and either starve a real error or truncate a
sub-validator's evaluated-key set, which flips an `unevaluated*`
verdict. So `CompileState.gated` is
`finite maxErrors && !unevaluatedTracking`: a schema using
`unevaluatedProperties` / `unevaluatedItems` collects every error and
the cap is not enforced. `unevaluated*` never appears in OpenAPI, so
the HTTP fast path is unaffected.

Codegen is specialized so that `maxErrors: Infinity` emits source
identical to the un-budgeted path, at zero overhead. Relatedly,
`contains` tests membership with a predicate sub-validator, so its
discarded per-item errors never charge the budget.

### Predicate mode

`compileSchema(schema, { output: "predicate" })` compiles a `{ validate:
(data) => boolean }` validator that builds no error tree: leaves don't
allocate, paths aren't snapshotted, messages aren't formatted, and
every failure short-circuits to `return false;`. Generated
subfunctions drop the `path` parameter.

Most keywords get this for free: `ctx.emitError`,
`ctx.validateSubschema`, and `ctx.emitBudgetBreak` all collapse to the
predicate form automatically. You only branch on `ctx.predicate` when
your keyword reads a sub-validator's return value for its own control
flow: the composition keywords (`allOf`, `anyOf`, `oneOf`, `not`,
`if`/`then`/`else`, `dependentSchemas`), plus `contains`,
`discriminator`, `$ref`, and `$dynamicRef`. In predicate mode those
sub-validators return `boolean` (not `ValidationError | null`) and
take no `path` argument, so the call-expression shape changes. See
`allOfKeyword` in
[`packages/schema/src/keywords/composition.ts`](../packages/schema/src/keywords/composition.ts)
for the canonical two-branch pattern.

Predicate mode is mutually exclusive with a finite `maxErrors`; the
compiler throws if both are set (predicate already short-circuits on
the first failure, so there's nothing to count).

## Add a new format

1. Add the validator to `packages/formats/src/<area>.ts`.
2. Export it from `packages/formats/src/index.ts`.
3. Add it to the `builtInFormats` record. A string format is the bare
   predicate; a format constraining numbers is
   `{ type: "number", validate }`, because a format's JSON type is a
   property of the format and is never inferred from its name. A strict
   variant shipped alongside a permissive built-in stays out of this
   record; see below.
4. Test with RFC-sourced valid + invalid examples.

### Which specification the validator follows

**Lean permissive; allow strict.** The built-in is the reading that
does not reject correct input. Where a stricter reading exists, ship
it as a named export and say in the TSDoc which document each one
follows. The costs are asymmetric: a false reject fails a request that
works today, while a false accept leaves the caller where they were
before the validator existed. So where the registry, the cited RFC and
real traffic disagree, the built-in follows whichever admits the
traffic, and the strict reading stays one line away (#705 has the full
rationale).

`byte` is the worked case. The registry cites RFC 4648, which admits
whitespace only where the referring specification says so; MIME wraps
base64 at 76 columns and it decodes to the same bytes. So
`validateByte` strips whitespace, and `validateByteRfc4648` is the
literal reading, registered by hand with
`formats: { byte: validateByteRfc4648 }`. No new option is needed for
a strict variant, which is why this is a naming convention rather than
a feature; `formats: { <name>: false }` remains the way to keep a name
as an annotation that asserts nothing.

Two things that are easy to miss:

- **The TSDoc has to say what the validator does not assert, and which
  document it follows.** `int64` sets the standard: it accepts the
  safe-integer range rather than the int64 range, and says so and why.
  `byte` accepts non-canonical trailing pad bits, and names the RFC it
  reads permissively. A format whose name overclaims relative to its
  predicate is worse than no format, because the name is what a reader
  trusts.
- **A name in the [OpenAPI Format Registry](https://spec.openapis.org/registry/format/)
  is described in three places that must agree.** Adding it to
  `builtInFormats` removes it from what `@oaverify/check`'s format pass
  reports, since `KNOWN_FORMATS` derives from the map. But the prose
  lists of not-yet-implemented names in `packages/formats/README.md` and
  `docs/configuration.md` are hand-maintained, and nothing fails when
  they drift. Update both. If the name is genuinely unassertable
  instead, add it to `NOT_ASSERTABLE` in
  `packages/check/src/format-check.ts` so the report says so rather than
  implying a later release will cover it.

Newly asserting a format that a real document already uses changes
verdicts on live traffic, so it belongs in the migration guide for the
next major, not only in the changelog.

## Add a new output format

Output-format dispatch lives in `@oaverify/core` (not the CLI) so library
consumers can render by format name too. Programmatic callers can also
pass a renderer function directly (`formatError(err, (e) => ...)`)
without forking the switch.

1. Add the name to `KNOWN_OUTPUT_FORMATS` in
   `packages/core/src/format-output.ts`. The `OutputFormat` type and
   the CLI's Commander `--format` validator both derive from it.
2. Add the rendering function to `packages/core/src/format.ts` (or
   emit straight from the leaves).
3. Add a branch to `formatError()` in
   `packages/core/src/format-output.ts`.
4. Add a test in `packages/core/test/format-output.test.ts`.

## Document specification boundaries

Read this guide when changing specification-dependent behavior or its TSDoc
tags. The tags generate the [user-facing inventory](spec-boundaries.md).

`@specCites <url>` identifies a declaration's intended specification
contract. `@specBoundary <kind> [<url>]` records a specification-related
choice or departure.

State the observable behavior, the relevant specification requirement,
and the reason for the current behavior if known. Distinguish an
intentional policy from a defect awaiting repair. An explanation of
existing behavior does not establish that it should be retained.

```ts
/**
 * RFC 9562 `uuid`.
 *
 * @specCites RFC 9562 section 4, https://www.rfc-editor.org/rfc/rfc9562#section-4
 * @specBoundary under-asserts https://www.rfc-editor.org/rfc/rfc9562#section-4.1
 * A UUID with an undefined version is accepted if it has the expected
 * shape: hexadecimal digits in groups of 8-4-4-4-12, separated by
 * hyphens. The validator does not restrict the bits identifying its
 * version or variant.
 */
```

The six kinds, each answering "how does our behaviour differ from the
cited text?":

| kind            | meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `under-asserts` | accepts what the cited spec forbids                                 |
| `narrows`       | rejects what the cited spec allows                                  |
| `transforms`    | changes the value handed on, which can affect subsequent validation |
| `chooses`       | the spec grants latitude, and this picked one option                |
| `resolves`      | the spec is silent or self-contradictory, and this picked a reading |
| `defers`        | the cited spec requires it and this does not implement it yet       |

Kinds describe behavior, not disposition or severity. An `under-asserts`
entry can be an intentional compromise or a false acceptance awaiting
repair. A `chooses` entry can describe conforming behavior. Pending
repairs need issue links regardless of kind; priority and release
scheduling belong in issues and the backlog.

Authoring rules:

- **A boundary is measured against the spec the declaration cites**,
  not against every spec in the neighbourhood. `duration` implements
  RFC 3339 Appendix A, which is what JSON Schema 2020-12 section 7.3.1
  defines the format against, so it is conformant and carries no
  boundary. Describing it as "stricter than ISO 8601" invented a
  boundary against a spec we never claimed, and a reviewer read that
  as a defect.
- **`@specBoundary` requires a `@specCites`**, and must carry its own
  section URL where the declaration cites several specs. Each `@specCites`
  carries exactly one URL; each `@specBoundary` carries at most one.
  Repeat the tag for another citation or boundary.
- **`chooses` requires latitude you can quote.** Point at the MAY,
  SHOULD or OPTIONAL that grants it, or at an explicit grant in the
  spec's own words: OpenAPI's "In case of ambiguous matching, it's up to
  the tooling to decide which one to use" is latitude, though it carries
  no RFC 2119 keyword. What the rule rejects is an unquotable claim that
  the spec probably allows it. If nothing in the text grants the
  decision, the kind is `resolves`.
- **`defers` carries an issue reference.**

`pnpm check:spec-boundaries` checks tag structure, specification hosts,
unambiguous anchors, nonempty prose and issue references. Review must
establish that the cited text supports the claim and grants any stated
latitude. The gate cannot establish those facts or find omitted boundaries.

**Put the tags last in the block**, after every other paragraph and
beside `@public`. A block tag runs until the next one, so a
`@specBoundary` followed by ordinary prose swallows it, and the
generated page prints that prose as part of the departure. Six of the
first pass's tags did this; `checkSpec`'s absorbed the whole dialect
section.

**Write boundaries for an average developer.** The generated inventory is
linked from the README, so readers need no deep knowledge of the specs or
this implementation. Lead with the affected input and observable result;
use a short example when it makes the consequence clearer. Then explain
the relevant spec rule and any available option or workaround. Keep terms
of art where they add precision, and explain unfamiliar ones on first use.

Each entry must stand alone in the generated page: avoid "the paragraphs
above", unexplained internal names, or reasoning available only in another
entry. Distinguish skipping one check from accepting the whole input.
Include implementation details only when they help the reader understand
the effect or make a decision. Explain an intentional policy concisely;
avoid defending every limitation or making unsupported claims about other
validators. Read the regenerated page as well as the source comment.

The tags are for behaviour relative to a cited specification. A design
decision that is not spec-relative (a linear route scan, a frozen empty
array) is ordinary prose, and tagging it dilutes the set.

`@specCites` is the only way to say "this is the spec I implement";
`@see` keeps every other kind of pointer. That split is what lets the
gate check citations without guessing, and it is why every format
validator's `@see` moved. Coverage is required in `packages/formats`
only, where every exported `validate*` must cite; elsewhere a
declaration is free to carry neither tag.

The tags generate [spec-boundaries.md](spec-boundaries.md),
which collects the documented choices and departures for users. Edit the tag and run
`pnpm docs:boundaries`; the page is never edited by hand and
`pnpm lint` fails if the two disagree.

A citation establishes the intended contract. A missing boundary does
not establish that the implementation meets it. Document known departures;
tests and review provide evidence of conformance.

When maintaining specification-dependent behavior:

- Check the applicable citation when changing behavior, and update or
  remove affected boundaries.
- Verify a newly discovered departure against the cited text and a
  reproducer before classifying it.
- Distinguish accepted policies from pending repairs and link the latter
  to their issues.
- When a defect is fixed, remove the obsolete limitation and regenerate
  the page. Keep any remaining boundary accurate.
