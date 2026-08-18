# Configuring the validator

`createValidator(spec, options)` accepts the options below. The
canonical reference is the
[`ValidatorOptions`](../packages/validator/src/validator.ts) TSDoc;
this page is a recipe-oriented overview.

| Option                      | Effect                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dialect`                   | Force a specific schema dialect. Wins over the version the document declares; detection still runs, so `validator.detectedVersion` is unchanged.                                                                   |
| `formats`                   | Extra format validators merged on top of the built-ins, and the per-format off switch. See below.                                                                                                                  |
| `keywords`                  | Register user-defined schema keywords (see below).                                                                                                                                                                 |
| `output`                    | Result shape: `"flat"` (default; `{ valid, errors, truncated }`), `"tree"` (nested `{ valid, error, truncated }`), or `"predicate"` (bare boolean). Mirrors `compileSchema`.                                       |
| `maxErrors`                 | Per-call total cap on leaf errors. Default `1` (fast-fail); pass `Number.POSITIVE_INFINITY` to collect every error.                                                                                                |
| `maxDepth`                  | Cap on recursive `$ref` validation depth; past the cap the payload fails with a `depth` error instead of exhausting the call stack. Unset by default; see below.                                                   |
| `maxTotalBytes`             | Cap on the bytes the Fetch adapter reads from a body. Default 1 MiB; pass `Number.POSITIVE_INFINITY` to read unbounded. Inert on the Express and Fastify adapters; see below.                                      |
| `schemaLint`                | Schema lint mode: `"off"`, `"warn"` (default), or `"strict"`. Findings surface via `validator.stats.schemaLintIssues`; never throws. A malformed schema is rejected regardless, see [Strictness](./strictness.md). |
| `unknownFormats`            | A `format` with no validator registered: `"ignore"` (default) leaves it asserting nothing, `"error"` refuses to compile. Compilation is lazy, so an untouched operation surfaces on its first request.             |
| `requireResponseBody`       | Treat a declared response body arriving as `undefined` as an error, except for HEAD and bodyless statuses. Default `false`; OpenAPI takes no position, so the rule is opt-in.                                      |
| `strictQueryParameters`     | Reject undeclared query parameters. Default `false`.                                                                                                                                                               |
| `allowBracketedQueryArrays` | Accept `?tags[]=a&tags[]=b` for an array-typed query parameter declared as `tags`. Default `false`; see below.                                                                                                     |
| `returnValues`              | Return the deserialized parameter values on the result under `value`, grouped by HTTP location. Default `false`; see below.                                                                                        |
| `validateSecurity`          | `"off"` (default), `"shape"` (check recognized schemes; pass on oauth2/oidc/mTLS), or `"strict"` (fail on unrecognized schemes).                                                                                   |
| `ignoreUndocumented`        | Treat requests whose path the router can't match as valid (`{ valid: true }`) instead of a `route` error. Default `false`.                                                                                         |
| `ignorePaths`               | Predicate `(path) => boolean`; returning `true` short-circuits validation to a valid result (`{ valid: true }`) before routing.                                                                                    |
| `onUnknownVersion`          | Policy for specs with missing/unsupported `openapi`: `"fallback31"` (default), `"warn"`, or `"throw"`.                                                                                                             |
| `regexCompiler`             | Compiler for `pattern` keywords and `format: "regex"`. Defaults to `new RegExp(p, "u")` with a non-u fallback. Plug in `re2` or a safe-regex check for hardening; see below.                                       |
| `lint`                      | Run spec-hygiene passes at construction, collecting into `validator.specHygieneIssues`. Never throws. Default `false`.                                                                                             |
| `warn`                      | Live sink called synchronously for each warning emitted during construction. Warnings accumulate in `validator.warnings` either way.                                                                               |

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
that _are_ assertable but not yet implemented (`decimal`, `decimal128`,
and the six `sf-*` structured-field formats) behave the same way at
request time: the value is checked against `type` alone.

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

## Reading the deserialized request values

The validator parses `?limit=10` into the number `10` in order to check
it against `type: integer`, then throws the number away. Set
`returnValues` to get it back instead of parsing the query string a
second time in your handler:

```ts
const validator = createValidator(spec, { returnValues: true });
const result = validator.validateRequest(req);
if (result.valid) {
  result.value.query.limit; // 10, a number
  result.value.path.id; // 42
  result.value.headers["X-Request-Id"];
  result.value.cookies.session;
}
```

Values are grouped by HTTP location, matching the coordinates the
validator already uses in error paths: an error at
`["query", "tags"]` and a value at `value.query.tags` name the same
parameter.

A parameter appears in `value` when this call reached it, deserialized
it, and its schema accepted the result. That rule holds whatever the
verdict, so `value` is present on failures too and carries everything
that passed:

```ts
// ?limit=nope&tags=a
const result = validator.validateRequest(req);
result.valid; // false
result.value.query.tags; // ["a"] - this one passed
"limit" in result.value.query; // false - this one did not
```

Report-only deployments read both halves: the errors say what was
wrong, and `value` says how the validator understood the rest.

Two request-level checks run before any parameter is inspected: the
`validateSecurity` gate and the request-body content-type gate. A
request that fails either gets `value` present with every location
empty, because no parameter was reached.

Three things `value` does not carry, each a decision rather than a gap.
The request body stays out, because the caller already holds the object
it passed in. Schema `default`s are not applied, so a parameter the
client did not send is absent even when its schema declares one.
`validateResponse` is unaffected.

`returnValues` cannot be combined with `output: "predicate"`, which
returns a bare boolean; `createValidator` throws on the combination.
`validateFetchRequest` carries `value` alongside `ok` and `body`.

See `ValidatorOptions.returnValues` and `RequestValues` for the
contract.

## Accepting bracket-suffixed query keys

Several HTTP clients and server frameworks (PHP, Rails, the `qs`
library) encode repeated query values with a `[]` suffix, so a document
that declares `tags` sees `?tags[]=a&tags[]=b` on the wire and reports
the parameter missing. `allowBracketedQueryArrays` accepts that spelling:

```ts
const validator = createValidator(spec, { allowBracketedQueryArrays: true });
// ?tags[]=a&tags[]=b now satisfies a parameter declared as `tags`
```

The declared name always wins. The bracketed spelling is consulted only
when no key matches the declared name exactly, so a request carrying
both `tags` and `tags[]` is read from `tags` and the bracketed key is
ignored rather than merged. Only array-typed query parameters gain the
spelling; a `type: string` parameter named `tags` still reports missing
for `?tags[]=a`, because the suffix means "repeated value" and a scalar
has no repetition to express.

`ValidatorOptions.allowBracketedQueryArrays` carries the rest of the
contract: how it composes with `strictQueryParameters`, why indexed
keys (`?tags[0]=a`) are not aliases, and which parameter kinds are
untouched.

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
built-in `RegExp`, which has no execution timeout, so a catastrophic
pattern like `(a+)+$` is a denial-of-service vector against any string
the validator checks. The risk is real only when the spec is
attacker-controlled: multi-tenant SaaS accepting uploads, spec-editing
tools, mock-as-a-service. For first-party specs the default is fine.

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

If you use `@oaverify/syntax`, its readers need the same options.
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
same-origin | allow | deny` and `--untrusted`:

