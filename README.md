# oaverify

[![npm](https://img.shields.io/npm/v/oaverify)](https://www.npmjs.com/package/oaverify)
[![CI](https://github.com/oaverify/oaverify/actions/workflows/ci.yml/badge.svg)](https://github.com/oaverify/oaverify/actions/workflows/ci.yml)
[![types included](https://img.shields.io/badge/types-included-blue)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/npm/l/oaverify)](https://github.com/oaverify/oaverify/blob/main/LICENSE)

oaverify checks OpenAPI 3.0, 3.1 and 3.2 documents, and validates HTTP
traffic against them, in JavaScript and TypeScript services. Use it
when an OpenAPI spec is the contract for a service, gateway, test
suite, or edge deployment.

Two questions, and a verb for each:

| Question                                        | Verb                                    |
| ----------------------------------------------- | --------------------------------------- |
| Is this request or response what the spec says? | `validateRequest` / `oaverify validate` |
| Is the spec itself any good?                    | `checkSpec` / `oaverify check`          |

The first is framework-neutral validation with structured errors. The
second grades the document: unused components, schemas oaverify had to
rewrite or could not satisfy, OpenAPI conformance, examples that do not
match the schema beside them, and patterns that can be made to
backtrack catastrophically.

The core package builds a validator from a parsed OpenAPI document.
Companion packages add YAML loading, Express and Fastify adapters, a
CLI, standalone validator generation, document checking with SARIF
output, spec overlays, and streaming validation with peak-buffer
budgets for large JSON bodies.

```ts
import { createValidator } from "@oaverify/core";

const validator = createValidator(document); // your parsed OpenAPI spec

const result = validator.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});

if (!result.valid) {
  console.log(result.errors);
  // [{ code: "required", path: ["body", "age"], message: "...", params: { missing: "age" } }]
}
```

One validation call covers the HTTP frame: method, path, parameters,
body, content type, status, and headers.

## Why this exists

The established OpenAPI validators for JavaScript predate OpenAPI 3.1.
oaverify is built to be the boring, correct option for modern specs.

- **3.1 and 3.2 are JSON Schema 2020-12, natively.** 1294/1299 on the
  required upstream test suite, every divergence itemized and
  cross-checked against other implementations, plus real-world specs
  (Stripe, GitHub, Twilio, and more) and Express 4 / 5 + Fastify
  integration tests
  ([conformance report](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md)).
- **Validator construction is cheap.** One to two orders of magnitude
  faster than Ajv compile on the benchmark shapes, at steady-state
  validation parity — including the cells where Ajv wins
  ([numbers and methodology](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md#performance)).
  Cheap construction is what makes per-test, per-tenant, and
  overlay-patched validators practical.
- **No side effects, no dependencies.** The core carries zero runtime
  dependencies, failures are return values, and framework request and
  response objects are never mutated.
- **Overlays patch specs you don't own, in memory.** Typed,
  OpenAPI-aware verbs or standard Overlay 1.0 documents (32/32
  upstream), applied just before construction — versus hand-editing
  parsed JSON or a build-time CLI
  ([docs/overlays.md](https://github.com/oaverify/oaverify/blob/main/docs/overlays.md)).
- **Two capabilities with no counterpart we know of:** streaming
  validation with pre-deploy peak-buffer budgets
  ([`@oaverify/stream`](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md)),
  and compiling a spec to a standalone HTTP validator for runtimes
  that forbid runtime code generation
  ([`compile-spec`](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md#compile-spec-output)).

**When not to use it.** If your OpenAPI document is generated from
zod, TypeBox, or similar runtime schemas, your schema library already
validates your traffic and oaverify adds little. Swagger 2.0 documents
are not supported ([convert first](#versions)). If you want request
coercion by mutation or response mocking, `express-openapi-validator`
and `openapi-backend` do those and oaverify deliberately does not.

## Install

Pick the packages that match what you need.

| You need                                        | Install                                 |
| ----------------------------------------------- | --------------------------------------- |
| The library: validate requests and responses    | `@oaverify/core`                        |
| Loading specs written in YAML                   | `@oaverify/core` + `@oaverify/syntax`   |
| The command-line tool                           | `oaverify` (or run it with `npx`)       |
| Express 4 request middleware                    | `@oaverify/core` + `@oaverify/express4` |
| Express 5 request middleware                    | `@oaverify/core` + `@oaverify/express5` |
| Fastify `preValidation` hook                    | `@oaverify/core` + `@oaverify/fastify`  |
| Streaming large bodies + buffer-budget analysis | `@oaverify/stream`                      |
| Grading a spec document from your own tooling   | `@oaverify/check`                       |

`@oaverify/core` is the library and carries no runtime dependencies. It parses
JSON; YAML support is a separate package because it pulls in a parser.
The adapters, the streaming engine and the document check depend on
`@oaverify/core`, so installing one gets you both. `@oaverify/check` is what
`oaverify check` runs; install it directly when you want the findings, the
severity grading and the SARIF output inside your own program rather than
from a shell.

The CLI can validate a request before you wire validation into an
application:

```bash
npx oaverify validate openapi.yaml --path "POST /pets" --body pet.json
```

A valid request prints nothing and exits `0`; validation errors print
to stdout and exit non-zero.

`@oaverify/core` exposes its surface at five subpath entrypoints (`/schema`,
`/spec`, `/overlay-spec`, `/formats`, `/core`) alongside the root export.
See [`docs/modules.md`](https://github.com/oaverify/oaverify/blob/main/docs/modules.md)
for what each one exports.

## Bundle cost

The cost of embedding the library, measured with esbuild
(`--bundle --minify`, ESM) against the published `dist`, then gzipped:

| Import                                              | Entry point                |     Raw | Gzipped |
| --------------------------------------------------- | -------------------------- | ------: | ------: |
| `compileSchema`, `jsonSchemaDialect`                | `@oaverify/core/schema`    |  ~69 KB |  ~19 KB |
| the same, plus `builtInFormats`                     | `+ @oaverify/core/formats` |  ~73 KB |  ~20 KB |
| `createValidator` (request/response HTTP validator) | `@oaverify/core`           | ~107 KB |  ~31 KB |

`@oaverify/core` carries no runtime dependencies, so these figures are
the complete cost of the import. YAML parsing, the streaming engine,
the adapters, the spec loader (`@oaverify/core/spec`), and the OpenAPI
meta-schemas are separate packages or entry points and not included.
The standalone validators emitted by `compile-schema` / `compile-spec`
are sized in
[packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md#bundle-size).
The figures move with the version; measure the imports you use.

## Quick start

### Express

```ts
import express from "express";
import { createValidator } from "@oaverify/core";
import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/syntax";
import { validateRequests } from "@oaverify/express5";

const { document } = await loadSpec({
  reader: composeReaders([createYamlFileReader(), createFileReader()]),
  entry: "openapi.yaml",
});
const validator = createValidator(document);

const app = express();
app.use(express.json());
app.use(validateRequests(validator));

app.post("/pets", (req, res) => res.json({ ok: true }));
```

Invalid requests receive an `application/problem+json` response.
Valid requests continue to your route handlers. Express 4 uses the
same shape with `@oaverify/express4`; Fastify uses `@oaverify/fastify` as a
`preValidation` hook. See [docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md).

### Framework-agnostic

```ts
import { createValidator, formatText } from "@oaverify/core";
import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/syntax";

const { document } = await loadSpec({
  reader: composeReaders([createYamlFileReader(), createFileReader()]),
  entry: "openapi.yaml",
});
const validator = createValidator(document);

const result = validator.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  headers: { "x-tenant": "acme" },
  body: { name: "Fido" },
});

if (!result.valid) console.error(formatText(result.errors));
```

For a multi-file spec or a spec hosted over HTTP, compose readers:
`composeReaders([createYamlFileReader(), createSmartHttpReader(), createFileReader()])`
handles local YAML, remote JSON / YAML, and local JSON transparently.

`validateRequest` / `validateResponse` return `{ valid: true }`, or
`{ valid: false, errors, truncated }` on failure. The default is a flat
`errors` list that stops at the first problem (`maxErrors: 1`);
`maxErrors` and `output: "tree" | "predicate"` tune count and shape.
Each leaf carries a stable `code`, an HTTP-rooted `path` (e.g.
`["body", "pets", 3, "name"]`), a `message`, and a `params` object; see
[docs/configuration.md](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md)
and the `ValidatorOptions` TSDoc for the full contract.

Runnable end-to-end demos in [`examples/`](https://github.com/oaverify/oaverify/blob/main/examples/README.md):
custom formats, custom keywords, cross-field constraints, error
budgets, version differences, overlays, spec-derived middleware
config, streaming validation, and pre-deploy buffer budgets.

## What people use it for

- Request and response validation in any Node, edge, or Fetch handler,
  with or without one of the framework adapters.
- Gating spec quality in CI with `oaverify check`, by severity.
- Validating large JSON bodies as bytes arrive, and estimating the
  per-operation buffer budget before deploying.
- Per-tenant, per-test and cold-start validators, which construction
  cost makes practical.
- Compiling a document to a standalone ESM validator for runtimes that
  forbid runtime code generation.
- Patching a spec you do not own with overlays, in memory.

## Streaming large bodies

`createValidator` validates a fully-parsed value. For a body too large
to hold in memory, the separate `@oaverify/stream` package validates it
as it streams, echoing the bytes through to a sink while reporting
violations on a side channel. It is a second engine, with its own
construction path: your router still picks the operation, and the
stream validator checks one resolved schema.

```ts
import { pipeline } from "node:stream/promises";
import { streamValidatorForOperation } from "@oaverify/stream";

// `document` is the parsed spec from loadSpec, as above.
const validator = streamValidatorForOperation(document, { method: "post", path: "/pets" });
validator.on("violation", (v) => console.warn(v.code, v.path, v.byteOffset));

await pipeline(request, validator, sink);
const { valid, peakBufferedBytes } = await validator.result;
```

Not every schema can stream: `uniqueItems`, `contains`, an
object-level `const`, or an asserting `format` force a subtree to
buffer. `analyzeSpec` reports which bodies stream, which buffer, and
how large a buffer can get, from the spec alone;
`oaverify stream-check openapi.yaml` prints the same per-operation
budget as a table (`--fail-on-unbounded` makes it a CI gate). See
[`packages/stream-validator/README.md`](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md)
for the engine, the buffer model, and the edit hooks.

## Overlay quickstart

Overlays patch a spec you don't own (add a server, require a header,
tighten a schema) in memory, before the validator is constructed,
without forking the file:

```ts
import { applyOverlays, type SpecOverlay } from "@oaverify/core/spec";

// Require an API key on POST /pets; tighten the upstream Pet schema.
const deployment: SpecOverlay = {
  overrides: {
    "/pets": { operations: { post: { addSecurity: [{ apiKey: [] }] } } },
  },
  extendSchemas: { Pet: { required: ["id"] } },
};

const validator = createValidator(applyOverlays(document, [deployment]));
```

The full verb surface (servers, paths, operations, component-bucket
fan-out, predicate iterators) is documented in
[`docs/overlays.md`](https://github.com/oaverify/oaverify/blob/main/docs/overlays.md).

## Where to go next

| Task                                       | Read                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Wire into Express, Fastify, Next.js, Hono  | [docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md)                                 |
| Stream large bodies / check buffer budgets | [packages/stream-validator/README.md](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md) |
| Patch a spec you do not own                | [docs/overlays.md](https://github.com/oaverify/oaverify/blob/main/docs/overlays.md)                                       |
| Check spec quality in CI                   | [packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md#two-verbs)                 |
| Emit standalone validators                 | [packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md#compile-spec-output)       |
| Compare against Ajv and other tools        | [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)                                   |
| Migrate from express-openapi-validator     | [docs/migration-from-eov.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-from-eov.md)                   |
| Use custom formats, keywords, or limits    | [docs/configuration.md](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md)                             |
| Work out what "strict" controls            | [docs/strictness.md](https://github.com/oaverify/oaverify/blob/main/docs/strictness.md)                                   |
| Upgrade from v2 to v3                      | [docs/migration-v3.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v3.md)                               |
| Upgrade from v4 to v5                      | [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md)                               |
| Upgrade from v5 to v6                      | [docs/migration-v6.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md)                               |
| Upgrade from v6 to v7                      | [docs/migration-v7.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v7.md)                               |

## How it compares

Ajv covers JSON Schema, `express-openapi-validator` covers Express, and
`openapi-backend` covers operationId routing plus validation. oaverify
is aimed at HTTP-aware validation with structured errors, streaming
validation of large bodies plus design-time buffer budgets, overlays,
and standalone OpenAPI validator output.
[docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)
has the feature map, the host-stamped per-shape numbers, and the
methodology.

`oaverify check` compares against spec linters instead.
[`detection/`](https://github.com/oaverify/oaverify/blob/main/detection/README.md)
is a labelled corpus for that: minimal documents carrying one seeded
defect each, run through oaverify, Spectral, Redocly and Ajv, where a
tool scores only when it reports that document's defect. It shows what
each tool can catch, not how often the defect occurs, and the cases
oaverify misses are in there too.

## Conformance

[`conformance/`](https://github.com/oaverify/oaverify/blob/main/conformance/README.md)
drives the compiler and CLI against the upstream JSON Schema 2020-12
Test Suite, OpenAPI 3.0 / 3.1 / 3.2 petstore scenarios, and real-world
specs (Stripe, GitHub, DigitalOcean, Twilio, Asana, Box, Adyen) that
have to load and compile without error.
[`conformance/REPORT.md`](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md)
has pass / fail counts by category, the out-of-scope list, and why each
entry is out of scope.

## CLI

```bash
oaverify resolve openapi.yaml
oaverify check openapi.yaml --fail-on warning
oaverify validate openapi.yaml --request req.http
oaverify validate openapi.yaml --path "POST /pets" --body payload.json
oaverify validate openapi.yaml --path "GET /pets" --response --status 200 --body resp.json
oaverify compile-schema schema.json -o validator.mjs             # JSON Schema -> standalone validator
oaverify compile-spec openapi.yaml  -o validator.mjs             # OpenAPI   -> standalone HTTP validator (edge / Lambda)
oaverify stream-check openapi.yaml                               # per-operation streamability + peak-buffer budget
```

`--overlay file` (repeatable), `-o file`, and `--quiet` apply where
supported. See
[packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md)
for per-command flags, the `.http` file format, and both compile
commands' output contracts.

Every command shares one exit-code taxonomy, tabulated in
[the published CLI README](https://github.com/oaverify/oaverify/blob/main/packages/oav/README.md#exit-codes).
The rule worth reading before you script around it: stdout carries the
report and the exit code summarises it. `check` exits `4` when a schema
is malformed, and still prints every finding it reached, so treating
non-zero as an opaque error throws away a complete payload.

## Versions

`createValidator` reads the spec's `openapi` string once at construction
and picks the matching dialect. No per-request branching.

| Spec  | Dialect               | Notes                                                       |
| ----- | --------------------- | ----------------------------------------------------------- |
| 3.0.x | OAS 3.0 Schema Object | `nullable`, boolean `exclusiveMin/Max`, sibling-`$ref` drop |
| 3.1.x | JSON Schema 2020-12   | Assertive `format`                                          |
| 3.2.x | JSON Schema 2020-12   | Same as 3.1 + the `QUERY` HTTP method                       |

3.2 coverage is the Schema Object (unchanged from 3.1) plus `QUERY`.
Other 3.2 document-level additions (`additionalOperations`,
`in: querystring`, streaming media types) aren't recognized yet. An
operation declared under `additionalOperations` is not routed, so a
request for it gets a 405 rather than being validated.

Override via `createValidator(spec, { dialect })` to force or customize
one of the built-in dialects (`jsonSchemaDialect`, `openapi31Dialect`,
`oas30Dialect`). The option wins over the version the document declares,
so a 3.1 spec compiled with `oas30Dialect` gets 3.0 semantics;
`validator.detectedVersion` still reports what the document says.
Unknown / missing `openapi` strings fall back to the 3.1 dialect by
default; configure with
`onUnknownVersion: "throw" | "warn" | "fallback31"`.

**Swagger 2.0 specs** aren't supported directly: `createValidator`
throws on `swagger: "2.0"` documents. Convert to OpenAPI 3.0 first with
[`swagger2openapi`](https://github.com/Mermade/oas-kit/tree/main/packages/swagger2openapi)
and pass the 3.0 output to `createValidator`:

```bash
npx swagger2openapi swagger.json -o openapi.json
```

### Node

Node 22 or newer, on every published package. Nothing older is tested,
and the packages declare `engines.node: ">=22"`, so an older runtime
fails at install rather than at runtime.

## Framework integration

The adapter packages
([`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md),
[`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md),
[`@oaverify/fastify`](https://github.com/oaverify/oaverify/blob/main/packages/oav-fastify/README.md))
cover request validation and share export names and option shapes; only
the framework type differs. Response validation, auth dispatch, upload
parsing, and custom error envelopes stay explicit in your application.

You are not locked into them. For Next.js, Hono, Bun, Deno, or a custom
stack, `validateRequest` / `validateResponse` (or the Fetch helpers
`validateFetchRequest` / `validateFetchResponse`) plus `httpStatusFor`,
`allowHeaderFor` and `toProblemDetails` wire up an inline adapter in
about fifteen lines.
[docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md)
has that recipe.

## Known limitations

Runtime behavior corners. For feature-scope tradeoffs against Ajv and
OpenAPI middleware packages (draft versions, `$data`, async
validation, response interception, upload helpers), see
[docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md).

- External / cross-document `$ref` loading is not supported inside the
  schema compiler; resolve the document first (`resolveSpec`, or the
  `resolve` CLI verb), which hoists external schema targets into
  `components.schemas`.
- `style: deepObject` query parameters support only single-level nesting (`obj[key]=value`); OpenAPI 3.0 through 3.2 do not define nested semantics.
- `pattern` keywords and `format: "regex"` compile to the JavaScript
  built-in `RegExp`, which has no execution timeout, so an
  attacker-controlled spec can carry a ReDoS pattern like `(a+)+$`.
  Pass a `regexCompiler` to plug in `re2` or a complexity check; see
  ["Hardening against untrusted regex patterns"
  ](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#hardening-against-untrusted-regex-patterns).
- Recursive schemas validate by recursing on the JavaScript call stack,
  so an unbounded payload nested a few thousand levels deep (only a few
  KB on the wire) throws `RangeError`. Set `maxDepth` to fail it as a
  `depth` error (HTTP 400) instead; see
  ["Guarding against deeply nested payloads"
  ](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#guarding-against-deeply-nested-payloads).

## Contributing

See [CONTRIBUTING.md](https://github.com/oaverify/oaverify/blob/main/CONTRIBUTING.md) for branch / PR / release flow.
Development workflow (lint / typecheck / test / build) and the
conformance and performance sub-packages are described there and in
[AGENTS.md](https://github.com/oaverify/oaverify/blob/main/AGENTS.md).

## License

MIT. See [LICENSE](https://github.com/oaverify/oaverify/blob/main/LICENSE).
