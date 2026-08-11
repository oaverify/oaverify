# @oaverify/core/formats

Built-in format validators for the `format` keyword. `builtInFormats`
is the keyed map passed to `createValidator({ formats })` or
`compileSchema({ formats })`.

One registry, whatever JSON type a format constrains. String formats
are pure `(value: string) => boolean` predicates; the numeric formats
declare the type they take.

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

- **Date / time**: `date-time`, `date`, `time`, `duration` (RFC 3339),
  `date-time-local` and `time-local` (the same grammars with the offset
  dropped, so the leap-second rule is not asserted), `http-date`
  (RFC 7231, all three forms of the production; the day name is not
  checked against the date, and a two-digit year's century is not
  resolved, so the verdict never depends on today's date)
- **Email**: `email` (ASCII), `idn-email` (RFC 6531)
- **Hostname**: `hostname`, `idn-hostname`
- **IP**: `ipv4`, `ipv6`, `ipv4-cidr`, `ipv6-cidr` (host bits need not
  be zero)
- **URI**: `uri`, `uri-reference`, `iri`, `iri-reference`, `uri-template`
- **JSON Pointer**: `json-pointer`, `relative-json-pointer`
- **Base64**: `byte` (RFC 4648 §4, padded; whitespace stripped first, so
  MIME line-wrapping passes, and `validateByteRfc4648` is the strict
  reading to register in its place), `base64url` (§5, padding optional)
- **Misc**: `uuid`, `char`, `language` (RFC 5646: the grammar, plus the
  no-duplicate-variant and no-duplicate-singleton rules; a subtag is not
  checked against the IANA registry, so `qq-ZZ` passes), `media-range`
  (RFC 9110 §12.5.1, parameters included; a `q` value reads as an
  ordinary parameter)
- **Numeric** (OpenAPI): `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`,
  `uint32`, `uint64`, `double-int`, `unixtime`, each as
  `{ type: "number", validate }`

`regex` also works as a `format`, but it isn't a key in `builtInFormats`:
`@oaverify/core/schema` registers it inside `createDeps` so it routes through the
same compile path as the `pattern` keyword (and honors `regexCompiler`).
The standalone `validateRegex` predicate is still exported for direct use.

That is every format JSON Schema 2020-12 names, plus the assertable
part of the [OpenAPI Format Registry](https://spec.openapis.org/registry/format/).

## What is deliberately not asserted

`float` and `double` are absent on purpose. Every JSON number is
already an IEEE 754 double, so `double` asserts nothing, and a
`Math.fround`-based `float` rejects values a producer legitimately
sent. `binary` is absent for the same kind of reason (the registry
defines it as any sequence of octets); the validator handles it as an
opaque-body bypass instead. `password`, `commonmark` and `html` are
display hints with nothing to check.

`int64` and `uint64` assert the safe-integer range rather than the full
64-bit range, because a JSON number past 2^53 has already lost
precision before it reaches any JavaScript validator; see
[docs/configuration.md](../../docs/configuration.md#formats).

The remaining registry names (`decimal`, `decimal128`, and the six
`sf-*` structured-field formats) are assertable and not yet
implemented. `oaverify check` reports every unasserted name under
`format-not-validated`, and its message distinguishes a permanent
annotation from a gap a later release may close.

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
