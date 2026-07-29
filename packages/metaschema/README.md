# @oaverify/internal-metaschema

Internal package. The published OpenAPI meta-schemas, pinned per version,
plus the dispatch that picks one for a document.

OpenAPI publishes a JSON Schema describing conformant documents of each
version. Compiling it and validating a user's document against it gives
document conformance whose rules are OpenAPI's rather than independently
hand-written here, so they do not drift from the spec the way a
hand-maintained rule set does.

One qualification, because that is easy to read as stronger than it is:
3.1 and 3.2 are vendored byte-identical to the published documents, but
**3.0 is derived from one** rather than being one. It is published as
draft-04, so it goes through a translation (see below). Three mechanical
edits, and the script refuses anything it does not understand, but the
artifact is our output and a bug in it would be ours.

This package holds the schemas and the version dispatch only. It does not
compile or validate anything, and **nothing consumes it yet**: the
`check` wiring lands separately, so no user-visible document
conformance exists on the strength of this package alone.

Its one workspace dependency is `@oaverify/internal-core`, for
`detectOpenAPIVersion`.

## Contents

| Export                          | Purpose                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `MetaschemaVersion`             | `"3.0" \| "3.1" \| "3.2"`                                   |
| `metaschemaFor(version)`        | the pinned document for a version                           |
| `metaschemaVersionOf(document)` | which vendored schema applies to a document, or `undefined` |
| `METASCHEMA_REVISIONS`          | which upstream revision each schema came from               |
| `metaschemaUrl(version)`        | the source URL for a pinned revision                        |

## Version detection

`metaschemaVersionOf` delegates to `detectOpenAPIVersion` from
`@oaverify/internal-core` rather than matching the `openapi` string
itself. A second detector would drift from the one the validator
dispatches on, and two detectors disagreeing about what a document _is_
would be a miserable bug to find. This adds only the question that
detector cannot answer: whether a schema is vendored for the version it
found.

One deliberate consequence: a same-minor but malformed version string
(`3.1`, `3.1.x`) dispatches to the 3.1 schema, which then reports the
`pattern` failure with a located error naming the offending value. That
beats declining to dispatch and reporting "unknown version" about a
document that plainly says 3.1.

## Pinned, not fetched

Revisions are pinned. A `check` verdict that changes because OpenAPI
republished, with nothing in the diff on our side, is the kind of
surprise this codebase avoids by policy. Updating is a visible commit:
refresh the file, re-run the tests, review what moved.

`https://spec.openapis.org/oas/3.1/schema/latest` returns 404, so dated
URLs are the only addressing available in any case.

## Bundle cost

The three documents are ~100KB together. A consumer importing only
`metaschemaVersionOf`, which reads a string off a document and touches no
schema, should not pay for them, and does not: esbuild drops all three.

That is not automatic. Any side-effecting top-level call that references
the lookup table forces a bundler to retain everything it points at. An
`Object.freeze` over the version map is the easy version of that mistake,
and it costs the whole 100KB (measured: 101,593 bytes retained with the
freeze, 514 without). `Readonly<>` gives the guarantee that matters at
compile time and at no runtime cost. `test/index.test.ts` bundles the
module and asserts the ceiling, because the failure mode is invisible in
the source.

The separate consequence, for whoever wires this into a build: keep it
off `@oaverify/core`'s main entry. `metaschemaFor` genuinely needs all
three, so anything reaching it pays in full. That belongs in the CLI
tarball, where `check` lives, rather than in the library every framework
adapter depends on.

## The Schema Object, and why 3.0 is different

How much of the Schema Object a meta-schema covers decides how a caller
should combine these documents with the compiler's well-formedness pass.
(This package runs neither; it holds the documents.)

**3.1 and 3.2** stub it: `$defs.schema` is `type: ["object", "boolean"]`,
reached through `$dynamicRef` so a dialect can be swapped in. Their own
`description` says they describe documents _"without schema
validation"_. 3.1 aligned the Schema Object with JSON Schema 2020-12, so
there was nothing left to restate. The two are disjoint.

**3.0** describes it in full: 35 fields, `type` constrained to an enum,
`items` required to be a Schema or Reference. A 3.0 Schema Object is a
bespoke subset rather than JSON Schema, so OpenAPI had to spell it out.
Here the two **overlap**, and a caller reporting findings from
both needs a precedence rule or the same defect is printed twice.

The overlap is not a defect in either place. It follows from 3.0's Schema
Object not being JSON Schema, and it means 3.0 documents get _more_ out
of the meta-schema than 3.1 documents do.

## Regenerating the 3.0 schema

3.1 and 3.2 are vendored byte-identical to upstream. 3.0 cannot be: it is
published as draft-04 and the compiler implements 2020-12.

`scripts/convert-oas30.mjs` applies the translation. It is a transform
rather than a hand-edited copy on purpose. A blob nobody can re-derive
gives up the property that makes this approach trustworthy, and a new
upstream revision should be a re-run and a diff.

```bash
node scripts/convert-oas30.mjs scripts/oas-3.0-upstream.json src/vendor/oas-3.0.json
```

`scripts/oas-3.0-upstream.json` is the unmodified published document,
checked in so the input is reviewable and the output reproduces without
network access. A test asserts the checked-in output regenerates byte for
byte.

The whole draft-04 surface is three things: `id`, the `$schema` URI, and
one `multipleOf` node using draft-04's boolean `exclusiveMinimum`
modifier. The transform refuses anything else draft-04-shaped
(array-form `items`, `dependencies`, `additionalItems`, `divisibleBy`)
rather than emitting a schema nobody read.

**The trap.** The 3.0 document both _is_ a schema and _describes_
OpenAPI's own Schema Object, which has its own boolean
`exclusiveMinimum` / `exclusiveMaximum` fields. Those are data and must
survive untouched. Rewriting every boolean `exclusiveMinimum` corrupts
them, in a branch ordinary fixtures never reach. The discriminator is a
sibling numeric `minimum`, which marks a keyword in use; a `type:
boolean` node is a field description. `test/convert-oas30.test.ts`
covers both directions.

## Upstream stability

The 3.0 schema has two published revisions, `2021-09-28` and
`2024-10-18`, differing only by a semantically equivalent
`ParameterLocation` refactor. The 3.0 line is closed, so that pin is
expected to age well.

The 3.1 schema's anchor topology (four `$dynamicRef`, one
`$dynamicAnchor`, zero external `$ref`) is identical across every
published revision. 3.2 has five `$dynamicRef` sites rather than four,
and the same single anchor and zero external refs; the count that matters
is the anchor, since one anchor is what makes static resolution
unambiguous. That stability is structural: the anchor exists to be
a swappable placeholder, so it cannot gain structure without the
dialect-swap contract itself changing.
