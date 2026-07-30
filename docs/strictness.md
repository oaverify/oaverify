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
`$ref`s is caught along with the rest.

Both classes used to slip through, and the reason they are fatal now is
what they did instead. An array-valued `items` compiled to a schema with
no keywords, so the array's elements went unvalidated while the spec
looked fine. `required: "id"` iterated the string as characters and
demanded properties `"i"` and `"d"`, rejecting the `{ "id": ... }` it was
meant to accept. Neither looked wrong from outside. A validator whose
meaning is unknown is worse than one that refuses to start, so catch this
with a `try` around `createValidator`, not with a check on each request.

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
//   context: "POST /users request body (application/json)",
//   message: ...
// }]
```

`path` is relative to the schema that was compiled, so it locates the
keyword inside that schema and not inside your document. `context` names
what was being compiled, which is what turns the two into an address you
can act on. A schema reached from several operations compiles once and
carries the label of whichever got there first, so read `context` as a
pointer to the schema rather than the full list of operations affected.

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

The `unsatisfiable/*` family reports a position no instance can
validate at, which is almost always a typo. `unsatisfiable/pattern-length`
is the current member: a `pattern` whose match length cannot overlap the
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

The wording is deliberate. The finding reports this validator's verdict
on the example, which is usually a defect in the example and
occasionally a defect in oaverify (see below).

Findings are located by RFC 6901 pointer, so a shared component is
reported once, at its own definition, rather than once per operation
that reaches it.

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
adds roughly 60ms. `--only hygiene,schema,conformance` opts out.

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

`--only` takes `hygiene` / `schema` / `conformance`. A malformed schema
is found by compiling, which is what the `schema` check does, so it
cannot be asked for on its own and appears whenever that check runs.

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

| Exit | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | clean                                              |
| 1    | findings met `--fail-on`, or a domain check failed |
| 2    | input could not be read, resolved, or parsed       |
| 3    | CLI usage error                                    |
| 4    | graded, and at least one schema is malformed       |

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
