# Migrating to v6

Three changes, and most callers meet only the first two.

**`format` is one registry, and the OpenAPI numeric formats assert.** If
you never pass `formats` and never read `builtInFormats`, this is a
version bump plus one behaviour change: a request whose field is
declared `int32` or `int64` and whose value is out of range is now a
validation error.

**Several string formats got their grammars right.** `uri` and its
siblings stopped delegating to `new URL`, which repaired illegal input
instead of refusing it. These are correctness fixes, and they change
verdicts in both directions, so a value your spec declares `format: uri`
may now be rejected. The per-format sections below say which values.

**`oaverify check` replaces `--only` with `--findings`.** A one-line
edit wherever you invoke it, and the new flag reaches an exact code or a
family where `--only` reached only a class.

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

`false` is the only spelling for this. `true` is refused with an error
naming the format, rather than taken as a second way to say the same
thing.

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

## Breaking: `uri` and `iri` match the grammar, not `new URL`

`uri`, `uri-reference`, `iri` and `iri-reference` now match the RFC 3986
and RFC 3987 grammars directly. They used to hand the value to
`new URL()`, which is a parser with repairs rather than a grammar
checker, so it was wrong in both directions at once.

It **accepts more** than before, in one place: a host that looks like a
dotted-decimal address but is not a valid one. `IPv4address` is a subset
of `reg-name` in the grammar, so `http://087.10.0.1/` and
`http://999.999.999.999/` are legal URIs. `new URL` read them as
addresses and threw. If you were relying on `format: uri` to reject
these, that check was never the grammar's to make; validate the host
with `format: ipv4` or your own rule.

It **rejects more** everywhere else, because `new URL` silently repaired
illegal input instead of refusing it:

| Value                              | Before   | Now      | Why                           |
| ---------------------------------- | -------- | -------- | ----------------------------- |
| `https://example.org/foobar<>.txt` | accepted | rejected | percent-encoded to `%3C%3E`   |
| `https://example.org/foobar\.txt`  | accepted | rejected | backslash rewritten to `/`    |
| `http://example.com/%6G`           | accepted | rejected | non-hex digit in a triplet    |
| `http://example.com/%`             | accepted | rejected | lone percent sign             |
| `https://[@example.org/test.txt`   | accepted | rejected | `[` moved into userinfo       |
| `https://example.org/foobar®.txt`  | accepted | rejected | non-ASCII is `iri`, not `uri` |

Browsers accept those because they repair them. The grammar does not,
and under the OpenAPI dialects `format` is an assertion, so they now
fail validation.

The most likely thing to break is a spec that declares `format: uri` on
a field carrying a value with `|`, `^`, a backtick, `{}`, or unescaped
non-ASCII. Those are legal in an **IRI** but not a URI, so the fix is
usually `format: iri` or `format: iri-reference`. To opt out of the
assertion entirely, `formats: { uri: false }` registers the name and
checks nothing.

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

## Breaking: `--only` becomes `--findings`

```
oaverify check spec.yaml --findings schema,redos      # was --only schema,redos
oaverify check spec.yaml --findings -unused-tag       # no --only equivalent
oaverify check spec.yaml --findings 'schema,-unsatisfiable/*'
```

Terms use `--severity`'s key grammar, so one can be an exact code, a
family as `name/*`, or a class, and `-` excludes. Order never matters.
Naming `malformed` is refused in either direction.

The sign carries a difference `--only` could not express. A term without
`-` decides which checks run, so it is how a run avoids work: on a 7.6MB
document `--findings hygiene` is 0.2 seconds against 13, and 136MB
against 2.7GB. A term with `-` drops findings the checks produced, so it
reports an exact count and can never hide something a check had to run
to find. That is what keeps a malformed schema unsuppressable:
`--findings -schema` still compiles and still exits 4.

See [strictness.md](./strictness.md#which-findings-you-get---findings).

## Checklist

1. Run your test suite. A failure naming `must match format int32` or
   `must match format int64` is this release finding a payload that
   overflows a consumer's integer.
2. Grep for `builtInFormats`. Reading a value as a function needs a
   narrow or `normalizeFormat`.
3. Grep your Ajv format map for `type: "number"`. Those definitions now
   run against numbers.
4. If you need a numeric format off, `formats: { int64: false }`.
5. Grep your specs for `format: uri` and `format: uri-reference`. A
   field whose values carry `|`, `^`, a backtick, `{}` or non-ASCII
   wants `iri` / `iri-reference` instead.
