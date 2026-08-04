# Migrating to v6

v6 is one change with one consequence: **`format` is one registry, and
the OpenAPI numeric formats assert.**

If you never pass `formats` and never read `builtInFormats`, the upgrade
is a version bump plus one behaviour change to know about: a request
whose field is declared `int32` or `int64` and whose value is out of
range is now a validation error. That is the whole migration for most
callers.

## Why `int32` started rejecting

It always should have. In one schema, under one dialect, before v6:

```ts
const schema = {
  type: "object",
  properties: {
    when: { type: "string", format: "date-time" },
    n: { type: "integer", format: "int32" },
  },
};

validator.validateRequest({ ...req, body: { when: "not-a-date", n: 1 } });
// -> invalid: must match format date-time

validator.validateRequest({ ...req, body: { when: "2026-01-01T00:00:00Z", n: 3000000000 } });
// -> valid, before v6
```

`3000000000` overflows the `int` of every consumer that reads that
field, and nothing in the tool noticed. Both OpenAPI dialects have
carried the format-assertion vocabulary since they existed, and every
string format has been binding the whole time. The numeric predicates
were never written. This is lenience going away rather than a policy
being tightened.

## What to do if you do not want it

Per format, in the same registry:

```ts
createValidator(spec, { formats: { int64: false } });
```

`false` registers the name and asserts nothing, so the format stays an
annotation. It reads the same for any format, so turning off a string
one is the same spelling, and turning `int64` off leaves `int32`
asserting.

## `int64` accepts less than int64, on purpose

`int64` asserts the **safe-integer** range, `-(2^53 - 1)` through
`2^53 - 1`, and rejects outside it.

A JSON number past 2^53 has already lost precision before any
JavaScript validator sees it. `JSON.parse("9223372036854775807")`
yields `9223372036854775808`, a different number, and nothing
downstream can recover the original. Rejecting it says so. Accepting it
would vouch for a value that is provably not the one that was sent.

If a producer you cannot change sends large int64s as JSON numbers,
`formats: { int64: false }` turns the assertion off and the payload is
still wrong; the durable fix is to send them as strings.

`float` and `double` are not asserted and will not be. Every JSON
number is already an IEEE 754 double, so `double` asserts nothing, and
a `Math.fround`-based `float` rejects values a producer legitimately
sent. `oaverify check` continues to report both under
`format-not-validated`.

## The `formats` option takes more shapes

A bare function still works and still means a string format:

```ts
formats: { "x-internal-id": (value) => value.startsWith("id_") }   // unchanged
```

Constraining numbers says the type out loud:

```ts
formats: { "x-basis-points": { type: "number", validate: (n) => n >= 0 && n <= 10000 } }
```

A bare function is **always** a string format, including under a name
whose built-in constrains numbers. `formats: { int32: (v) => ... }`
receives strings and the numeric assertion is gone. Inferring the type
from the name would make two identical-looking entries mean different
things by way of a table you cannot see, and be silent when it guessed
wrong.

## Breaking: `builtInFormats` values are `FormatDefinition`

| Before                                       | Now                                |
| -------------------------------------------- | ---------------------------------- |
| `Record<string, (value: string) => boolean>` | `Record<string, FormatDefinition>` |

At runtime the 18 string entries are still the bare predicate
functions, so `builtInFormats["email"]("x")` still returns a boolean.
TypeScript will stop you, because the value type is now a union that
includes objects and `false`. Narrow it, or go through `normalizeFormat`:

```ts
import { normalizeFormat } from "@oaverify/core/core";

const email = normalizeFormat(builtInFormats["email"]!);
email?.validate; // the predicate, whatever spelling the entry used
```

`normalizeFormat` returns `null` for `false`: registered, asserting
nothing. `undefined` from the map means not registered at all, and the
two are deliberately distinguishable.

Passing the registry on is unaffected:

```ts
compileSchema(schema, { dialect, formats: builtInFormats }); // unchanged
```

## Breaking: `fromAjvFormats` routes `type: "number"`

Its return type widens the same way, and its behaviour changes for one
input. An Ajv definition declaring `type: "number"` used to be dropped
into the string map, where it was handed strings on every call. It is
now carried through as a numeric format and handed numbers.

```ts
createValidator(spec, { formats: fromAjvFormats(myAjvFormats) }); // unchanged call
```

**Check this one if your Ajv map has `type: "number"` entries.** The
old behaviour was a validator that could not do its job; the new
behaviour is a validator that can, and a format that was silently inert
may now reject payloads it always should have.

## New: `--skip` on `oaverify check`

Not breaking, and it may replace a post-processing step you have.

```
oaverify check spec.yaml --skip format-not-validated
oaverify check spec.yaml --skip 'unsatisfiable/*,unused-tag'
```

Same key grammar as `--severity`: an exact code, a family as `name/*`,
or a class. A skipped finding is not produced, so `--fail-on` cannot
see it and the summary does not count it, and every key given is
reported with what it dropped, including keys that dropped nothing.
`malformed` cannot be skipped.

See [strictness.md](./strictness.md#when-you-do-not-want-the-finding-at-all).

## Checklist

1. Run your test suite. A failure naming `must match format int32` or
   `must match format int64` is this release finding a payload that
   overflows a consumer's integer.
2. Grep for `builtInFormats`. Reading a value as a function needs a
   narrow or `normalizeFormat`.
3. Grep your Ajv format map for `type: "number"`. Those definitions now
   run against numbers.
4. If you need a numeric format off, `formats: { int64: false }`.
