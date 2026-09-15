# Dialects and version support

User-facing version support (the supported-version table, the
`dialect` / `onUnknownVersion` overrides, Swagger 2.0) is in the
[README `## Versions`](../README.md#versions) section. This page is the
contributor-facing internals: how dispatch works, what varies between
dialects, and where the per-version tests live.

## Dispatch

The validator buckets the spec's `openapi` string at construction
via `detectOpenAPIVersion` and picks a dialect with a one-liner inside
`createValidator`: `dialectFor(version)`. The check runs once at
construction, so adding a version adds zero per-request cost.

| Spec version | Status    | Dialect                            |
| ------------ | --------- | ---------------------------------- |
| 3.0.x        | Supported | OAS 3.0 Schema Object flavour      |
| 3.1.x        | Supported | JSON Schema 2020-12                |
| 3.2.x        | Supported | JSON Schema 2020-12 + QUERY method |

## What differs in the 3.0 dialect

The 3.0 dialect changes keyword behavior in four places.

1. **`type` is string-only** (no arrays). `oas30TypeKeyword` enforces
   this at compile time and adds `"null"` to the acceptable types when
   the sibling `nullable: true` is set.
2. **`exclusiveMaximum` / `exclusiveMinimum` are booleans.** They
   modify the sibling `maximum` / `minimum` rather than standing alone
   as numeric bounds. `oas30MaximumKeyword` / `oas30MinimumKeyword`
   read the boolean and emit `>=` vs `>` (or `<=` vs `<`) accordingly.
3. **`$ref` siblings are ignored.** The dialect's
   `rules.refSuppressesSiblings` flag makes the keyword dispatcher skip
   every non-`$ref` keyword in a schema that declares `$ref`.
   `oas30Dialect` sets it to `true`; every other built-in dialect sets
   it to `false`.
4. **The unevaluated vocabulary is absent.** The 3.0 dialect reuses the
   validation and applicator vocabularies, but does not include
   `unevaluatedVocabulary`. `unevaluatedProperties` and
   `unevaluatedItems` are therefore ignored and reported as
   `unknown-keyword` under `schemaLint: "strict"`.

Document conformance answers whether a Schema Object is legal for the
OpenAPI version; schema lint's `unknown-keyword` finding answers
whether oaverify can compile a keyword. The two checks are independent.
For example, `patternProperties` belongs to the shared applicator
vocabulary, so oaverify honors it in a 3.0 Schema Object even though
OpenAPI 3.0 does not permit it. Any JSON Schema keyword outside the
OpenAPI 3.0 Schema Object subset can have that combination: honored by
oaverify and non-conformant in an OpenAPI document. Portability across
strict 3.0 tooling requires using only the OpenAPI 3.0 subset.

Relative to the default JSON Schema stack, OAS 3.0 adds `oas30Vocabulary`,
`formatAssertionVocabulary` and `openapiMetaDataVocabulary`, and omits
`unevaluatedVocabulary`.

The vocabulary composition, keyword dispatch and sibling-suppression rule are pinned by
`packages/schema/test/keyword-introspection.test.ts`. Review this description
when that test reports a composition change.

## Running tests per version

- **Schema-level tests** (`packages/schema/test/*`) are
  dialect-agnostic: they compile with the default 2020-12 vocab and
  assert 2020-12 semantics. Dialect-specific keyword tests sit next to
  their keyword files where sensible.
- **HTTP-level conformance** lives in
  `conformance/openapi-cases/petstore-{30,31,32}/`, one petstore per
  version, each exercising the version's distinctive features (3.0:
  `nullable`, boolean `exclusiveMinimum`; 3.2: QUERY method).
- **Validator integration tests** in
  `packages/validator/test/versioning.test.ts` cover dispatch,
  dialect-specific keyword behavior, and the `dialect` override.