```bash
oaverify check vendor.yaml --remote-refs allow
oaverify check /srv/uploads/tenant-42/openapi.json --untrusted
```

`--remote-refs` defaults to `same-origin`, so a local entry resolves
nothing over the network and a remote one resolves only its own origin's
siblings. `allow` opts back into resolving any host, which is what the
CLI did before v7.

`--untrusted` confines file reads to the entry's directory, tightens the
caps, and implies `--remote-refs same-origin`. The individual options
have no flags of their own; see `ReaderPolicy` and `policyFor` in
`@oaverify/internal-cli` for what each posture sets and why a posture
rather than a part. Compose readers yourself when you need something a
posture does not express, such as pinning one internal spec host.

## Bounding how much of a body is read

The Express and Fastify adapters receive a body their framework already
read and bounded: `express.json({ limit: "256kb" })` runs before the
middleware, and the adapter reads `req.body`, an object.

The Fetch adapter has no such layer beneath it. Next.js App Router
route handlers, Hono, `Bun.serve`, and `Deno.serve` hand you a `Request`
whose body is an unread stream, and the adapter is what drains it. So
the byte bound is an option here rather than a line of your own setup
code:

```ts
const validator = createValidator(spec, { maxTotalBytes: 256 * 1024 });

// Hono, Next.js route handler, Bun.serve, Deno.serve
const result = await validator.validateFetchRequest(request);
if (!result.ok) {
  const status = httpStatusFor(result.errors); // 413 for an over-cap body
  return Response.json(toProblemDetails(result.errors, { status }), { status });
}
```

