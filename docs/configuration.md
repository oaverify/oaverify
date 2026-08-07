# Configuring the validator

`createValidator(spec, options)` accepts the options below. The
canonical reference is the
[`ValidatorOptions`](../packages/validator/src/validator.ts) TSDoc;
this page is a recipe-oriented overview.

| Option                  | Effect                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dialect`               | Force a specific schema dialect. Wins over the version the document declares; detection still runs, so `validator.detectedVersion` is unchanged.                                                                   |
| `formats`               | Extra format validators merged on top of the built-ins, and the per-format off switch. See below.                                                                                                                  |
| `keywords`              | Register user-defined schema keywords (see below).                                                                                                                                                                 |
| `output`                | Result shape: `"flat"` (default; `{ valid, errors, truncated }`), `"tree"` (nested `{ valid, error, truncated }`), or `"predicate"` (bare boolean). Mirrors `compileSchema`.                                       |
| `maxErrors`             | Per-call total cap on leaf errors. Default `1` (fast-fail); pass `Number.POSITIVE_INFINITY` to collect every error.                                                                                                |
| `maxDepth`              | Cap on recursive `$ref` validation depth; past the cap the payload fails with a `depth` error instead of exhausting the call stack. Unset by default; see below.                                                   |
| `schemaLint`            | Schema lint mode: `"off"`, `"warn"` (default), or `"strict"`. Findings surface via `validator.stats.schemaLintIssues`; never throws. A malformed schema is rejected regardless, see [Strictness](./strictness.md). |
| `strictQueryParameters` | Reject undeclared query parameters. Default `false`.                                                                                                                                                               |
| `validateSecurity`      | `"off"` (default), `"shape"` (check recognized schemes; pass on oauth2/oidc/mTLS), or `"strict"` (fail on unrecognized schemes).                                                                                   |
| `ignoreUndocumented`    | Treat requests whose path the router can't match as valid (`{ valid: true }`) instead of a `route` error. Default `false`.                                                                                         |
| `ignorePaths`           | Predicate `(path) => boolean`; returning `true` short-circuits validation to a valid result (`{ valid: true }`) before routing.                                                                                    |
| `onUnknownVersion`      | Policy for specs with missing/unsupported `openapi`: `"fallback31"` (default), `"warn"`, or `"throw"`.                                                                                                             |
| `regexCompiler`         | Compiler for `pattern` keywords and `format: "regex"`. Defaults to `new RegExp(p, "u")` with a non-u fallback. Plug in `re2` or a safe-regex check for hardening; see below.                                       |

## Formats

One registry, whatever JSON type a format constrains. `date-time`
takes a string and `int32` takes a number, and both are configured
through `formats`:

```ts
createValidator(spec, {
  formats: {
    // A bare function is a string format.
    "x-internal-id": (value) => value.startsWith("id_"),
    // Constraining numbers needs the type said out loud.
    "x-basis-points": { type: "number", validate: (n) => n >= 0 && n <= 10000 },
    // `false` registers the name and asserts nothing.
    int64: false,
  },
});
```

A bare function is **always** a string format, including under a name
whose built-in constrains numbers. `formats: { int32: (v) => ... }`
receives strings, and the numeric assertion is gone. Inferring the
type from the name would make two identical-looking entries mean
different things by way of a table you cannot see.

Under the OpenAPI dialects `format` is an assertion, so the built-ins
bind: `format: "int32"` on `3000000000` is a validation error, the way
`format: "date-time"` on `"not-a-date"` always has been. `false` is how
you keep a name as an annotation instead. That is per format, so
turning `int64` off leaves `int32` asserting.

`int64` and `uint64` are partial assertions and worth knowing about.
Both accept the safe-integer range, `-(2^53 - 1)` through `2^53 - 1`
(`uint64` from 0), and reject outside it. A JSON number past 2^53 has
already lost precision before any JavaScript validator sees it:
`JSON.parse("9223372036854775807")` yields `9223372036854775808`, a
different number. Rejecting says so; accepting would vouch for a value
that is not the one on the wire. Producers of large 64-bit integers
send them as strings. If you would rather accept them, write
`formats: { int64: false }`.

The narrower widths (`int8`, `int16`, `int32`, `uint8`, `uint16`,
`uint32`) are exact: every value in range survives a JSON round trip.
`double-int` is exact too, and its range is the safe-integer range by
definition rather than by concession.

### What is not asserted

`float` and `double` are not asserted at all, and will not be. Every
JSON number is already an IEEE 754 double, so `double` asserts
nothing, and a `Math.fround`-based `float` rejects values a producer
legitimately sent (`0.1` is not representable as a 32-bit float).
`binary` is unassertable in the same spirit, being any sequence of
octets; the validator treats it as an opaque-body bypass rather than a
constraint. `password`, `commonmark` and `html` are display hints.

Names in the [OpenAPI Format Registry](https://spec.openapis.org/registry/format/)
that _are_ assertable but not yet implemented (`http-date`,
`date-time-local`, `time-local`, `ipv4-cidr`, `ipv6-cidr`, `language`,
`media-range`, `decimal`, `decimal128`, `unixtime`, and the six `sf-*`
structured-field formats) behave the same way at request time: the
value is checked against `type` alone.

`oaverify check` reports every one of them under
`format-not-validated`, and the message distinguishes the three cases,
so a report tells you whether the name is a permanent annotation, a gap
that a later release may close, or a vendor name of your own.

Migrating from an Ajv-shaped map, `fromAjvFormats` carries `type`
through, so a `type: "number"` definition arrives as a numeric format:

```ts
import { fromAjvFormats } from "@oaverify/core/formats";
createValidator(spec, { formats: fromAjvFormats(myAjvFormats) });
```

## Custom keywords

```ts
const validator = createValidator(spec, {
  keywords: {
    activeTenant: (data) =>
      typeof data !== "string" || tenantCache.has(data)
        ? true
        : { message: `tenant "${data}" is not active` },
  },
});
```

Custom keywords plug into generated code alongside the built-ins. See
[`examples/custom-keywords.ts`](../examples/custom-keywords.ts) for an
end-to-end run, and `CustomKeywordValidator` in the TSDoc for the full
return-shape contract (boolean, error object, or array of errors).

## Error budget

The validator stops at the first error by default (`maxErrors: 1`).
The cap is a per-call total
across every location (body, query, headers).

```ts
createValidator(spec); // fast-fail: the first error
createValidator(spec, { maxErrors: 10 }); // bound CPU/memory on huge payloads
createValidator(spec, { maxErrors: Number.POSITIVE_INFINITY }); // every error
```

Hot loops (array items, object properties, `allOf` / `anyOf` branches)
short-circuit once the budget is exhausted. A failing result carries
`truncated: true` when the cap was reached, so callers know more
problems may exist.

`maxErrors` must be a positive integer (>= 1); `createValidator`
throws on `0`, negative values, or non-integers. For a yes/no answer
with no errors collected at all, build the validator with
`output: "predicate"`.

## Malformed schemas fail at construction

`schemaLint` grades schemas that are schemas. A document that is not one
is rejected before linting runs, by a throw that no `schemaLint` setting
suppresses, including `"off"`. See [Strictness](./strictness.md) for how
the three classes of check relate.

A schema-valued slot (`items`, `not`, `if`, each entry of `allOf` /
`oneOf` / `prefixItems`, each value of `properties` / `$defs`, and so
on) has to hold an object or a boolean. Anything else throws from
`createValidator` / `compileSchema` with the path to the offending
value:

```
"items" at "properties.events" must be an object or boolean; got an array.
In JSON Schema 2020-12 the tuple form is "prefixItems"; an array-valued
"items" is the draft-04 / Swagger 2.0 spelling.
```

The check runs on the parsed document, so it is about the value's type,
not the source syntax. The two shapes it catches in practice:

- **An array where a schema belongs.** `items: [ {...} ]` is the
  draft-04 / Swagger 2.0 tuple form. 2020-12 spells it `prefixItems`.
  Left alone this compiles to a schema with no keywords, so the array's
  elements go unvalidated while the spec looks fine.
- **A null slot.** Usually a YAML indentation slip: writing `if:` with
  the intended subschema indented as a sibling rather than beneath it
  leaves `if: null`. Writing the null outright has the same effect.

Keyword values are checked the same way, by the keyword that owns them:

```
keyword "type" has unknown type name "Boolean"; expected one of "null",
"boolean", "object", "array", "string", "number", "integer". Did you
mean "boolean"?

