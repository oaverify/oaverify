# Spec boundaries

This inventory records known specification-related behavior in oaverify:
implementation choices, deliberate restrictions, and defects awaiting repair.
Each entry describes the affected behavior and links to its source and
specification.

Use it to identify constraints relevant to your application. Entries differ
in impact, and the same behavior can appear at several API surfaces. The
counts reflect how the behavior is documented; they do not measure defect
severity or conformance.

We collect these details in one place so users can evaluate them before
adoption. Comparing validators requires equivalent inputs, dialects, and
options. The length of a published limitations list does not establish
relative correctness. See [the comparison methodology](comparison.md) for
the comparisons we have measured.

The inventory grows as behavior is examined. Tests and the
[conformance report](../conformance/REPORT.md) provide additional evidence of
coverage; issue links describe pending repairs. A citation identifies the
intended specification contract. The absence of a recorded boundary does not
establish complete conformance.

This page is generated from the `@specBoundary` tags in the source. The gate
checks tag structure and keeps the page current; verifying the claims and
finding omitted boundaries requires review and testing.

**How to read a kind.** Each answers one question: how does our behaviour
relate to the cited text? A kind describes the behavior, not its severity or
whether it is scheduled for repair. A `chooses` entry can describe a
conforming implementation choice.

| kind | meaning | entries |
| ---- | ------- | ----- |
| [`under-asserts`](#under-asserts) | accepts what the cited spec forbids | 30 |
| [`narrows`](#narrows) | rejects what the cited spec allows | 11 |
| [`transforms`](#transforms) | changes the value handed on, which can affect subsequent validation | 5 |
| [`chooses`](#chooses) | the spec grants latitude, and this picked one option | 9 |
| [`resolves`](#resolves) | the spec is silent or self-contradictory, and this picked a reading | 5 |
| [`defers`](#defers) | the cited spec requires it and this does not implement it yet | 4 |

64 documented entries across 32 files.

## under-asserts

Accepts what the cited spec forbids.

### packages/check

**`checkSpec`** ([packages/check/src/check.ts:164](../packages/check/src/check.ts#L164))

Against OpenAPI 3.1 Schema Object (<https://spec.openapis.org/oas/v3.1.0#schema-object>).

In OpenAPI 3.1 and 3.2, the conformance pass misses malformed fields
inside Schema Objects, such as `xml: 5` or `externalDocs` without a
`url`. It uses the published meta-schemas (schemas describing valid
OpenAPI documents), which leave these fields unchecked. The pass checks
them in OpenAPI 3.0 documents. Other passes still check schema validation
rules.

**`checkSpec`** ([packages/check/src/check.ts:164](../packages/check/src/check.ts#L164))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.1.1>).

A `$schema` declaration in a nested schema is ignored without a finding
unless that schema also declares `$id`. JSON Schema allows `$schema` only
at a schema resource's root: the top-level schema, or a nested schema
with its own `$id`. Elsewhere, the nested schema inherits its parent's
dialect (the set of schema rules to apply).

### packages/core

**`SchemaOrBoolean`** ([packages/core/src/types.ts:124](../packages/core/src/types.ts#L124))

Against OpenAPI 3.0.3 Schema Object (<https://spec.openapis.org/oas/v3.0.3#schema-object>).

Runtime and emitted validators compile a boolean body or header schema
in an OpenAPI 3.0 document: `true` accepts supplied values and `false`
rejects them. OpenAPI 3.0 requires a Schema Object at these positions.
This preserves the compiler's boolean semantics across dialects; accepting
the schema for compilation does not establish document conformance.

**`method`** ([packages/core/src/types.ts:605](../packages/core/src/types.ts#L605))

Against RFC 9110 section 9.1 (<https://www.rfc-editor.org/rfc/rfc9110#section-9.1>).

A request with method `Get` is matched to the OpenAPI `get` operation,
just like `GET`. oaverify lowercases method names before routing,
although HTTP defines method names as case-sensitive.

### packages/formats

**`validateByte`** ([packages/formats/src/base64.ts:34](../packages/formats/src/base64.ts#L34))

Against RFC 4648 section 4 (<https://datatracker.ietf.org/doc/html/rfc4648#section-4>).

Base64 strings containing ASCII whitespace, such as line breaks used in
MIME messages, are accepted. The validator removes that whitespace before
checking the encoding. RFC 4648 requires explicit permission to allow
whitespace, which the OpenAPI format definition does not give. To reject
whitespace, register `formats: { byte: validateByteRfc4648 }`.

**`validateByte`** ([packages/formats/src/base64.ts:34](../packages/formats/src/base64.ts#L34))

Against RFC 4648 section 3.5 (<https://datatracker.ietf.org/doc/html/rfc4648#section-3.5>).

Some base64 strings are accepted even though decoding and re-encoding
changes their spelling. For example, `"cE6="` becomes `"cE4="`. RFC 4648
requires encoders to set the unused bits in the final encoded group to
zero for a canonical encoding, but lets decoders accept nonzero bits.
This validator checks the alphabet and padding without requiring that
canonical spelling. `validateByteRfc4648` also accepts nonzero pad bits;
its stricter check rejects whitespace.

**`validateTimeLocal`** ([packages/formats/src/date.ts:185](../packages/formats/src/date.ts#L185))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A local time with seconds set to `60`, such as `12:34:60`, is accepted at
any minute. The format definition reserves `60` for leap seconds, but a
local time has no time-zone offset to check its position against UTC. The
offset-aware `time` format does check that position.

**`validateDateTimeLocal`** ([packages/formats/src/date.ts:207](../packages/formats/src/date.ts#L207))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

A local date-time with seconds set to `60`, such as
`2024-01-01T12:34:60`, is accepted at any minute. The format definition
reserves `60` for leap seconds, but this format has no time-zone offset
to check their position against UTC.

**`validateIdnHostname`** ([packages/formats/src/hostname.ts:52](../packages/formats/src/hostname.ts#L52))

Against RFC 5890 section 2.3.2.1 (<https://datatracker.ietf.org/doc/html/rfc5890#section-2.3.2.1>).

An internationalized hostname can exceed DNS's total length limit and
still pass validation. That limit applies to the ASCII encoding of the
name, including any Punycode-encoded Unicode labels. This validator
checks each dot-separated part but does not encode and measure the whole
name (#669).

**`validateIdnHostname`** ([packages/formats/src/hostname.ts:52](../packages/formats/src/hostname.ts#L52))

Against RFC 5891 section 4.2 (<https://datatracker.ietf.org/doc/html/rfc5891#section-4.2>).

Some internationalized hostnames pass even though IDNA, the standard for
internationalized domain names, would reject them. The validator checks
basic character and label structure. It does not fully validate encoded
`xn--` labels or apply rules for characters whose validity depends on
neighboring characters or on mixing right-to-left and left-to-right text.

**`validateHttpDate`** ([packages/formats/src/http-date.ts:52](../packages/formats/src/http-date.ts#L52))

Against RFC 9110 section 5.6.7 (<https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.7>).

A date with the wrong weekday name is accepted. For example, `"Mon, 06
Nov 1994 08:49:37 GMT"` passes even though that date was a Sunday. The
validator checks the weekday's spelling but does not compare it with the
calendar date.

**`validateHttpDate`** ([packages/formats/src/http-date.ts:52](../packages/formats/src/http-date.ts#L52))

Against RFC 9110 section 5.6.7 (<https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.7>).

Dates in the older RFC 850 format, which uses a two-digit year, allow
February 29 in any year. For example, `"Sunday, 29-Feb-94 08:49:37 GMT"`
passes even though 1994 was not a leap year. HTTP's rule for interpreting
the century depends on the current date; this validator does not use the
clock to resolve it. Dates with four-digit years get an exact leap-year
check.

**`builtInFormats`** ([packages/formats/src/index.ts:83](../packages/formats/src/index.ts#L83))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

The `float` format does not check whether a number fits in a 32-bit
floating-point value. This is intentional: a producer can serialize a
float32 as a decimal such as `3.14`, which JavaScript reads as a
different, 64-bit approximation. Requiring exact float32 representation
would reject such values. Applications that need a range limit can set
`minimum` and `maximum`.

**`validateLanguage`** ([packages/formats/src/language.ts:93](../packages/formats/src/language.ts#L93))

Against RFC 5646 section 2.2.9 (<https://datatracker.ietf.org/doc/html/rfc5646#section-2.2.9>).

A language tag with an unregistered language or region, such as
`"qq-ZZ"`, is accepted. The validator checks the tag's syntax, including
restrictions on repeated components, but does not look up those
components in IANA's official language-subtag registry. RFC 5646 requires
registration as well as valid syntax.

**`validateUuid`** ([packages/formats/src/misc.ts:9](../packages/formats/src/misc.ts#L9))

Against RFC 9562 section 4.1 (<https://datatracker.ietf.org/doc/html/rfc9562#section-4.1>).

A UUID with an undefined version is accepted if it has the expected
shape: hexadecimal digits in groups of 8-4-4-4-12, separated by hyphens.
The validator does not restrict the bits identifying its version or
variant. It also accepts the RFC's special all-zero (Nil) and all-one
(Max) UUIDs.

**`validateUnixtime`** ([packages/formats/src/numeric.ts:199](../packages/formats/src/numeric.ts#L199))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

The `unixtime` format checks numeric timestamps only. A string is not
checked as a timestamp, even though the OpenAPI registry also allows a
string representation. Other schema constraints still apply: for example,
`type: number` rejects a string.

**`validateUriTemplate`** ([packages/formats/src/uri.ts:194](../packages/formats/src/uri.ts#L194))

Against RFC 6570 section 2 (<https://datatracker.ietf.org/doc/html/rfc6570#section-2>).

URI templates containing C1 control characters (U+0080 through U+009F)
or Unicode noncharacters, such as U+FFFF, are accepted. RFC 6570's
literal character ranges exclude these code points. Tightening the
check is tracked in #965.

### packages/metaschema

**`metaschemaFor`** ([packages/metaschema/src/index.ts:123](../packages/metaschema/src/index.ts#L123))

Against OpenAPI 3.1.0 (<https://spec.openapis.org/oas/v3.1.0#schema-object>).

For OpenAPI 3.1 and 3.2, the meta-schema only checks that a Schema Object
is an object or a boolean. It leaves fields inside it unchecked, so
malformed `xml` or `externalDocs` fields can pass. The meta-schema is the
schema used to check an OpenAPI document's structure; the published 3.0
version describes these fields and catches those errors.

### packages/oav-express4

**`renderProblemDetails`** ([packages/oav-express4/src/render.ts:9](../packages/oav-express4/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request rejected for missing or malformed credentials receives HTTP 401
without the required `WWW-Authenticate` header. That header tells the
client how to authenticate. The adapter knows the security scheme names
but lacks the details needed to build a challenge. Applications must
supply the header in their `onError` handler (#1087).

### packages/oav-express5

**`renderProblemDetails`** ([packages/oav-express5/src/render.ts:9](../packages/oav-express5/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request rejected for missing or malformed credentials receives HTTP 401
without the required `WWW-Authenticate` header. That header tells the
client how to authenticate. The adapter knows the security scheme names
but lacks the details needed to build a challenge. Applications must
supply the header in their `onError` handler (#1087).

### packages/oav-fastify

**`renderProblemDetails`** ([packages/oav-fastify/src/render.ts:9](../packages/oav-fastify/src/render.ts#L9))

Against RFC 9110 section 15.5.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2>).

A request rejected for missing or malformed credentials receives HTTP 401
without the required `WWW-Authenticate` header. That header tells the
client how to authenticate. The adapter knows the security scheme names
but lacks the details needed to build a challenge. Applications must
supply the header in their `onError` handler (#1087).

### packages/overlay-spec

**`parseTarget`** ([packages/overlay-spec/src/parse-target.ts:63](../packages/overlay-spec/src/parse-target.ts#L63))

Against RFC 9535 section 2.3.1.1 (<https://www.rfc-editor.org/rfc/rfc9535#section-2.3.1.1>).

Quoted targets accept an escape for either quote character, so
`$['a\"b']` selects the key `a"b`. JSONPath permits escaping only the
enclosing quote; the other quote character appears literally.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:459](../packages/router/src/matcher.ts#L459))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

A document can declare `GET /items/{id}` and `POST /items/{slug}` without
a router conflict. OpenAPI forbids path templates that differ only in
parameter names, even when their methods differ. oaverify rejects them
only when they share a method.

### packages/schema

**`unknownFormats`** ([packages/schema/src/compiler/compiler.ts:1270](../packages/schema/src/compiler/compiler.ts#L1270))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7.2.3>).

With `openapi31Dialect` or `oas30Dialect`, an unknown format is skipped
by default while other schema constraints still apply. These dialects
enable Format-Assertion, the JSON Schema rules for checking formats,
which require unknown names to cause an error. Set `unknownFormats:
"error"` to reject schemas containing them.

**`discriminatorKeyword`** ([packages/schema/src/keywords/discriminator.ts:7](../packages/schema/src/keywords/discriminator.ts#L7))

Against JSON Schema 2020-12 anyOf (<https://json-schema.org/draft/2020-12/json-schema-core#section-10.2.1.2>).

When both `oneOf` and `anyOf` accompany a usable discriminator, routed
objects skip `anyOf`. An object can pass even when `anyOf` accepts only
booleans. JSON Schema requires at least one `anyOf` branch to accept the
instance. This separate object-path defect is tracked in #1124.

**`multipleOfKeyword`** ([packages/schema/src/keywords/number.ts:32](../packages/schema/src/keywords/number.ts#L32))

Against JSON Schema 2020-12 validation section 6.2.1 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-6.2.1>).

A number very close to an exact multiple can pass `multipleOf`. JSON
Schema requires exact divisibility, but the validator allows a small
rounding tolerance. This avoids rejecting ordinary decimal multiples:
JavaScript calculates `0.3 / 0.1` as `2.9999999999999996` instead of `3`.

### packages/spec

**`findUndeclaredSecuritySchemes`** ([packages/spec/src/lint.ts:1240](../packages/spec/src/lint.ts#L1240))

Against OpenAPI 3.2.0 Security Requirement Object (<https://spec.openapis.org/oas/v3.2.0.html#security-requirement-object>).

In an OpenAPI 3.2 document, `check` reports a security requirement
name that is not a component name only when it starts with `#`.
OpenAPI 3.2 lets a requirement name a scheme by URI instead of by
component name, so such a name may be legal. A name starting with `#`
is read as a location in the same document: it is reported when it is
not a JSON Pointer, as in `#key`, or when the pointer reaches nothing,
and accepted when it reaches any object, even one that is not a
Security Scheme. A `#` name written in a separate file that resolution
copied into this document refers to that file, so it is not checked
either. Any other name, such as `./other.yaml#/key` or a bare `key`
matching no component, is not checked, because `check` does not
retrieve the documents a URI names. Earlier OpenAPI versions allow
component names only, and every unmatched name is reported there. The
request validator also reads component names only, so a request to an
operation requiring a scheme named by URI fails its security check.

### packages/stream-validator

**`createStreamValidator`** ([packages/stream-validator/src/engine/stream-validator.ts:994](../packages/stream-validator/src/engine/stream-validator.ts#L994))

Against RFC 8259 section 8.1 (<https://www.rfc-editor.org/rfc/rfc8259#section-8.1>).

RFC 8259 requires UTF-8 for JSON exchanged outside a closed ecosystem.
`utf8: "replace"` allows malformed sequences in strings and keys,
validating their U+FFFD replacement text while echoing the original bytes.
This compatibility setting can accept malformed input when the schema
permits the replacement text. The default, `utf8: "reject"`, rejects it.

### packages/validator

**`deserializePath`** ([packages/validator/src/deserialize.ts:92](../packages/validator/src/deserialize.ts#L92))

Against RFC 3986 section 2.1 (<https://www.rfc-editor.org/rfc/rfc3986#section-2.1>).

Malformed percent escapes such as `%ZZ` are passed through to schema
validation unchanged. RFC 3986 requires two hexadecimal digits after `%`.

**`maxFormatLength`** ([packages/validator/src/validator.ts:863](../packages/validator/src/validator.ts#L863))

Against JSON Schema 2020-12 validation section 7 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7>).

Strings longer than `maxFormatLength` skip their `format` check, so an
invalid email address or date can pass that check when it is long
enough. Other schema constraints still apply. The default cap is
1,048,576 JavaScript string units (UTF-16 code units). It limits the
risk of format checks exhausting the stack; raise it or set `Infinity`
to check longer strings.

## narrows

Rejects what the cited spec allows.

### packages/cli

**`unknownFormats`** ([packages/cli/src/emit-standalone.ts:40](../packages/cli/src/emit-standalone.ts#L40))

Against JSON Schema 2020-12 validation section 7.2.3 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7.2.3>).

By default, standalone code generation rejects schemas with unknown
formats, such as `{"type":"string","format":"phone"}`. This also
applies to plain JSON Schema 2020-12, where formats are metadata by
default and unknown names should be allowed. Set `unknownFormats:
"ignore"` to generate code without a check for those names.

### packages/formats

**`validateInt64`** ([packages/formats/src/numeric.ts:123](../packages/formats/src/numeric.ts#L123))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

Valid signed 64-bit integers outside `-(2^53 - 1)` through `2^53 - 1` are
rejected. This validator uses JavaScript's safe-integer range. Beyond it,
different integers in JSON can be rounded to the same JavaScript number,
so the original value cannot always be recovered.

**`validateUint64`** ([packages/formats/src/numeric.ts:147](../packages/formats/src/numeric.ts#L147))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

Valid unsigned 64-bit integers above `2^53 - 1` are rejected. This
validator accepts only nonnegative JavaScript safe integers. Beyond that
range, different integers in JSON can be rounded to the same JavaScript
number, so the original value cannot always be recovered.

**`validateUnixtime`** ([packages/formats/src/numeric.ts:199](../packages/formats/src/numeric.ts#L199))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

An integer timestamp outside `-(2^53 - 1)` through `2^53 - 1` is
rejected, even though POSIX does not impose this range on seconds since
the Unix epoch. This validator uses JavaScript's safe-integer range
because different timestamps beyond it can be rounded to the same number.

### packages/overlay-spec

**`translateOverlay`** ([packages/overlay-spec/src/index.ts:86](../packages/overlay-spec/src/index.ts#L86))

Against OpenAPI Overlay 1.0 (<https://spec.openapis.org/overlay/v1.0.0.html>).

An overlay that removes part of a document and later re-creates it is
rejected as conflicting. OpenAPI Overlay defines actions as sequential
edits, so this sequence is legal. oaverify combines the actions into one
`SpecOverlay` edit and cannot preserve that ordering.

**`parseTarget`** ([packages/overlay-spec/src/parse-target.ts:63](../packages/overlay-spec/src/parse-target.ts#L63))

Against OpenAPI Overlay 1.0 (<https://spec.openapis.org/overlay/v1.0.0.html>).

Some valid overlay targets are rejected with `UnrecognisedTargetError`.
Overlay 1.0 uses JSONPath to select parts of a document; oaverify
supports only a subset of that query language. For example, searching at
every depth with `$..description` or selecting an array slice with
`[0:2]` is unsupported. Quoted strings support only escaped backslashes
and quote characters; valid JSONPath escapes such as `\n` and `\u0061`
are rejected.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:459](../packages/router/src/matcher.ts#L459))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

The router treats `/pets/` and `/pets` as the same path, including when
matching requests. Declaring both for the same HTTP method causes a
conflict. OpenAPI allows them as distinct paths; this router removes
trailing slashes.

### packages/schema

**`maxDepth`** ([packages/schema/src/compiler/compiler.ts:1180](../packages/schema/src/compiler/compiler.ts#L1180))

Against JSON Schema 2020-12 core section 8.2.3 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3>).

Setting `maxDepth` can reject otherwise valid data when validation
follows a recursive `$ref` beyond the configured limit. JSON Schema
imposes no such limit. This optional safeguard bounds recursion through
self-referencing schemas to help prevent a JavaScript stack overflow;
it does not limit all JSON nesting. The default is uncapped.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:250](../packages/spec/src/resolver.ts#L250))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.2>).

An external reference using a named anchor, such as `pet.json#Pet`, fails
with an invalid-pointer error. JSON Schema allows `$anchor: "Pet"` to
name a target. The resolver supports external fragments that give a JSON
Pointer path, such as `pet.json#/components/schemas/Pet`, but does not
look up named anchors.

### packages/syntax

**`parseYamlDocument`** ([packages/syntax/src/index.ts:100](../packages/syntax/src/index.ts#L100))

Against YAML 1.2.2 (<https://yaml.org/spec/1.2.2/>).

A YAML document is rejected if expanding its aliases exceeds the parser's
budget. Aliases reuse an earlier value; repeated reuse can make a small
file expand into a very large structure. YAML does not set a limit, but
oaverify keeps the `yaml` package's default safeguard against excessive
resource use.

### packages/validator

**`maxDepth`** ([packages/validator/src/validator.ts:837](../packages/validator/src/validator.ts#L837))

Against JSON Schema 2020-12 core section 8.2.3 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3>).

Setting `maxDepth` can reject an otherwise valid request body with a
`depth` error (HTTP 400) when validation follows a recursive `$ref`
beyond the limit. JSON Schema imposes no such limit. This optional
safeguard helps prevent stack overflows with self-referencing schemas;
it does not limit all JSON nesting. The default is uncapped.

## transforms

Changes the value handed on, which can affect subsequent validation.

### packages/core

**`cookies`** ([packages/core/src/types.ts:634](../packages/core/src/types.ts#L634))

Against OpenAPI 3.2 style values (<https://spec.openapis.org/oas/v3.2.0#style-values>).

When cookies arrive percent-decoded, OpenAPI 3.2's `style: cookie`
validates the decoded values even though the style requires preserving
the percent-encoded text. For example,
`session=%41` becomes `A`: a schema with `const: "%41"` then rejects
it, while `const: "A"` accepts it. The returned parameter value is also
`A`. The Fetch adapter decodes cookies itself; Express and Fastify
adapters pass through the values supplied by their cookie parsers.
Decoding follows the default `form` style, regardless of the style
declared in the spec.

### packages/metaschema

**`metaschemaFor`** ([packages/metaschema/src/index.ts:123](../packages/metaschema/src/index.ts#L123))

Against the OpenAPI 3.0 schema (<https://spec.openapis.org/oas/3.0/schema/2024-10-18>).

OpenAPI 3.0 documents are checked against a converted copy of the
published meta-schema (the schema describing valid OpenAPI documents).
The conversion translates it from JSON Schema draft-04 to 2020-12 so it
can use the same compiler as newer versions. See
`packages/metaschema/scripts/convert-oas30.mjs`. The OpenAPI 3.1 and 3.2
meta-schemas are used unchanged.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:250](../packages/spec/src/resolver.ts#L250))

Against OpenAPI 3.1 section 4.6 (<https://spec.openapis.org/oas/v3.1.0#relative-references-in-uris>).

A schema reference to another file is rewritten as a local reference
under `components.schemas`, and the target schema is stored there once.
The generated component name can differ from the original. OpenAPI
specifies which schema a reference identifies but leaves the resolved
document's layout to tooling. Keeping shared references preserves
discriminator matching (#553) and recursive schemas (#556).

### packages/validator

**`deserialize`** ([packages/validator/src/deserialize.ts:12](../packages/validator/src/deserialize.ts#L12))

Against RFC 9110 section 5.6.1.2 (<https://www.rfc-editor.org/rfc/rfc9110#section-5.6.1.2>).

Empty members of a `simple` header list are kept as empty strings.
RFC 9110 has a recipient ignore them, so `1, ,2` is the list `1, 2`;
here it reads as `[1, "", 2]`, which an integer array then rejects
and a string array accepts with an extra `""` element. OpenAPI's
`simple` style can carry an empty string as an element, so dropping
empty members would lose values a client meant to send.

**`deserialize`** ([packages/validator/src/deserialize.ts:12](../packages/validator/src/deserialize.ts#L12))

Against RFC 9110 section 5.3 (<https://www.rfc-editor.org/rfc/rfc9110#section-5.3>).

A `simple` header array or object given as an array of strings, one
per field line, is read as those lines joined with commas. RFC 9110
lets a recipient combine field lines only for a field defined as a
comma-separated list. This join is applied to any header the schema
types as an array or object, so a field whose value may itself
contain a comma is split there too: `["a, b"]` for a string array
reads as `["a", "b"]`. Set-Cookie, which RFC 9110 names as the field
that must not be combined, keeps one element per line.

## chooses

The spec grants latitude, and this picked one option.

### packages/core

**`allowEmptyValue`** ([packages/core/src/types.ts:498](../packages/core/src/types.ts#L498))

Against OpenAPI 3.1.1 Parameter Object (<https://spec.openapis.org/oas/v3.1.1#parameter-object>).

With `allowEmptyValue: true`, an empty query value such as `?flag=` is
accepted without checking its parameter schema. Even `minLength: 1` or
`type: integer` does not reject it. OpenAPI 3.1.1 explicitly makes
interactions with the Schema Object implementation-defined; oaverify
chooses to bypass schema checks for an empty value.

### packages/formats

**`builtInFormats`** ([packages/formats/src/index.ts:83](../packages/formats/src/index.ts#L83))

Against the OpenAPI Format Registry (<https://spec.openapis.org/registry/format/>).

Some formats in the OpenAPI Format Registry have no built-in validator
yet (#696). The registry explicitly says tools are not required to
implement its entries. With the default unknown-format policy, those
names add no validation; other schema constraints still apply. The format
pass in `@oaverify/check` reports missing format checks. Applications can
register their own validators.

### packages/metaschema

**`checkDocumentConformance`** ([packages/metaschema/src/conformance.ts:263](../packages/metaschema/src/conformance.ts#L263))

Against JSON Schema 2020-12 validation section 7.2.1 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7.2.1>).

Meta-schema `format` annotations are not asserted. For example, an
invalid `info.termsOfService` URI or `info.contact.email` string produces
no format finding; other structural constraints still apply. This pass
uses `jsonSchemaDialect`. JSON Schema says implementations *MAY still
treat "format" as an assertion* and requires that evaluation to be
disabled by default; this pass leaves it disabled. A conformance
`format` severity setting only grades findings that exist; it does not
enable these checks.

### packages/oav-express4

**`renderProblemDetails`** ([packages/oav-express4/src/render.ts:9](../packages/oav-express4/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

Every error response uses `title: "Validation failed"`, regardless of its
HTTP status. The response's `about:blank` problem type means a generic
HTTP error; RFC 9457 recommends using the status phrase, such as `Bad
Request`, as its title. oaverify uses one validation-specific title and
lists individual errors in the `issues` field.

### packages/oav-express5

**`renderProblemDetails`** ([packages/oav-express5/src/render.ts:9](../packages/oav-express5/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

Every error response uses `title: "Validation failed"`, regardless of its
HTTP status. The response's `about:blank` problem type means a generic
HTTP error; RFC 9457 recommends using the status phrase, such as `Bad
Request`, as its title. oaverify uses one validation-specific title and
lists individual errors in the `issues` field.

### packages/oav-fastify

**`renderProblemDetails`** ([packages/oav-fastify/src/render.ts:9](../packages/oav-fastify/src/render.ts#L9))

Against RFC 9457 section 4.2.1 (<https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1>).

Every error response uses `title: "Validation failed"`, regardless of its
HTTP status. The response's `about:blank` problem type means a generic
HTTP error; RFC 9457 recommends using the status phrase, such as `Bad
Request`, as its title. oaverify uses one validation-specific title and
lists individual errors in the `issues` field.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:459](../packages/router/src/matcher.ts#L459))

Against OpenAPI 3.1 Paths Object (<https://spec.openapis.org/oas/v3.1.0#paths-object>).

When two path templates match a request, their segment types are compared
from left to right. At the first difference, fixed text takes priority
over a mix such as `file-{id}`, which takes priority over a bare
parameter such as `{id}`. For example, `/a/b/c` matches both
`/a/{x}/c` and `/{y}/b/c`; oaverify chooses `/a/{x}/c`. OpenAPI
explicitly lets tooling decide how to resolve ambiguous matches.

### packages/schema

**`unknownFormats`** ([packages/schema/src/compiler/compiler.ts:1270](../packages/schema/src/compiler/compiler.ts#L1270))

Against JSON Schema 2020-12 validation section 7 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-7>).

With `jsonSchemaDialect`, `format` values are metadata and do not
trigger format checks. Even `unknownFormats: "error"` has no effect.
JSON Schema permits this behavior. Select a dialect that enables format
validation, such as `openapi31Dialect`, to check formats and apply the
unknown-name policy.

### packages/validator

**`transformBodySchemaForDirection`** ([packages/validator/src/body-schema-transform.ts:51](../packages/validator/src/body-schema-transform.ts#L51))

Against JSON Schema 2020-12 validation section 9.4 (<https://json-schema.org/draft/2020-12/json-schema-validation.html#section-9.4>).

A request body containing a `readOnly` property is rejected. JSON Schema
allows the receiving application to ignore that property or return an
error; oaverify chooses an error. The property is also removed from the
request's `required` list, so clients can omit it even when it is
required in a response.

## resolves

The spec is silent or self-contradictory, and this picked a reading.

### packages/schema

**`discriminatorKeyword`** ([packages/schema/src/keywords/discriminator.ts:7](../packages/schema/src/keywords/discriminator.ts#L7))

Against OpenAPI 3.1 Discriminator Object (<https://spec.openapis.org/oas/v3.1.0#discriminator-object>).

If a `discriminator` cannot match its values to the schemas in `oneOf` or
`anyOf`, it is ignored and normal branch validation applies. A
discriminator uses a payload field to select a schema; OpenAPI does not
specify how to handle an unusable mapping. oaverify reports
`silent-rewrite/discriminator-unroutable` so the author can find the
unused mapping. This can happen when a bundled document retains mappings
to the original files (#561).

### packages/spec

**`findDuplicateOperationIds`** ([packages/spec/src/lint.ts:1187](../packages/spec/src/lint.ts#L1187))

Against OpenAPI 3.2.0 Operation Object (<https://spec.openapis.org/oas/v3.2.0.html#operation-object>).

OpenAPI says an `operationId` "MUST be unique among all operations
described in the API" and does not say whether one Operation Object
reached from several places describes one operation or several. This
check counts it as one. Two paths whose Path Item is the same `$ref`
target, such as `/v1/pets` and `/pets` both referencing
`#/components/pathItems/Pets`, expose one `operationId` on two routes
and are not reported. Two Operation Objects written separately with
the same `operationId` are reported, even when their content is
identical.

**`findUndeclaredServerVariables`** ([packages/spec/src/lint.ts:1325](../packages/spec/src/lint.ts#L1325))

Against OpenAPI 3.2.0 Server Object (<https://spec.openapis.org/oas/v3.2.0.html#server-object>).

A server URL such as `https://{region}.example.com` whose server
declares no `region` under `variables` is reported as an error.
OpenAPI says substitutions are made for variables named in braces and
that each Server Variable carries the default to substitute, but no
version states a requirement that every placeholder be declared. The
check reads that as one: an undeclared placeholder has no value, so
the URL cannot be built.

### packages/stream-validator

**`createStreamValidator`** ([packages/stream-validator/src/engine/stream-validator.ts:994](../packages/stream-validator/src/engine/stream-validator.ts#L994))

Against RFC 8259 section 4 (<https://www.rfc-editor.org/rfc/rfc8259#section-4>).

When a JSON object repeats a property name, streaming validation can
check and count every occurrence toward `minProperties` and
`maxProperties`. The in-memory validator keeps only the last occurrence,
as `JSON.parse` does. The streaming validator also keeps only the last
when the schema requires it to collect an object in memory before
checking it. JSON recommends unique names and leaves duplicate handling
unspecified, so the result here depends on the schema.

### packages/validator

**`resolvePathItem`** ([packages/validator/src/path-item.ts:20](../packages/validator/src/path-item.ts#L20))

Against OpenAPI 3.1.0 Path Item Object (<https://spec.openapis.org/oas/v3.1.0.html#path-item-object>).

OpenAPI leaves behavior undefined when a field appears both beside a
Path Item `$ref` and in its target. Standalone compilation and its
parameter-location checks keep the nearest declaration of that field;
fields found only in a target are
inherited. Arrays such as `parameters` are replaced as a whole.

## defers

The cited spec requires it and this does not implement it yet.

### packages/router

**`createRouter`** ([packages/router/src/matcher.ts:459](../packages/router/src/matcher.ts#L459))

Against OpenAPI 3.2.0 (<https://spec.openapis.org/oas/v3.2.0#path-item-object>).

Custom HTTP methods declared through OpenAPI 3.2's `additionalOperations`
are not routed. For a matching path, a request using one receives a 405
(Method Not Allowed) result, and the method is missing from the reported
allowed methods.
Support is tracked in #396.

### packages/spec

**`resolveSpec`** ([packages/spec/src/resolver.ts:250](../packages/spec/src/resolver.ts#L250))

Against OpenAPI 3.1 section 4.6 (<https://spec.openapis.org/oas/v3.1.0#relative-references-in-uris>).

A relative `$ref` can load the wrong file when a surrounding schema
declares `$id`. OpenAPI requires that identifier to set the base URL for
relative references; the resolver instead uses the containing file's
location. For example, `$id: "nested/base.json"` should make `$ref:
"pet.json"` load `nested/pet.json`, but it loads `pet.json` beside the
containing file (#1088).

### packages/stream-validator

**`createStreamValidator`** ([packages/stream-validator/src/engine/stream-validator.ts:994](../packages/stream-validator/src/engine/stream-validator.ts#L994))

Against JSON Schema 2020-12 (<https://json-schema.org/draft/2020-12/json-schema-core.html#section-8.2.3.2>).

Streaming validation can disagree with `@oaverify/core` for the same
schema and data, without warning when the validator is created. Named
references such as `#Pet` can select the wrong target when multiple
schemas define that name. `$dynamicRef`, which allows a reference's
target to depend on the schema being applied, also ignores that context
(#1090). Separately, some malformed schema keyword values are silently
ignored instead of rejected (#919).

### packages/validator

**`UNIMPLEMENTED_LOCATIONS`** ([packages/validator/src/parameter-locations.ts:86](../packages/validator/src/parameter-locations.ts#L86))

Against OpenAPI 3.2 Parameter Object (<https://spec.openapis.org/oas/v3.2.0#parameter-object>).

Creating a validator fails if the document declares an OpenAPI 3.2 `in:
querystring` parameter. That location validates the entire query string
as one value, which the current `HttpRequest` interface does not provide
(#397). The validator refuses the unsupported declaration so the
operation cannot silently run without the required checks (#836).

## Regenerating

```bash
pnpm docs:boundaries          # rewrite this page from the tags
pnpm check:boundaries-doc     # assert it matches (runs in `pnpm lint`)
```

Do not edit this file by hand. Edit the `@specBoundary` tag it came from and
regenerate; the gate fails if the two disagree.
