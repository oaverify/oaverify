# Strictness

Three different things in oaverify wear the word "strict", and they are
not variations of one setting. This page says which is which, so you can
tell what a given knob will and will not catch.

| Class                  | When it fires          | Controlled by                               | You get                       |
| ---------------------- | ---------------------- | ------------------------------------------- | ----------------------------- |
| **Malformed schema**   | Building the validator | Nothing. Always fatal.                      | A thrown error                |
| **Schema lint**        | Building the validator | `schemaLint`                                | Entries in `schemaLintIssues` |
| **Request strictness** | Every request          | `strictQueryParameters`, `validateSecurity` | Validation errors on traffic  |

## Malformed schema: always fatal

A document that is not a schema cannot be compiled into a validator, so
oaverify refuses rather than guessing. No option turns this off, including
`schemaLint: "off"`.

```ts
createValidator(spec); // throws
// GET /events 200 response body (application/json): "items" at
// "properties.events" must be an object or boolean; got an array.
// In JSON Schema 2020-12 the tuple form is "prefixItems"; an array-valued
// "items" is the draft-04 / Swagger 2.0 spelling.
```

This covers a schema-valued slot holding something that is not a schema
(`items: [ ... ]`, `if: null`) and a keyword holding a value it cannot
use (`type: "Boolean"`, `required: "id"`, `enum: 5`, `minimum: "5"`).
The check walks the whole document, so a typo in a `$defs` entry nothing
`$ref`s is caught along with the rest. Catch it with a `try` around
`createValidator`, not a check on each request; the common shapes are in
[configuration.md](./configuration.md#malformed-schemas-fail-at-construction).

## Schema lint: advice about a valid schema

`schemaLint` grades schemas that _are_ schemas. Findings are collected,
never thrown.

```ts
const validator = createValidator(spec, { schemaLint: "strict" });
validator.stats.schemaLintIssues;
// [{
//   code: "unknown-keyword",
//   keyword: "minimumx",
//   path: "properties.age",
//   schemaPath: ["properties", "age"],
//   pointer: "/paths/~1users/post/requestBody/content/application~1json/schema/properties/age",
//   anchor: "node",
//   location: "POST /users request body (application/json)",
//   message: ...
// }]
```

Four fields say "where", and each answers a different question:

- `pointer` addresses the resolved **document** (RFC 6901). Present when
  the caller said where the compiled schema sits, which `createValidator`
  always does. Absent below an external `$ref` or an anchor, which name a
  schema but no position in this document.
- `schemaPath` addresses a position inside the **compiled schema**, as
  segments. Absent once a `$ref` has been crossed, since no segment list
  spans a ref hop. A caller compiling a bare schema has this and no
  pointer.
- `path` renders the position the finding is **actionable** at, as a
  dotted string. Always present, and the text `check` prints. Read it,
  and use the two above to parse.
- `location` is text for a **human**, naming what was being compiled.

`path` renders in one of two frames, and the rule picks whichever one
names the place a reader would edit. For every rule but one it re-roots
at each `$ref` crossed, so a defect in a shared component is reported
once, at the component. For `silent-rewrite/required-not-in-properties`
it keeps the use-site route from the compiled schema root instead: that
rule asks which property names are reachable at an instance position,
and a component answers differently at different use sites, so the
definition can name a position where the finding does not hold. `anchor`
reports `scoped-definition` in exactly that case, which is how a
consumer holding a pointer tells the two frames apart.

A caller compiling a self-contained schema (`compileSchema` with `$defs`
and no surrounding document) gets no `pointer` by default, and
`schemaPath` stops at the first `$ref`. Passing `pointer: ""` roots the
pointer at the schema itself, which is where the default resolver
already resolves `#/…`, so findings behind a ref carry an address that
resolves (`/$defs/Inner/properties/y`) rather than nothing.

`anchor` says what `pointer` addresses: `node` for the finding's own
position, `definition` for shared text reached through a `$ref`, and
`scoped-definition` for shared text where the finding holds only on this
route. A schema reached from several operations compiles once and
carries the label of whichever got there first, so read `location` as a
hint about where to look rather than the full list of operations
affected.

`context` is a deprecated alias for `location` and carries the same
value.

The same label prefixes malformed-schema errors:

```
POST /things request body (application/json): "items" at "properties.a"
must be an object or boolean; got an array.
```

| Mode               | Reports                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"off"`            | Nothing                                                                                                                                                         |
| `"warn"` (default) | Keywords oaverify implements only partially (currently `$dynamicRef`), wrong-typed annotation values, and the `silent-rewrite/*` and `unsatisfiable/*` warnings |
| `"strict"`         | The above, plus unrecognised keywords (`minimumx: 5`)                                                                                                           |

`schemaLintIssues` is a live array: it grows as schemas compile, and
response-body schemas compile lazily on first use, so read it after the
requests you care about rather than immediately after construction.

The `annotation-value-type` row of that table is worth expanding: it
flags an annotation carrying a value of the wrong type, most often a YAML `description:`
left empty, which parses to `null`. It is a lint finding rather than a
malformed-schema error because annotations emit no validation code, so
the compiled validator is unaffected. What is lost is the text the
author meant to write, which no other check would notice.

The `unsatisfiable/*` family reports something provably dead, which is
almost always a typo. The code names what is dead, since that is not
always the whole position.

`unsatisfiable/pattern-length` kills the position: a `pattern` whose match length cannot overlap the
sibling `minLength` / `maxLength`, as in `pattern: '(^[a-zA-Z0-9](9)$)'`
alongside `minLength: 9`, where `(9)` is a group matching the literal
`9` and `{9}` was meant. Match length is computed by parsing the
pattern. Where the parse cannot model a construct (backreferences,
`\p{...}` property escapes, a malformed pattern) the rule says nothing
rather than guess, and where the analysis is imprecise it errs wide, so
a finding means the position is provably dead. It also says nothing
about a pattern that compiles only under the no-flag `RegExp` fallback,
since that fallback reads the length of some constructs differently
(`\01` is one octal escape there, two characters under `u`). For the same reason it
fires only where `type` is exactly `"string"`: with another type
admitted, a non-string instance still validates.

`unsatisfiable/enum-member-type` kills a member: an `enum` entry the
sibling `type` can never admit, so no instance can select it.
`type: string` with `enum: [1, 2, 3]` is the shape in the wild. The
finding names each dead member and its index, and says separately when
every member is dead, which is the case where the position goes with
them. Reporting the whole enum for one bad member would be the
over-report, since `enum: ["a", 2]` still validates `"a"`.

It says nothing where `type` is absent, nothing being constrained. And
under OAS 3.0 it honours `nullable: true`, so `type: string` with
`enum: ["a", null]` is accepted there; that is valid 3.0 and comparable
tools report it anyway. Under 3.1 `nullable` is an inert extension, so
the same document is reported there, and the difference is the dialect
rather than an inconsistency.

The `silent-rewrite/*` family reports a constraint the validator does
not enforce as written. `silent-rewrite/discriminator-unroutable` is
worth calling out because of what oaverify does about it: a
`discriminator` whose values cannot be matched to the sibling `oneOf` /
`anyOf` branches is **ignored**, and the composition validates every
branch instead.

That is the verdict OpenAPI asks for. A discriminator is an aid to
branch selection and error quality; the composition beside it is what
decides validity. Rejecting every payload because the aid could not be
interpreted is the one outcome the spec does not sanction, and it is
what happened to any spec whose branches carry no `$ref`: a pre-bundled
document keeps `mapping` values naming the files the bundle absorbed.

Two things stay as they were. A value outside a _working_ mapping still
fails, because no schema can be selected for it and the spec expects
that. And a working discriminator still routes to one branch, so its
error names that branch's problem rather than "none of N schemas
matched".

## Examples: do the documented examples match their schemas

`check` validates the examples in the document against the schemas they
illustrate, and reports failures under the `examples` class.

Covered: Schema Object and Media Type Object examples reachable from
`paths`, `webhooks`, `components.schemas`, `components.parameters`,
`components.headers`, `components.requestBodies`,
`components.responses`, `components.pathItems`, and callbacks (both on
an operation and under `components.callbacks`).

Two surfaces, one pass:

- **Schema Object** `example` (3.0, singular) and `examples` (3.1, an
  array of literal values), the JSON Schema annotations.
- **Media Type Object**, **Parameter Object** and **Header Object**
  `example` and `examples` (a map of Example Objects), which sit beside
  `schema:` rather than inside it. Header Objects include the ones under
  `encoding.<property>.headers`.

Both are annotations, so nothing at runtime looks at them. What ships
instead is a documented example contradicting the contract it
illustrates, carried into generated docs, SDK fixtures and mock servers
as though it were conformant.

```
warning examples [example-invalid]
  /components/schemas/Thing/properties/count/example:
  oaverify rejects "example" against its schema: must be integer (example: "not-an-integer")
```

Findings are located by RFC 6901 pointer, so a shared component is
reported once, at its own definition, rather than once per operation
that reaches it.

One finding covers one example, and spells out every way that example
fails rather than stopping at the first:

```
warning examples [example-invalid]
  /paths/~1withdrawals/post/requestBody/content/application~1json/examples/Broken/value:
  oaverify rejects "examples.Broken" against its schema:
  effectiveDate: must be string (actual: integer); payeeOrBeneficiary.0.paymentForm:
  must be one of the allowed values (actual: "EFT", allowed: ["DTCC","ACH","CHECK"]);
  payeeOrBeneficiary.0.taxId: must have required property "taxId"
  (example: {"effectiveDate":20260116,"payeeOrBeneficiary":[{"paymentFor...)
```

Past five reasons the rest are summarised as `and N more`, so the list
stays readable and a cap is never silent. This is the one place `check`
departs from the zero-config `maxErrors: 1` default: an example is
usually wrong in several independent ways, and a budget of one costs the
author a fix-and-recheck round per defect.

`enum`, `const` and `type` failures carry the offending value and the
set that was permitted, because their message is a bare assertion and
recovering either otherwise means following the `$ref` chain to the
schema by hand. The bounded keywords already name their bound. Long
values and long enums are truncated with `...`.

The check runs the schema's own compiled validator over the value, which
gets `format`, `enum`, `required` and every other keyword for free.
Two consequences worth knowing:

- Schemas are compiled **as authored**. Request and response bodies are
  normally compiled per direction, with `readOnly` properties rewritten
  to reject on the request leg and `writeOnly` on the response leg. An
  example describes the schema its author wrote, not a direction
  variant, so this pass never applies that rewrite. Checking examples
  against the direction variant would report a component example that is
  a perfectly good response as invalid.
- A finding means _this validator_ rejects the example. Usually that is
  a defect in the example; occasionally it is a defect in oaverify (see
  [#553](https://github.com/oaverify/oaverify/issues/553)). Either way it
  is worth knowing, because a real request shaped like that example
  would be rejected too.

It declines rather than guesses in three places: a Schema Object
`examples` that is not an array (the 3.0 Example Object map shape under
a 3.1 `openapi:`, reported by the `annotation-value-type` schema lint
instead, which names the real defect); an Example Object carrying
`externalValue`, which oaverify does not fetch; and a schema that will
not compile.

This is the one class that compiles schemas of its own accord, so it is
also the one with a cost worth naming: on a 278-component document it
adds roughly 60ms. Omit `examples` from `--only` to opt out of it, and
note that a `--only` list omits everything it does not name, so
`--only hygiene,schema,conformance` drops the `redos` class as well.

## Patterns: can a regex be made to backtrack

`check` reports a `pattern` with a proven ambiguity under the `redos`
class, code `ambiguous-pattern`:

```
warning redos [ambiguous-pattern] /components/schemas/Thing/properties/id/pattern:
  "^(a+)+$" is ambiguous. An input of the form `aaaa` matches more than one way.
  A backtracking engine can be made to explore every way of matching, so a
  crafted value may cost superlinear time; whether it does depends on the engine
  running the pattern. Rewrite to remove the ambiguity, or compile patterns with
  a linear-time engine (the regexCompiler option).
```

**This is a weaker claim than the `unsatisfiable/*` family makes, on
purpose.** Those mean a position is provably dead. This means the pattern
is provably _ambiguous_: some input matches by more than one route,
which is the precondition for catastrophic backtracking. Whether a given
engine turns that into observable cost varies. Measured on the corpus:
`^.+/.+$` is quadratic on V8 (33ms at 6,000 characters, and it does not
return at scale), while other ambiguous patterns there stay flat at
every input size tried. The finding names the ambiguity, which is what
was proven, and the witness so you can see it.

It is still worth knowing about a flat one, because a spec is consumed
by more than your runtime: SDK generators, mock servers, gateways and
other validators mostly use backtracking engines, and they do not share
V8's optimisations.

Two things follow from the analysis being the expensive part of this
check, and from the finding being about the document rather than about
your deployment:

- The rule fires whether or not you have configured `regexCompiler`.
  A linear-time engine such as `re2` removes the risk for _your_
  process; it does not change the document. It also does not support
  backreferences or lookaround, so it is not a free swap.
- `--only hygiene,schema,conformance,examples` opts out. This is the one
  check that reaches for a third-party analyser, which is why it is
  its own class.

## Request strictness: how tolerant validation is of traffic

These change what counts as a valid request. They say nothing about
whether your spec is well written.

- `strictQueryParameters: true` rejects query parameters the operation
  does not declare. Default `false`.
- `validateSecurity: "shape" | "strict"` checks security schemes.
  `"strict"` additionally fails on schemes oaverify cannot shape-check
  (oauth2, oidc, mTLS). Default `"off"`.

Both produce ordinary validation errors on the request, at request time.
Neither appears in `schemaLintIssues`.

## On the CLI

Two verbs, one question each.

```
oaverify check <spec>       # is my spec good?
oaverify validate <spec>    # does this payload conform?
```

`check` reports the classes above, plus spec hygiene (unused components,
path-parameter mismatches) and document conformance. A malformed schema
is reported as a finding with the code `malformed-schema`, and `check`
carries on with the rest of the document, so one bad `items` does not
hide every other finding in the file.

### Class and severity are different questions

Every finding carries both, and neither implies the other.

**Class** says which pass produced it, and is what `--only` selects:

| Class         | Question it answers                               |
| ------------- | ------------------------------------------------- |
| `conformance` | Is this a legal OpenAPI document for its version? |
| `hygiene`     | Is the document internally consistent?            |
| `schema`      | Are the schemas what the author meant?            |
| `examples`    | Do the documented examples satisfy their schemas? |
| `redos`       | Can a `pattern` be made to backtrack?             |
| `malformed`   | Reported, never selected; see below.              |

**Severity** says what it means for you, and is what `--fail-on` gates on:

| Severity  | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `fatal`   | The document cannot be compiled into a validator.       |
| `error`   | Legal to parse, but violates the OpenAPI specification. |
| `warning` | Legal, and probably not what the author meant.          |

They are separate because they cut across each other. `hygiene` holds
both `path-param-undeclared`, which is a specification violation, and
`unused-tag`, which is housekeeping. Before severity existed, gating on
findings meant gating on both or neither.

```
oaverify check spec.yaml --fail-on error    # break the build on what is actually wrong
oaverify check spec.yaml --fail-on warning  # break the build on anything at all
```

`--only` takes the selectable classes from the table above. A malformed
schema is found by compiling, which is what the `schema` check does, so
it cannot be asked for on its own and appears whenever that check runs.

#### When you disagree with the grading

The table above is oaverify's judgement about consequence, and a
consumer may reasonably hold a different one. `schema` and `redos` are
flat `warning`, which puts `unsatisfiable/pattern-length` (a field no
value can ever satisfy) and `redos/ambiguous-pattern` (a
denial-of-service vector on a field with no `maxLength`) at the same
rank as a style note.

`--severity` regrades, so the policy lives with the team that has to
act on it:

```
oaverify check spec.yaml --severity 'unsatisfiable/*=error' --fail-on error
oaverify check spec.yaml --severity 'redos=error,examples=error' --fail-on error
```

A key is an exact code, a family written `name/*`, or a class, and the
most specific one wins, so
`--severity 'unsatisfiable/*=error,unsatisfiable/pattern-length=warning'`
promotes the family and demotes the single member whichever order they
are written in. Levels are the three above. The flag takes a
comma-separated list and may be repeated.

It changes the `severity` field in the report and what `--fail-on`
gates on, and nothing else: `validate` has no notion of severity, and
which findings are produced is `--only`'s question.

**`malformed` cannot be remapped.** Its exit code is 4, which outranks
`--fail-on` because a document that cannot be compiled is not a gate
result, so a remapping would change the printed word and nothing that
matters. `--severity malformed=warning` is refused as a usage error
rather than half-applied. Every other input error is refused too, on
the same reasoning: a mistyped key that silently graded nothing is the
failure this option exists to prevent.

### Document conformance

`conformance` validates the document against the JSON Schema OpenAPI
publishes for the version it declares, pinned and vendored rather than
fetched. The rules are OpenAPI's, so they do not drift from the spec the
way a hand-maintained rule set does. This is what catches a null
`description` on a Response Object, a typo'd field name, or an invalid
parameter location: defects that are neither schemas nor inconsistencies.

Two limits worth knowing:

- **It cannot follow references.** A schema validates a node against a
  subschema and cannot ask whether a name resolves, so a dangling `$ref`,
  a duplicate `operationId`, a discriminator mapping pointing at nothing,
  an undeclared server variable, and a security requirement naming a
  scheme that does not exist all pass. Some are covered by `hygiene`; the
  rest are out of scope, and pairing with a linter remains the answer for
  them.
- **Schema Object coverage differs by version.** 3.1 and 3.2 decline to
  validate Schema Objects (their meta-schemas stub the slot, deferring to
  a swappable dialect), so `conformance` and the schema classes are
  disjoint. 3.0 describes the Schema Object in full, so on 3.0 they
  overlap and one defect can be reported by both.

```
oaverify check spec.yaml --only schema --fail-on warning --format json
```

The full exit-code table is in
[the published CLI README](../packages/oav/README.md#exit-codes).
The 2-versus-4 split is the one worth scripting against. Exit 2 means
there is no report to read, and it means the same thing in every
command that loads a spec. Exit 4 means the report on stdout is
complete and one of its findings makes the document uncompilable.

Exit 4 outranks `--fail-on`: a document that will not compile is not a
gate result. The programmatic equivalent is
`precompile({ onMalformed: "collect" })`; the default still throws,
which is what a server wants, since continuing would leave that
operation validating against nothing.

Request strictness has no CLI surface: it changes how traffic is
validated at runtime, which is a library setting.

## Which one do I want?

- _"My spec has a typo and I want to know at build time."_ → `schemaLint: "strict"`.
- _"I want unexpected query parameters rejected."_ → `strictQueryParameters: true`.
- _"I want to be told my spec is not **structurally** valid OpenAPI."_ →
  `oaverify check --only conformance`, or `--fail-on error` in CI. It
  validates the document against the JSON Schema OpenAPI publishes for
  the version it declares, which covers the shape of every object but
  does not follow cross-references. A clean run means the document is
  well-shaped, not that every name in it resolves.
- _"I want to be told my `$ref` points at nothing, or my `operationId`s
  collide."_ → conformance cannot answer that: a schema validates a node
  against a subschema and cannot ask whether a name resolves. `check`
  covers some of it under `hygiene` (undeclared path parameters, unused
  components). For the rest, pair with `redocly lint` or `vacuum`; see
  [the integration guide](./integration.md).

## For contributors: naming

`strict` is acceptable in an option name only when the name scopes what
it applies to. `strictQueryParameters` says which things get stricter, so
it reads unambiguously. `validateSecurity: "strict"` is scoped by the
option it belongs to.

A bare `strict` is not acceptable, because it names an intensity without
a domain. The option now called `schemaLint` was previously `strict`, and
it was impossible to tell from a call site whether it tightened schema
checking, request validation, or both.

So: if a new option does not fit one of the three classes above, it does
not get called strict.