keyword "required" requires an array of strings; got string "id"
```

Under OpenAPI 3.0 the legal type set is the same six minus `null`, and
`type: "null"` is reported with a pointer to `nullable: true` rather
than a spelling suggestion.

These are spec bugs that no runtime option papers over, which is why
the failure is a throw at construction rather than an entry in
`schemaLintIssues`. Catching one needs a `try` around
`createValidator`, not a check on each request.

## Hardening against untrusted regex patterns

`pattern` keywords and `format: "regex"` compile to JavaScript's
built-in `RegExp`, which has no execution timeout. A catastrophic
pattern like `(a+)+$` is a denial-of-service vector against any
string the validator checks. The risk is real only when the spec is
attacker-controlled: multi-tenant SaaS accepting uploads,
spec-editing tools, mock-as-a-service. For first-party specs the
default is fine; vet your sources.

When the spec is untrusted, pass a `regexCompiler` that wraps a safe
engine. `re2` is the standard choice (linear-time matching, no
catastrophic backtracking) on platforms that allow a native dep:

```ts
import RE2 from "re2";
import { createValidator } from "@oaverify/core";

const validator = createValidator(spec, {
  regexCompiler: (pattern) => new RE2(pattern),
});
```

Invocation cadence is split: schema-authored `pattern` strings are
memoized for the validator's lifetime (bounded by spec size), so
the compiler runs once per unique pattern there. `format: "regex"`
runs the compiler per `validate()` call against the candidate
string; caching runtime values would retain user input indefinitely,
which is the opposite of what hardening callers want.

The runtime only reads `.test(s)` off the returned object, so
anything that satisfies `{ test(s: string): boolean }` works. A
typical complexity-check wrapper:

```ts
import safeRegex from "safe-regex";

