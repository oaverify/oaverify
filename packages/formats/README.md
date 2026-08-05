# @oaverify/core/formats

Built-in format validators for the `format` keyword. `builtInFormats`
is the keyed map passed to `createValidator({ formats })` or
`compileSchema({ formats })`.

One registry, whatever JSON type a format constrains. String formats
are pure `(value: string) => boolean` predicates; the two OpenAPI
numeric formats declare the type they take.

```ts
import { builtInFormats, validateUuid } from "@oaverify/core/formats";
import { compileSchema, jsonSchemaDialect } from "@oaverify/core/schema";

const { validate } = compileSchema(
  { type: "string", format: "uuid" },
  { dialect: jsonSchemaDialect, formats: builtInFormats },
);

validate("550e8400-e29b-41d4-a716-446655440000"); // { valid: true }
validateUuid("not a uuid"); // false
```

When the validator package is used via `createValidator`, the built-in
formats are already included; pass `formats` to extend them, not
replace them.

## Formats

- **Date / time**: `date-time`, `date`, `time`, `duration` (RFC 3339)
- **Email**: `email` (ASCII), `idn-email` (RFC 6531)
- **Hostname**: `hostname`, `idn-hostname`
- **IP**: `ipv4`, `ipv6`
- **URI**: `uri`, `uri-reference`, `iri`, `iri-reference`, `uri-template`
- **JSON Pointer**: `json-pointer`, `relative-json-pointer`
- **Misc**: `uuid`
- **Numeric** (OpenAPI): `int32`, `int64`, as `{ type: "number", validate }`

`regex` also works as a `format`, but it isn't a key in `builtInFormats`:
`@oaverify/core/schema` registers it inside `createDeps` so it routes through the
same compile path as the `pattern` keyword (and honors `regexCompiler`).
The standalone `validateRegex` predicate is still exported for direct use.

`float` and `double` are absent on purpose. Every JSON number is
already an IEEE 754 double, so `double` asserts nothing, and a
`Math.fround`-based `float` rejects values a producer legitimately
sent. `int64` asserts the safe-integer range rather than the int64
range, because a JSON number past 2^53 has already lost precision
before it reaches any JavaScript validator; see
[docs/configuration.md](../../docs/configuration.md#formats).

## Registering a custom format

The validator and compiler both accept a `formats` option that merges
on top of the built-ins:

```ts
import { createValidator } from "@oaverify/core";

const v = createValidator(spec, {
  formats: {
    // A bare function is a string format.
    "e164-phone": (s) => /^\+[1-9]\d{6,14}$/.test(s),
    // Constraining numbers says the type out loud.
    "basis-points": { type: "number", validate: (n) => n >= 0 && n <= 10000 },
    // `false` registers the name and asserts nothing.
    int64: false,
  },
});
```

A bare function is **always** a string format, including under a name
whose built-in constrains numbers.

In the spec, reference the format as you would any built-in:

```yaml
Phone:
  type: string
  format: e164-phone
```

See [`examples/custom-formats.ts`](../../examples/custom-formats.ts)
for a runnable end-to-end.

## Assertive vs annotation-only

In JSON Schema 2020-12, `format` is advisory by default: a validator
recognizes the name but doesn't reject malformed values. OpenAPI 3.0 /
3.1 / 3.2 treat `format` as assertive; the validator wires up the
corresponding vocabulary so `format: email` rejects non-emails.
When compiling directly via `@oaverify/core/schema`, use
`openapi31Dialect` (or the assertive vocabulary explicitly) to get
assertive semantics.
