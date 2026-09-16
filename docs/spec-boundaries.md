# Spec boundaries

Every place oaverify knowingly behaves differently from a specification it
implements, what the difference is, and why it stops there.

This page is generated from the `@specBoundary` tags in the source. Each
entry links the declaration that carries it, so the reasoning is one click
from the code rather than a copy of it.

**What absence means.** A declaration that cites a specification and carries
no boundary is claiming it implements the cited text as written. That is the
point of the tags, and it is what makes this page worth reading: the gaps are
enumerated, so the rest is a claim somebody can check. What the gate behind it
cannot check is completeness, so this is every boundary that has been written
down, not a proof that none is missing.

**How to read a kind.** Each answers one question: how does our behaviour
differ from the cited text?

| kind | meaning | count |
| ---- | ------- | ----- |
| [`under-asserts`](#under-asserts) | accepts what the cited spec forbids | 24 |
| [`narrows`](#narrows) | rejects what the cited spec allows | 11 |
| [`transforms`](#transforms) | accepts the same set, but the value handed on differs | 3 |
| [`chooses`](#chooses) | the spec grants latitude, and this picked one option | 6 |
| [`resolves`](#resolves) | the spec is silent or self-contradictory, and this picked a reading | 3 |
| [`defers`](#defers) | the cited spec requires it and this does not implement it yet | 7 |

54 boundaries across 30 files.

## under-asserts

Accepts what the cited spec forbids.

### packages/check

**`checkSpec`** ([packages/check/src/check.ts:162](../packages/check/src/check.ts#L162))

Against OpenAPI 3.1 Schema Object (<https://spec.openapis.org/oas/v3.1.0#schema-object>).

A Schema Object in a 3.1 or 3.2 document passes conformance whatever
it holds: `xml: 5`, an `externalDocs` with no `url`, a non-object
`discriminator`. The published 3.1 and 3.2 meta-schemas stub the slot
while 3.0 spells its fixed fields out, so the conformance pass checks
Schema Objects on 3.0 only. The verdict "this document conforms" is
this function's, so the gap is too, even though the stub is
upstream's.

**`checkSpec`** ([packages/check/src/check.ts:162](../packages/check/src/check.ts#L162))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.1.1>).

A `$schema` written in an ordinary subschema is ignored and produces
no finding, though JSON Schema says it "MUST NOT appear in
non-resource root schema objects". Only a schema root or an
`$id`-bearing resource changes dialect, which the paragraph above
states as a capability; this says what a document declaring one
elsewhere gets back, which is silence from a tool whose job is to
report what is wrong with it.

### packages/core

**`method`** ([packages/core/src/types.ts:549](../packages/core/src/types.ts#L549))

Against RFC 9110 section 9.1 (<https://www.rfc-editor.org/rfc/rfc9110#section-9.1>).

A request whose method token is `Get` reaches the `get` operation
and is validated against it, where HTTP defines the method token as
case-sensitive and standardized methods as all-uppercase. The
lowercasing is unconditional, so a token HTTP treats as a distinct
method is folded into a documented one rather than being refused.
An adapter reading from a real HTTP parser never sees a mixed-case
token; `httpRequestFromFetch` and direct API callers can pass one.

### packages/formats

**`validateByte`** ([packages/formats/src/base64.ts:34](../packages/formats/src/base64.ts#L34))

Against RFC 4648 section 4 (<https://datatracker.ietf.org/doc/html/rfc4648#section-4>).

A MIME-wrapped value passes, where RFC 4648 admits whitespace only
if the referring specification says so and the registry cites RFC
4648 plainly. Whitespace is stripped before the check. The paragraphs
above have the reasoning, and `validateByteRfc4648` is the literal
reading for callers who want it.

**`validateByte`** ([packages/formats/src/base64.ts:34](../packages/formats/src/base64.ts#L34))

Against RFC 4648 section 3.5 (<https://datatracker.ietf.org/doc/html/rfc4648#section-3.5>).

A value whose final group has non-zero unused bits passes, so `"cE6="`
is accepted and does not survive a decode and re-encode. Section 3.5
requires those bits to be zero. Rejecting it would mean decoding
every value on the hot path to catch a case no encoder produces,
which is what Ajv and the rest of the ecosystem also decline to do.

**`validateTimeLocal`** ([packages/formats/src/date.ts:185](../packages/formats/src/date.ts#L185))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A `:60` second passes at any minute. The registry defines this as RFC
3339 `partial-time`, whose `time-second` admits `:60` only where the
leap-second rules put one, and with no offset there is no instant to
check a leap second against. `validateTime`, which has one, does
apply the rule.

**`validateDateTimeLocal`** ([packages/formats/src/date.ts:208](../packages/formats/src/date.ts#L208))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A `:60` second passes at any minute, for the reason
`validateTimeLocal` gives: with no offset there is no instant to
check a leap second against.

**`validateIdnHostname`** ([packages/formats/src/hostname.ts:52](../packages/formats/src/hostname.ts#L52))

Against RFC 5890 section 2.3.2.1 (<https://datatracker.ietf.org/doc/html/rfc5890#section-2.3.2.1>).

A name of any total length passes, however many labels it carries.
The RFC's cap is on the encoded A-label form and this does not
punycode, so there is no encoded length to measure (#669).

**`validateIdnHostname`** ([packages/formats/src/hostname.ts:52](../packages/formats/src/hostname.ts#L52))

Against RFC 5891 section 4.2 (<https://datatracker.ietf.org/doc/html/rfc5891#section-4.2>).

A label that IDNA registration would refuse passes. This is a
structural check rather than the section 4.2 validity procedure: no
UTS 46 mappings, no `xn--` A-label validation, and neither the
contextual rules (section 4.2.3.3) nor the bidi rule (section
4.2.3.4). The one section 4.2.3 rule it does apply is leading
combining marks, which is what the declaration cites.

**`validateHttpDate`** ([packages/formats/src/http-date.ts:52](../packages/formats/src/http-date.ts#L52))

Against RFC 9110 section 5.6.7 (<https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.7>).

The day name is not checked against the date, so `"Mon, 06 Nov 1994
08:49:37 GMT"` passes even though that day was a Sunday. Nothing in
RFC 9110 asks a recipient to verify it, and a mismatch is a
producer's clerical error rather than a value the reader cannot use.

**`validateHttpDate`** ([packages/formats/src/http-date.ts:52](../packages/formats/src/http-date.ts#L52))

Against RFC 9110 section 5.6.7 (<https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.7>).

`"Sunday, 29-Feb-94 08:49:37 GMT"` passes, though 1994 had no
February 29th: an RFC 850 date's day-of-month check treats February
as having 29 days. Section 5.6.7 says how to read the two-digit year:
a timestamp
more than 50 years in the future names the most recent past year
ending in those digits. Applying that here would make the verdict
depend on the clock, so `"29-Feb-24"` would turn invalid some time
after 2074. A validator that changes its mind about a fixed input is
worse than one that accepts a February 29th in a year that had none.
A four-digit year gets the exact check, leap years included.

**`builtInFormats`** ([packages/formats/src/index.ts:83](../packages/formats/src/index.ts#L83))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A `float` value outside the float32 set is accepted, and that one is
declined rather than pending. `Math.fround(n) === n` decides
membership exactly, so it could be asserted; asserting it would
reject values a producer legitimately sent, since the float32 nearest
3.14 serializes as `3.14`, the shortest string that round-trips, and
that fails the test. `double` is outside both boundaries: every JSON
number is already an IEEE 754 double, so the name has nothing left to
assert.

**`validateLanguage`** ([packages/formats/src/language.ts:93](../packages/formats/src/language.ts#L93))

Against RFC 5646 section 2.2.9 (<https://datatracker.ietf.org/doc/html/rfc5646#section-2.2.9>).

A tag whose subtags are not registered with IANA passes, so `"qq-ZZ"`
is accepted with a language and a region that do not exist. Section
2.2.9 makes registration one of three validity conditions beyond
well-formedness; the other two, no repeated variant and no repeated
extension singleton, are asserted here because they are properties of
the tag itself. The paragraphs above have the reasoning: the registry is a
~1MB file on IANA's release schedule, and a validator that silently
goes stale is worse than one that states where it stops.

**`validateUuid`** ([packages/formats/src/misc.ts:9](../packages/formats/src/misc.ts#L9))

Against RFC 9562 section 4.1 (<https://datatracker.ietf.org/doc/html/rfc9562#section-4.1>).

A UUID carrying an undefined version passes. This checks shape only,
8-4-4-4-12 hex digits with the dashes in place, so neither the
version (section 4.2) nor the variant (section 4.1) nibble is
asserted.

Asserting them is the wrong fix rather than the unwritten one. The
section 4.1 variant table assigns all sixteen nibble values, and the
Nil UUID (section 5.9) and Max UUID (section 5.10) are both defined
as valid while explicitly falling outside this document's own
variant. A version-and-variant regex would reject two UUIDs the RFC
names, which is the false reject the permissive lean exists to
avoid.

**`validateUnixtime`** ([packages/formats/src/numeric.ts:205](../packages/formats/src/numeric.ts#L205))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A string-valued `unixtime` is not asserted at all. The registry gives
the format two base types, `number` and `string`; a format constrains
one JSON type here (see `FormatDefinition`), and this is the number
one.

**`validateUriTemplate`** ([packages/formats/src/uri.ts:194](../packages/formats/src/uri.ts#L194))

Against RFC 6570 section 2 (<https://datatracker.ietf.org/doc/html/rfc6570#section-2>).

A template carrying an apostrophe (`/a'b`), a C1 control or a Unicode
noncharacter passes, and the `literals` rule admits none of the
three. Its comment excludes CTL, SP, DQUOTE, the apostrophe, a `%`
outside a pct-encoded triplet, and the eight punctuation marks from
less-than to right brace; the class here omits the apostrophe and
stops excluding at U+007F, so everything above that passes.

Narrowing it to the ranges the rule lists is tracked as #965. The
class was last widened to stop rejecting an ideographic space (#854),
which is the direction the error has to fall: over-accepting a
template is recoverable, and rejecting a real one is not.

### packages/metaschema

**`metaschemaFor`** ([packages/metaschema/src/index.ts:123](../packages/metaschema/src/index.ts#L123))

Against OpenAPI 3.1.0 (<https://spec.openapis.org/oas/v3.1.0#schema-object>).

A Schema Object in a 3.1 or 3.2 document is checked only for being an
object or a boolean, because those meta-schemas stub the slot
(`$dynamicAnchor: "meta"`). The 3.0 document spells the object out,
so a malformed `xml` or `externalDocs` inside a schema is a finding
on 3.0 and silence on 3.1.

### packages/oav-express4

**`renderProblemDetails`** ([packages/oav-express4/src/render.ts:9](../packages/oav-express4/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request refused for a missing or malformed credential is answered
401 with no `WWW-Authenticate` header, where RFC 9110 says the server
generating one MUST send a challenge. The `security` leaf carries the
declared scheme names and not the challenge strings, so the adapter
cannot build one; an application serving 401 supplies the header in
its own `onError` (#1087). 415 and 413 mandate no header: RFC 9110
says `Accept` "can be used" on a 415, and requires `Retry-After` only
where the condition is temporary, which a fixed byte cap is not.

### packages/oav-express5

**`renderProblemDetails`** ([packages/oav-express5/src/render.ts:9](../packages/oav-express5/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request refused for a missing or malformed credential is answered
401 with no `WWW-Authenticate` header, where RFC 9110 says the server
generating one MUST send a challenge. The `security` leaf carries the
declared scheme names and not the challenge strings, so the adapter
cannot build one; an application serving 401 supplies the header in
its own `onError` (#1087). 415 and 413 mandate no header: RFC 9110
says `Accept` "can be used" on a 415, and requires `Retry-After` only
where the condition is temporary, which a fixed byte cap is not.

### packages/oav-fastify

**`renderProblemDetails`** ([packages/oav-fastify/src/render.ts:9](../packages/oav-fastify/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request refused for a missing or malformed credential is answered
401 with no `WWW-Authenticate` header, where RFC 9110 says the server
generating one MUST send a challenge. The `security` leaf carries the
declared scheme names and not the challenge strings, so the adapter
cannot build one; an application serving 401 supplies the header in
its own `onError` (#1087). 415 and 413 mandate no header: RFC 9110
says `Accept` "can be used" on a 415, and requires `Retry-After` only
where the condition is temporary, which a fixed byte cap is not.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:435](../packages/router/src/matcher.ts#L435))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

A document declaring `/items/{id}` for GET and `/items/{slug}` for
POST builds a router, though the Paths Object says templated paths
"with the same hierarchy but different templated names MUST NOT exist
as they are identical". The ambiguity check refuses them only where
they overlap on a method, so no request can reach both; refusing the
pair outright would reject documents that are published and served
today.

### packages/schema

**`unknownFormats`** ([packages/schema/src/compiler/compiler.ts:1261](../packages/schema/src/compiler/compiler.ts#L1261))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7.2.3>).

Under `openapi31Dialect` or `oas30Dialect`, a schema
carrying an unregistered format compiles by default and that format
asserts nothing. Both declare the Format-Assertion vocabulary, and
the spec says "When the Format-Assertion vocabulary is specified,
implementations MUST fail upon encountering unknown formats", so
`"error"` is the conformant setting under those two and is not the
default. The default is permissive because a real document names
formats no validator has, and refusing to compile it is a worse
first experience than not asserting them.

**`multipleOfKeyword`** ([packages/schema/src/keywords/number.ts:32](../packages/schema/src/keywords/number.ts#L32))

Against JSON Schema 2020-12 validation section 6.2.1 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-6.2.1>).

A number whose quotient lands within a relative epsilon of an integer
passes, so a value that is not exactly a multiple can validate. The
spec says an instance "is valid only if division by this keyword's
value results in an integer", and binary floating point cannot decide
that for the decimal values schemas actually carry: `0.1` divided by
`0.01` is not an integer in IEEE 754. The tolerance is what makes
`multipleOf: 0.01` mean what its author meant; the paragraphs above
carry the measurements it was set from.

### packages/validator

**`maxFormatLength`** ([packages/validator/src/validator.ts:843](../packages/validator/src/validator.ts#L843))

Against JSON Schema 2020-12 validation section 7 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7>).

A string longer than the cap is accepted whatever its `format`
says, so an invalid value above 1 MiB passes where a shorter one
would fail. This falls back to the annotation-only behaviour JSON
Schema specifies as its default rather than inventing a verdict.

## narrows

Rejects what the cited spec allows.

### packages/cli

**`unknownFormats`** ([packages/cli/src/emit-standalone.ts:40](../packages/cli/src/emit-standalone.ts#L40))

Against JSON Schema 2020-12 validation section 7.2.3 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7.2.3>).

A schema whose `format` is outside the built-in set is refused
whatever the dialect's format vocabulary says, so `2020-12` with
`{"type":"string","format":"phone"}` fails to emit. Under the
Format-Annotation vocabulary, which is the default, the spec says
an implementation "MUST NOT fail to collect unknown formats as
annotations"; failing on one belongs to Format-Assertion. Refusing
at emit time is the conservative half of a build step, and
`"ignore"` is the conformant setting.

### packages/formats

**`validateInt64`** ([packages/formats/src/numeric.ts:123](../packages/formats/src/numeric.ts#L123))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A legal int64 between `2^53` and `2^63` is rejected. The registry's
`int64` is the full signed 64-bit range, and this accepts the safe
integers. The paragraphs above have the reasoning: such a value has
already lost precision in `JSON.parse`, so accepting it would vouch
for a number that is provably not the one on the wire.

**`validateUint64`** ([packages/formats/src/numeric.ts:154](../packages/formats/src/numeric.ts#L154))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A legal uint64 above `2^53 - 1` is rejected, where the registry's
`uint64` is the full unsigned 64-bit range, for the reason
`validateInt64` gives.

**`validateUnixtime`** ([packages/formats/src/numeric.ts:205](../packages/formats/src/numeric.ts#L205))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A legal unixtime above `2^53 - 1` is rejected, where POSIX puts no
upper bound on the epoch count. Same argument as `validateInt64`:
past that point the value has already lost precision and is provably
not the count that was sent.

### packages/overlay-spec

**`translateOverlay`** ([packages/overlay-spec/src/index.ts:78](../packages/overlay-spec/src/index.ts#L78))

Against OpenAPI Overlay 1.0 (<https://spec.openapis.org/overlay/v1.0.0.html>).

An overlay that removes a node and later re-creates it is refused as
a self-conflict, though Overlay 1.0 applies actions "in sequential
order", each to the result of the last, which makes that legal. Every
action here accumulates into one typed `SpecOverlay` applied once,
and its verbs have no ordering between them.

**`parseTarget`** ([packages/overlay-spec/src/parse-target.ts:63](../packages/overlay-spec/src/parse-target.ts#L63))

Against OpenAPI Overlay 1.0 (<https://spec.openapis.org/overlay/v1.0.0.html>).

An overlay whose `target` uses recursive descent, a slice, a function
extension or a member name outside `[A-Za-z0-9_-]` is refused with
`UnrecognisedTargetError`, though Overlay 1.0 defines `target` as any
RFC 9535 JSONPath query and names no conformance subset. The
recognised set is the OAS axes the typed `SpecOverlay` verbs can
express: a general engine would return matches with no verb to apply
them through, so the refusal is where the translation stops rather
than where the parser does.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:435](../packages/router/src/matcher.ts#L435))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

A document declaring both `/a` and `/a/` fails to build, and a
request for `/pets/` routes to the `/pets` template. OpenAPI
constrains a path key only to begin with `/`, and RFC 3986 makes a
trailing empty segment a real segment, so the two are distinct keys
there. The router folds a trailing slash away on both sides, because
a server answering one answers the other.

### packages/schema

**`maxDepth`** ([packages/schema/src/compiler/compiler.ts:1175](../packages/schema/src/compiler/compiler.ts#L1175))

Against JSON Schema 2020-12 core section 8.2.3 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3>).

Once set, an instance nested deeper than the cap is invalid, and
JSON Schema puts no depth limit on an instance a recursive `$ref`
accepts. The alternative at that depth is not acceptance: recursion
runs on the native call stack, so an uncapped validator throws
`RangeError` somewhere past a few thousand frames. This trades a
crash for a verdict, and the cap is the caller's to choose.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:238](../packages/spec/src/resolver.ts#L238))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.2>).

A `$ref` whose fragment is a plain-name `$anchor` (`pet.json#Pet`) is
rejected with an invalid-pointer error rather than resolved. The
hoisting path reads every fragment as a JSON Pointer. Deliberate: an
anchor was an error before hoisting existed and stays one, rather
than quietly becoming an internal ref to an address that does not
exist.

### packages/syntax

**`parseYamlDocument`** ([packages/syntax/src/index.ts:102](../packages/syntax/src/index.ts#L102))

Against YAML 1.2.2 (<https://yaml.org/spec/1.2.2/>).

A document whose aliases expand past the parser's alias budget is
refused, though YAML 1.2 places no limit on alias reuse and says a
node "could even contain itself". The cap is the billion-laughs guard
the `yaml` package applies by default, and a spec that permits a
cyclic representation graph cannot be implemented without one.

### packages/validator

**`maxDepth`** ([packages/validator/src/validator.ts:818](../packages/validator/src/validator.ts#L818))

Against JSON Schema 2020-12 core section 8.2.3 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3>).

Once set, a body nested deeper than the cap is a 400, and JSON
Schema puts no depth limit on an instance a recursive `$ref`
accepts. `CompileOptions.maxDepth` carries the same boundary at the
compiler; this is the HTTP-facing half of it.

## transforms

Accepts the same set, but the value handed on differs.

### packages/core

**`cookies`** ([packages/core/src/types.ts:581](../packages/core/src/types.ts#L581))

Against OpenAPI 3.2 style values (<https://spec.openapis.org/oas/v3.2.0#style-values>).

A `style: cookie` value carrying a valid percent-escape reaches the
handler decoded, where the style says no escaping is applied. The
set of accepted requests is unchanged; the value handed on is not.
The adapter runs before any spec is read, so it cannot see the
style to tell `form` and `cookie` apart, and decoding is right for
the default of the two.

### packages/metaschema

**`metaschemaFor`** ([packages/metaschema/src/index.ts:123](../packages/metaschema/src/index.ts#L123))

Against the OpenAPI 3.0 schema (<https://spec.openapis.org/oas/3.0/schema/2024-10-18>).

A 3.0 document is validated against this repo's draft-04-to-2020-12
conversion of OpenAPI's published schema rather than the published
bytes; 3.1 and 3.2 are vendored verbatim. The conversion is three
mechanical edits (`id` to `$id`, the `$schema` URI, and the boolean
`exclusiveMinimum` / `exclusiveMaximum` pairs rewritten to numeric
bounds) and it refuses any draft-04 construct it does not handle, so
a divergence here would be ours rather than upstream's. See
`scripts/convert-oas30.mjs`.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:238](../packages/spec/src/resolver.ts#L238))

Against OpenAPI 3.1 section 4.6 (<https://spec.openapis.org/oas/v3.1.0#relative-references-in-uris>).

A schema-position reference to `pet.yaml#/components/schemas/Pet`
comes back as `#/components/schemas/Pet`, with the target mounted in
the entry document under a derived name that nobody authored. The
spec says what a reference resolves to and not what a resolved
document has to look like. Keeping an address rather than copying the
target per use site is what `discriminator.mapping` matches branches
by (#553) and what gives a recursive external schema a legal home
(#556).

## chooses

The spec grants latitude, and this picked one option.

### packages/oav-express4

**`renderProblemDetails`** ([packages/oav-express4/src/render.ts:9](../packages/oav-express4/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

A refused request is answered with `title: "Validation failed"`
whatever status it carries, where the registered `about:blank` type
asks that the title "SHOULD be the same as the recommended HTTP
status phrase for that code". The `issues` extension rides on that
type for the same reason: a list of failing leaves is the whole point
of the renderer, and inventing a problem-type URI oaverify does not
host would be worse than reusing the one that means "no semantics
beyond the status".

### packages/oav-express5

**`renderProblemDetails`** ([packages/oav-express5/src/render.ts:9](../packages/oav-express5/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

A refused request is answered with `title: "Validation failed"`
whatever status it carries, where the registered `about:blank` type
asks that the title "SHOULD be the same as the recommended HTTP
status phrase for that code". The `issues` extension rides on that
type for the same reason: a list of failing leaves is the whole point
of the renderer, and inventing a problem-type URI oaverify does not
host would be worse than reusing the one that means "no semantics
beyond the status".

### packages/oav-fastify

**`renderProblemDetails`** ([packages/oav-fastify/src/render.ts:9](../packages/oav-fastify/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

A refused request is answered with `title: "Validation failed"`
whatever status it carries, where the registered `about:blank` type
asks that the title "SHOULD be the same as the recommended HTTP
status phrase for that code". The `issues` extension rides on that
type for the same reason: a list of failing leaves is the whole point
of the renderer, and inventing a problem-type URI oaverify does not
host would be worse than reusing the one that means "no semantics
beyond the status".

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:435](../packages/router/src/matcher.ts#L435))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

A request matching both `/a/{x}/c` and `/{y}/b/c` routes to
`/a/{x}/c`. Two templates that both match are ordered by the first
position where they differ in kind, a literal beating a compound
beating a bare `{name}`. OpenAPI fixes only that a concrete path
beats its templated counterpart and then hands the rest over: "In
case of ambiguous matching, it's up to the tooling to decide which
one to use." Its own example of that case is `/{entity}/me` against
`/books/{id}`. The rule here is the one `path-to-regexp` applies.

### packages/schema

**`unknownFormats`** ([packages/schema/src/compiler/compiler.ts:1261](../packages/schema/src/compiler/compiler.ts#L1261))

Against JSON Schema 2020-12 validation section 7 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7>).

Under `jsonSchemaDialect`, an unrecognised format asserts
nothing by default and this option exists so a caller can make it a
compile error instead. Format-Annotation is the default vocabulary
and supporting Format-Assertion is OPTIONAL, so both settings are
conformant there and the default is the one the spec picks.

### packages/validator

**`transformBodySchemaForDirection`** ([packages/validator/src/body-schema-transform.ts:51](../packages/validator/src/body-schema-transform.ts#L51))

Against JSON Schema 2020-12 validation section 9.4 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-9.4>).

A request body carrying a `readOnly` property is rejected, where the
spec leaves the owning authority free to ignore the field instead:
such an instance "MAY be ignored if sent to the owning authority, or
MAY result in an error, at the authority's discretion". Rejecting is
the half that tells a client its payload was not what it thought.
Stripping the property from `required` is the same choice read the
other way, and the only one that lets a round-tripped GET body be
PUT back.

## resolves

The spec is silent or self-contradictory, and this picked a reading.

### packages/core

**`allowEmptyValue`** ([packages/core/src/types.ts:468](../packages/core/src/types.ts#L468))

Against OpenAPI 3.1 Parameter Object (<https://spec.openapis.org/oas/v3.1.0#parameter-object>).

A `?flag=` on a parameter declaring this is accepted without its
schema running, so a `minLength: 1` or `type: integer` beside it
does not reject it. The spec allows sending the empty value and
calls the interaction between this field and the Schema Object
implementation-defined, so skipping the schema is a reading rather
than a requirement. The alternative reading, running the schema
anyway, makes the field do nothing on most parameters that declare
it.

### packages/schema

**`discriminatorKeyword`** ([packages/schema/src/keywords/discriminator.ts:6](../packages/schema/src/keywords/discriminator.ts#L6))

Against OpenAPI 3.1 Discriminator Object (<https://spec.openapis.org/oas/v3.1.0#discriminator-object>).

A discriminator whose values cannot be matched to the sibling
branches is ignored, and the composition beside it validates every
branch as though the discriminator were absent. The spec says what a
working discriminator does and does not say what a broken one does.
Rejecting every payload because the routing aid could not be read is
the one outcome it rules out, and pre-bundled documents routinely
keep `mapping` values naming files the bundle absorbed (#561). The
dead mapping is reported as `silent-rewrite/discriminator-unroutable`
so the author still learns the table is unused.

### packages/stream-validator

**`createStreamValidator`** ([packages/stream-validator/src/engine/stream-validator.ts:837](../packages/stream-validator/src/engine/stream-validator.ts#L837))

Against RFC 8259 section 4 (<https://www.rfc-editor.org/rfc/rfc8259#section-4>).

An object repeating a member name has every occurrence validated, and
each counted toward `minProperties` / `maxProperties`, where the
in-memory engine and a buffered island see only the last. RFC 8259
says names "SHOULD be unique" and calls the behaviour on duplicates
unpredictable, so neither reading is wrong; which one a value gets
here depends on the schema's shape rather than on any option.

## defers

The cited spec requires it and this does not implement it yet.

### packages/check

**`renderSarif`** ([packages/check/src/sarif.ts:374](../packages/check/src/sarif.ts#L374))

Against SARIF 2.1.0 (<https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html>).

A log carrying regions omits `columnKind`, which section 3.14.27
makes a SHALL once a run's results are non-empty, so a consumer
measuring columns in code points reads every column after an astral
character one too low per surrogate pair. The columns emitted are
UTF-16 code units, which is what the span resolver produces, so the
value to declare is `"utf16CodeUnits"` (#1091).

### packages/formats

**`builtInFormats`** ([packages/formats/src/index.ts:83](../packages/formats/src/index.ts#L83))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A value declaring a registry format this map does not carry is
accepted whatever it holds, because the name asserts nothing. The
assertable names still outstanding are tracked in #696.
`@oaverify/check`'s format pass reports them, so an author is told
which of their formats constrain nothing rather than assuming all of
them do.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:435](../packages/router/src/matcher.ts#L435))

Against OpenAPI 3.2.0 (<https://spec.openapis.org/oas/v3.2.0#path-item-object>).

A request using a method declared under 3.2's `additionalOperations`
answers 405, with that method absent from `allowed`, rather than
routing to the operation the document declares for it. The method
table is the `HttpMethod` union and the lookup lowercases, so a
camelCase map key cannot be reached (#396). A 405 is a claim, and it
contradicts the document.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:238](../packages/spec/src/resolver.ts#L238))

Against OpenAPI 3.1 section 4.6 (<https://spec.openapis.org/oas/v3.1.0#relative-references-in-uris>).

A relative `$ref` written under a subschema that declares `$id`
resolves against the containing file's directory, so it reads a
different document than the one the spec names. Section 4.6 makes the
nearest parent `$id` the base URI; nothing here reads `$id` at all
(#1088).

### packages/stream-validator

**`createStreamValidator`** ([packages/stream-validator/src/engine/stream-validator.ts:837](../packages/stream-validator/src/engine/stream-validator.ts#L837))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3.2>).

A schema this engine accepts can reach a different verdict here than
through `@oaverify/core`, and construction does not warn. A
`$dynamicRef` binds to the first matching anchor in the document
rather than to the outermost one in the dynamic scope, so an
extension schema the in-memory engine applies is never reached; a
plain-name `#name` resolves by the same first-match walk, ignoring
`$id` resource boundaries and conflating `$anchor` with
`$dynamicAnchor` (#1090). A malformed keyword value that
`compileSchema` refuses is loaded here and asserts nothing (#919).

### packages/validator

**`headerParamValidators`** ([packages/validator/src/operation-cache.ts:42](../packages/validator/src/operation-cache.ts#L42))

Against OpenAPI 3.1 Parameter Object (<https://spec.openapis.org/oas/v3.1.0#parameter-object>).

A request omitting a `required` header parameter named `Accept`,
`Content-Type` or `Authorization` is rejected, where the spec says
such a parameter definition "SHALL be ignored". Every declared
header parameter is compiled and enforced here, so a document
declaring one gets a 400 for a definition that does not exist
(#1084).

**`UNIMPLEMENTED_LOCATIONS`** ([packages/validator/src/parameter-locations.ts:85](../packages/validator/src/parameter-locations.ts#L85))

Against OpenAPI 3.2 Parameter Object (<https://spec.openapis.org/oas/v3.2.0#parameter-object>).

A document declaring `in: querystring` is refused at construction, so
a legal 3.2 document this validator cannot serve fails to build
rather than validating. Reading the location needs the raw query
string, which the `HttpRequest` contract does not carry (#397). The
module doc above has the reasoning for refusing rather than ignoring:
the alternative reports a request valid on an operation nothing
checked (#836).

## Regenerating

```bash
pnpm docs:boundaries          # rewrite this page from the tags
pnpm check:boundaries-doc     # assert it matches (runs in `pnpm lint`)
```

Do not edit this file by hand. Edit the `@specBoundary` tag it came from and
regenerate; the gate fails if the two disagree.