createValidator(spec, {
  regexCompiler: (pattern) => {
    if (!safeRegex(pattern)) {
      throw new Error(`unsafe regex: ${pattern}`);
    }
    return new RegExp(pattern, "u");
  },
});
```

`oaverify` does not bundle `re2` or any other engine: edge runtimes
(Cloudflare Workers, Vercel Edge) don't support native modules, and
the right answer for those environments is a different tradeoff
(pattern-length cap, allowlist of permitted patterns, etc.) which
your `regexCompiler` can encode.

Throws inside the compiler:

- For `pattern` keywords, a throw surfaces at validator-construction
  time (`compileSchema` calls the compiler eagerly).
- For `format: "regex"`, a throw is caught and translated into a
  `format` validation error against the value.

`pattern` and `format: "regex"` use the same compiler policy: one
`regexCompiler` covers both, and there is no second hook to keep in
sync. `format: "regex"` is auto-registered by `@oaverify/core/schema`
and is not part of `@oaverify/core/formats`'s `builtInFormats`; a
user-supplied entry in `formats` still overrides it if you want a
different policy for the format than for `pattern`.

## Resolving untrusted specs

The regex hardening above addresses what a spec's `pattern` strings can
do to the validator. Resolution is the other half: a `$ref` is a file
read or an outbound HTTP request, and `resolveSpec` hoists external
schema targets into `components.schemas`, so whatever a ref names tends
to end up in the resolved document, and from there in a response body
or a log.

The readers do none of this by default. `createFileReader(cwd)` uses
`cwd` as a resolution root, not a sandbox: `../` escapes it and an
absolute path is honored. `createHttpReader()` fetches any `http(s)`
URI it is handed. That is the right default for a first-party spec on
disk, and the wrong one for a spec you accepted from a user.

Four opt-in controls close it. Contracts live on the types; see
`FileReaderOptions` and `HttpReaderOptions`.

```ts
import {
  composeReaders,
  createFileReader,
  createHttpReader,
  resolveSpec,
} from "@oaverify/core/spec";

const reader = composeReaders([
  createFileReader("/srv/uploads/tenant-42", { confine: true }),
  createHttpReader({
    allowUri: (uri) => uri.startsWith("https://specs.internal.example/"),
    redirects: "error",
    timeoutMs: 5_000,
    maxBytes: 2_000_000,
  }),
]);