It defaults to 1 MiB rather than to off, unlike the other resource
limits here. Those bound work your schema asks for; this one bounds a
buffer the reader introduces by draining a socket into a string. Raise
it for an upload endpoint, or pass `Number.POSITIVE_INFINITY` to
restore an unbounded read.

Two enforcement points. A `Content-Length` over the cap is refused
without reading anything, which saves the read rather than providing
the bound: the sender controls that header. The running byte count over
the stream is the bound, and it holds for chunked bodies, for a
`Content-Length` that lied, and for multipart. Over-cap yields a
`body-too-large` error leaf carrying which of the two fired:

```ts
{ code: "body-too-large", path: ["body"],
  params: { limit: 262144, reason: "read", bytes: 262145 } }
```

`reason: "declared"` means `bytes` is the length the sender claimed, and
`reason: "read"` means it is a count this reader took. They are not
interchangeable, which is why the leaf says which one it has.

A finite cap reads through a counting stream instead of the platform's
native `text()` / `formData()`, so the peak is the cap plus at most one
chunk. An infinite cap skips the instrumentation.

Two things it does not cover. A custom `readBody` callback receives the
original `Request` and owns its own budget; call `readBodyFromFetch(req,
{ maxTotalBytes })` from inside it to inherit this one for the content
types you delegate. And a byte cap bounds width, not depth, which is the
next section.

`combineValidators` takes the same option under `CombineOptions`; it
reads the body before dispatch, before any member is selected, so a
composite of validators with different caps wants the most permissive
one set on the composite. `oaverify compile-spec --max-total-bytes <n>`
bakes the cap into the emitted module's Fetch helpers (`none` for
unbounded) and inherits the default when the flag is absent.

See `ValidatorOptions.maxTotalBytes` and `FetchBodyOptions` for the
contract.

## Guarding against deeply nested payloads

Recursive schemas (a `$ref` that points back at an ancestor, common
for tree and comment structures) compile to validation functions that
call themselves once per level of nested data. Validation depth tracks
the payload's nesting depth, and the JavaScript call stack has no
built-in limit you can rely on. A small but deeply nested payload (an
array nested a few thousand levels, only a few KB on the wire) can
exhaust the stack and throw `RangeError: Maximum call stack size
exceeded`.

`maxDepth`, on both `createValidator` (`ValidatorOptions`) and
`compileSchema` (`CompileOptions`), is the control. Once the data nests
deeper than the cap through a recursive `$ref`, validation stops
descending and emits a `depth` error (HTTP 400) instead of growing the
stack.

```ts
const validator = createValidator(spec, { maxDepth: 64 });
// A request body that recurses past 64 levels now fails as a 400
// `depth` error rather than throwing RangeError.
```

The counter tracks only recursive (`$ref` back-edge) calls, so it
measures how deep the recursive structure nests, independent of how the
schema was decomposed. Non-recursive schemas are never instrumented,
and an unset `maxDepth` compiles to the same code as before. Legitimate
payloads rarely recurse beyond ten or fifteen levels, so a cap of 32 to
64 is generous.

Without it, the framework adapters catch the `RangeError` and turn it
into a 500, so the process survives; a cheap-to-send payload that
reliably produces 500s is still a denial-of-service vector.

### Backstop: a depth cap at the parse boundary

`maxDepth` covers the validator's own recursion. A cap before the
parsed body reaches the validator also bounds nesting the validator
never sees, such as fields the schema doesn't traverse. A byte-size
limit does not substitute: a payload nested thousands of levels deep is
tiny, so `express.json({ limit })` and `maxTotalBytes` bound width, not
depth.

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

A standalone caller (the Fetch adapter, or a handler calling
`validateRequest` directly) can catch the overflow instead:

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
