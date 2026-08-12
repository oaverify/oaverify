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