const { document } = await resolveSpec({ entry: "openapi.json", reader });
```

`confine` refuses any path that falls outside the base directory, both
before and after resolving real paths. A symlink that resolves inside
the base directory is allowed; one that resolves outside it is refused.
`allowUri` is called with every URI before the request and refuses it on
`false`. `timeoutMs` bounds a hanging endpoint. `maxBytes` rejects an
oversized response while the body is still streaming, before parsing it.
`FileReaderOptions.maxBytes` is the same bound for a local read, checked
against the size on disk before the file is opened. Both are unbounded
by default.

`redirects` deserves its own note, because `allowUri` without it is not
the control it looks like. `fetch` follows redirects by default and
`allowUri` never sees the hop, so an approved host that answers `302`
can still send the reader to an internal address. Set
`redirects: "error"` whenever the allowlist is what you are relying on.
It stays `"follow"` by default so that an existing caller behind a
redirecting endpoint keeps working.

If you use `@oaverify/yaml`, its readers need the same options.
`createYamlFileReader` and `createSmartHttpReader` compose _ahead_ of
the JSON-only readers and claim the URI first, so hardening only the
core readers is bypassed by a `.yaml` extension:

```ts
const reader = composeReaders([
  createYamlFileReader("/srv/uploads/tenant-42", { confine: true }),
  createSmartHttpReader({ allowUri, redirects: "error", timeoutMs: 5_000, maxBytes: 2_000_000 }),
  createFileReader("/srv/uploads/tenant-42", { confine: true }),
  createHttpReader({ allowUri, redirects: "error", timeoutMs: 5_000, maxBytes: 2_000_000 }),
]);
```

### The same choice from the CLI

The controls above are opt-in because the library composes no reader you
did not ask for: `loadSpec` requires one, `loadSpecSync` defaults to a
filesystem-only reader.

The CLI has to compose readers to be useful, so it takes the same choice
as a flag. Every command that reads a spec accepts `--remote-refs
allow | same-origin | deny` and `--untrusted`:

```bash
oaverify check vendor.yaml --remote-refs same-origin
oaverify check /srv/uploads/tenant-42/openapi.json --untrusted
```

`--untrusted` confines file reads to the entry's directory, tightens the
caps, and implies `--remote-refs same-origin`. The individual options
have no flags of their own; see `ReaderPolicy` and `policyFor` in
`@oaverify/internal-cli` for what each posture sets and why a posture
rather than a part. Compose readers yourself when you need something a
posture does not express, such as pinning one internal spec host.

## Guarding against deeply nested payloads

Recursive schemas (a `$ref` that points back at an ancestor, common
for tree and comment structures) compile to validation functions that
call themselves once per level of nested data. Validation depth tracks
the payload's nesting depth, and the JavaScript call stack has no
built-in limit you can rely on. A small but deeply nested payload (an
array nested a few thousand levels, only a few KB on the wire) can
exhaust the stack and throw `RangeError: Maximum call stack size
exceeded`.

The first line of defense is the `maxDepth` option, on both
`createValidator` (`ValidatorOptions`) and `compileSchema`
(`CompileOptions`). It bounds recursion inside the validator: once the
data nests deeper than the cap through a recursive `$ref`, validation
stops descending and emits a `depth` error (mapped to HTTP 400) instead
of growing the stack. The counter tracks only recursive (`$ref`
back-edge) calls, so it measures how deep the recursive structure
nests, independent of how the schema was decomposed; non-recursive
schemas are never instrumented, and an unset `maxDepth` compiles to the
same code as before (zero overhead). Legitimate payloads rarely recurse
beyond ten or fifteen levels, so a cap of 32 to 64 is generous.

```ts
const validator = createValidator(spec, { maxDepth: 64 });
// A request body that recurses past 64 levels now fails as a 400
// `depth` error rather than throwing RangeError.
```

`maxDepth` covers the validator's own recursion. For untrusted callers
who also want to reject deep payloads before they reach any parsing or
business logic, a depth cap at the parse boundary is a complementary
backstop (it bounds nesting the validator never sees, e.g. fields the
schema doesn't traverse). Without `maxDepth`, the framework adapters
catch the `RangeError` and turn it into a 500, so the process survives;
a cheap-to-send payload that reliably produces 500s is still a
denial-of-service vector, which is what `maxDepth` and the
parse-boundary guard close.

The parse-boundary guard is a depth cap before the parsed
body reaches the validator. A byte-size limit alone is not enough: a
payload nested thousands of levels deep is tiny, so `express.json({
limit })` (or its equivalent) bounds width, not depth. Walk the parsed
value iteratively (a recursive walker would overflow on the same input
you are trying to reject) and reject anything past a sane ceiling. Set
it low and raise it only if a legitimate payload trips it.

```ts
// Returns true if `value` nests deeper than `limit`. Iterative on
// purpose: a recursive walker would overflow on the input it rejects.
function tooDeep(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > limit) return true;
    if (Array.isArray(node)) {
      for (const el of node) stack.push([el, depth + 1]);
    } else {
      for (const k of Object.keys(node)) {
        stack.push([(node as Record<string, unknown>)[k], depth + 1]);
      }
    }
  }
  return false;
}

app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  if (req.body && tooDeep(req.body, 64)) {
    return res.status(400).json({ error: "request body nesting too deep" });
  }
  next();
});
// the validateRequests middleware comes after this guard
```

Fastify is the same shape in an `onRequest` or `preValidation` hook
that inspects `request.body`.

For standalone callers (the Fetch adapter, a handler that calls
`validateRequest` directly), wrap the call so a stack overflow becomes
a controlled error instead of an unhandled rejection:

```ts
try {
  result = validator.validateRequest(req);
} catch (err) {
  if (err instanceof RangeError) {
    return new Response("payload too complex", { status: 400 });
  }
  throw err;
}
```

`maxDepth` is the primary control; the parse-boundary guard, the
byte-size limit, and the `try/catch` are backstops.
