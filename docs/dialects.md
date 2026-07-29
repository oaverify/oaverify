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

Only three things vary from 2020-12; everything else (numeric / string
/ array / object bounds, `enum`, `required`, `allOf` / `anyOf` /
`oneOf`, `not`, `format`, discriminator, etc.) is shared.

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

Keywords absent from 3.0 (`const`, `if`/`then`/`else`, `contains`,
`patternProperties`, `propertyNames`, `unevaluatedProperties` /
`Items`, `prefixItems`, `$defs`, `$id`, anchors, `$dynamicRef`) are
simply not in the 3.0 vocabulary stack; schemas that use them are
treated as having an unknown field, which 2020-12 allows in every
dialect.

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
