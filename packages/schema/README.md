# oav/schema

JSON Schema 2020-12 compiler. Walks the schema once at construction
time and emits a JavaScript function via code generation, with no
schema-walking on the hot path. Compiled validators return `{ valid }`
plus, on failure, a flat `errors` list and `truncated` (the
`output: "flat"` default); `output: "tree"` swaps in a
nested `error` tree.

Use this module directly when you want schema validation without the
HTTP layer (REST-less RPC bodies, config files, test fixtures, etc.).
For OpenAPI request/response validation, use `createValidator` from
the root entrypoint instead.

## Quick start

```ts
import { compileSchema, jsonSchemaDialect } from "@oaverify/core/schema";

const { validate } = compileSchema(
  { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  { dialect: jsonSchemaDialect },
);

validate({ name: "Fido" }); // { valid: true }
validate({}); // { valid: false, errors: [{ code: "required", ... }], truncated: false }
```

`compileSchema` returns `{ validate, source, stats }`. `validate(data,
startPath?)` runs the generated validator; `startPath` prepends segments
to every error's `path` (used by the HTTP validator to prefix `"body"`,
`"query"`, etc.). `source` is the generated JS, exposed for debugging;
`stats.functionCount` is the number of helper functions emitted.

By default `validate` returns a flat `errors` list and stops at the
first problem (`maxErrors: 1`). Pass
`output: "tree"` for a nested error tree under `error`,
`output: "predicate"` for a bare boolean, and
`maxErrors: Number.POSITIVE_INFINITY` to collect every error.

## Dialects

Every compile picks exactly one `Dialect`: a vocabulary stack plus
the keyword-dispatcher rules that make it coherent. Three built-ins:

| Dialect             | Spec                | `format`   | Extras                                                               |
| ------------------- | ------------------- | ---------- | -------------------------------------------------------------------- |
| `jsonSchemaDialect` | JSON Schema 2020-12 | annotation |                                                                      |
| `openapi31Dialect`  | OpenAPI 3.1 / 3.2   | assertion  | Adds `formatAssertionVocabulary`                                     |
| `oas30Dialect`      | OpenAPI 3.0         | assertion  | `nullable`, boolean `exclusive{Min,Max}`, `$ref`-suppresses-siblings |

### Building a custom dialect

```ts
import {
  compileSchema,
  coreVocabulary,
  validationVocabulary,
  applicatorVocabulary,
  type Dialect,
} from "@oaverify/core/schema";

const minimalDialect: Dialect = {
  id: "minimal",
  vocabularies: [coreVocabulary, validationVocabulary, applicatorVocabulary],
  rules: { refSuppressesSiblings: false },
};
```

Built-in vocabularies available to compose:

- `coreVocabulary`: `$ref`, `$dynamicRef`, `$id`, `$defs`, anchors.
- `validationVocabulary`: `type`, `enum`, `const`, numeric / string /
  array / object bounds, `required`.
- `applicatorVocabulary`: composition keywords (`allOf`, `anyOf`,
  `oneOf`, `not`), nested schemas (`properties`, `items`, …),
  `if`/`then`/`else`, `discriminator`.
- `unevaluatedVocabulary`: `unevaluatedProperties`, `unevaluatedItems`.
- `formatVocabulary` / `formatAssertionVocabulary`: `format` as
  annotation / assertion.

## Registering a custom keyword

Pass a `keywords` record at compile time. The compiler wraps each
validator into a `KeywordDefinition`, registers it alongside the
built-ins, and dispatches via generated code on the hot path:

```ts
import { compileSchema, jsonSchemaDialect } from "@oaverify/core/schema";

const { validate } = compileSchema(
  { type: "integer", divisibleBy: 7 },
  {
    dialect: jsonSchemaDialect,
    keywords: {
      divisibleBy: (data, schemaValue) =>
        typeof data !== "number" || data % (schemaValue as number) === 0,
    },
  },
);
```

Return `true` for valid, `false` for a generic failure, or
`{ message?, params? }` for a custom error leaf. Names that collide
with a built-in keyword throw at construction.

### Advanced: full `KeywordDefinition`

The function form above covers most custom keywords. For applicator
keywords (ones that descend into subschemas), evaluation-key tracking,
or custom emit shapes, pass a full `KeywordDefinition` instead. The
`compile(ctx)` function receives a `KeywordCompileContext` that lets
you emit generated code directly.

This is a contributor-facing surface; the procedure lives in
[`docs/extending.md`](../../docs/extending.md#add-a-new-keyword), and
the compile-context API reference is the TSDoc on
`KeywordCompileContext` (`src/keywords/types.ts`).

## Output and error-collection modes

`output` selects the result shape: `"flat"` (default) returns
`{ valid, errors, truncated }` with a de-nested leaf list; `"tree"`
returns `{ valid, error, truncated }` with the nested error tree;
`"predicate"` returns a bare boolean and builds no errors at all.

`maxErrors` caps the leaves collected and short-circuits hot loops once
the budget is exhausted. The default is `1` (classic fast-fail); larger
values bound CPU/memory on huge invalid payloads, and
`Number.POSITIVE_INFINITY` collects everything with zero-overhead
codegen (plain `errors.push`, no budget checks). A failing result
carries `truncated: true` when the cap was reached.

`output` and `maxErrors` are orthogonal. A finite `maxErrors` never
changes a valid/invalid verdict; for schemas using
`unevaluatedProperties` / `unevaluatedItems` the short-circuit is
disabled (every error is collected) so the cap can't suppress a real
`unevaluated*` error.

## `$ref` and cycles

`$ref` / `$dynamicRef` compile to function calls through a
schema-identity-keyed cache, so a self-referential schema emits a
normal recursive call rather than blowing the stack at compile time.
