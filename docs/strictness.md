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
// "items" at "properties.events" must be an object or boolean; got an array.
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
// [{ code: "unknown-keyword", keyword: "minimumx", path: "properties.age", message: ... }]
```

| Mode               | Reports                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `"off"`            | Nothing                                                                           |
| `"warn"` (default) | Keywords oaverify implements only partially (currently `$dynamicRef`)             |
| `"strict"`         | The above, plus unrecognised keywords (`minimumx: 5`) and silent-rewrite warnings |

`schemaLintIssues` is a live array: it grows as schemas compile, and
response-body schemas compile lazily on first use, so read it after the
requests you care about rather than immediately after construction.

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

`check` reports the first two classes above. Malformed schemas cannot be
collected as findings -- there is no validator to grade -- so they exit 2
with the compiler's located message. Lint findings are reported, and exit
1 only when `--fail-on` asks for it.

```
oaverify check spec.yaml --only schema --fail-on warning --format json
```

| Exit | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | clean                                              |
| 1    | findings met `--fail-on`, or a domain check failed |
| 2    | input could not be loaded, resolved, or compiled   |
| 3    | CLI usage error                                    |

Request strictness has no CLI surface: it changes how traffic is
validated at runtime, which is a library setting.

## Which one do I want?

- _"My spec has a typo and I want to know at build time."_ → `schemaLint: "strict"`.
- _"I want unexpected query parameters rejected."_ → `strictQueryParameters: true`.
- _"I want to be told my spec is not valid OpenAPI."_ → none of these. oaverify
  validates schemas, not documents. Pair it with `redocly lint` or `vacuum`;
  see [the integration guide](./integration.md).

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
