# oaverify

[![npm](https://img.shields.io/npm/v/oaverify)](https://www.npmjs.com/package/oaverify)
[![CI](https://github.com/oaverify/oaverify/actions/workflows/ci.yml/badge.svg)](https://github.com/oaverify/oaverify/actions/workflows/ci.yml)
[![types included](https://img.shields.io/badge/types-included-blue)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/npm/l/oaverify)](https://github.com/oaverify/oaverify/blob/main/LICENSE)

oaverify validates HTTP requests and responses against OpenAPI 3.0,
3.1, and 3.2 documents in JavaScript and TypeScript services. Use it
when an OpenAPI spec is the contract for a service, gateway, test
suite, or edge deployment and you need framework-neutral validation
with structured errors.

The core package builds a validator from a parsed OpenAPI document.
Companion packages add YAML loading, Express and Fastify adapters, a
CLI, standalone validator generation, and streaming validation for
large JSON bodies.

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
  // [{ code: "required", path: ["body", "age"], message: "...", params: {} }]
}
```

One validation call covers the HTTP frame: method, path, parameters,
body, content type, status, and headers. Failures are return values
(structured errors, not throws), and framework request and response
objects are never mutated.

Tested against the JSON Schema 2020-12 test suite, OpenAPI 3.0 / 3.1 /
3.2 fixtures, real-world specs (Stripe, GitHub, Twilio, and more), and
Express 4 / 5 + Fastify integration. See
[what works today](#conformance).

## Install

Pick the packages that match what you need.

| You need                                        | Install                                 |
| ----------------------------------------------- | --------------------------------------- |
| The library: validate requests and responses    | `@oaverify/core`                        |
| Loading specs written in YAML                   | `@oaverify/core` + `@oaverify/yaml`     |
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
If size is a constraint, measure the imports you actually use; the
figures move with the version.

## Quick start

### Express

```ts
import express from "express";
import { createValidator } from "@oaverify/core";
import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/yaml";
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
import { createYamlFileReader } from "@oaverify/yaml";

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

## Common use cases

- Validate parsed requests and responses in any Node, edge, or Fetch API
  handler.
- Mount request-validation middleware in Express 4, Express 5, or
  Fastify.
- Report document conformance, spec hygiene, malformed schemas, and
  schema-lint findings in CI with `oaverify check`, gated by severity.
- Validate large JSON bodies as bytes arrive with `@oaverify/stream`.
- Estimate per-operation streaming buffer budgets before deployment
  with `analyzeSpec` or `oaverify stream-check`.
- Build validators cheaply enough for per-tenant setup, tests, and
  cold-start paths.
- Compile an OpenAPI document to a standalone ESM validator for
  runtimes where runtime code generation is unavailable.
- Apply deployment-specific or tenant-specific overlays to a base spec
  before constructing a validator.

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
import { applyOverlays } from "@oaverify/core/spec";
import type { SpecOverlay } from "@oaverify/core/spec";

// Require an API key on POST /pets; tighten the upstream Pet schema.
const deployment: SpecOverlay = {
  overrides: {
    "/pets": { operations: { post: { addSecurity: [{ apiKey: [] }] } } },
  },
  extendSchemas: { Pet: { required: ["id"] } },
};

const validator = createValidator(applyOverlays(document, [deployment]));
```

The full verb surface (servers, paths, component-bucket fan-out,
predicate iterators) is documented in
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
| Upgrade from v4 to v5                      | [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md)                               |
| Upgrade from v5 to v6                      | [docs/migration-v6.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md)                               |

## How it compares

The JavaScript ecosystem already has solid OpenAPI validation tools:
Ajv for JSON Schema, `express-openapi-validator` for Express,
`openapi-backend` for operationId routing plus validation, and smaller
request/response validators for custom stacks. oaverify is aimed at
HTTP-aware validation with structured errors, streaming validation of
large bodies plus design-time buffer budgets, overlays, and standalone
OpenAPI validator output.

On the benchmark shapes, oaverify compiles schemas one to two orders of
magnitude faster than Ajv. Steady-state validation is comparable across
typical request and response bodies, with Ajv ahead on fast-fail
rejection of some plain object shapes.

[docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)
has the feature map, the host-stamped per-shape numbers, the memory
comparison, and the methodology; raw benchmark data lives in
[`performance/`](https://github.com/oaverify/oaverify/blob/main/performance/README.md).
Migrating from `express-openapi-validator`:
[docs/migration-from-eov.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-from-eov.md).

`oaverify check` is a different comparison, against spec linters rather
than runtime validators.
[`detection/`](https://github.com/oaverify/oaverify/blob/main/detection/README.md)
is a labelled corpus for it: minimal documents carrying one seeded defect
each, run through oaverify, Spectral, Redocly and Ajv, where a tool
scores only when it reports that document's defect. It shows what each
tool can catch, not how often the defect occurs, and the cases oaverify
misses are in there too.

## Conformance

The [`conformance/`](https://github.com/oaverify/oaverify/blob/main/conformance/README.md) sub-package drives the
compiler and CLI against the upstream JSON Schema 2020-12 Test Suite,
a set of OpenAPI 3.0 / 3.1 / 3.2 petstore scenarios, and a handful of
real-world specs (Stripe, GitHub, DigitalOcean, Twilio, Asana, Box,
Adyen) that have to load and compile without error. See
[`conformance/REPORT.md`](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md) for pass / fail
counts by category.

Out-of-scope categories:

- The `optional/format/*` subtree (`format` is annotation-only by
  default per JSON Schema 2020-12 §6.3).
- External / cross-document `$ref` loading.
- A small tail of isolated optional cases (float-overflow handling,
  a meta-schema declaring no validation vocabulary).

OpenAPI specs hand-authored or generated for typical APIs rarely
touch any of these. If they matter for your use case, the
[report](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md) lays out which tests fail and why.

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
`in: querystring`, streaming media types) aren't recognized yet.

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

## Configuring the validator

`createValidator(spec, options)` accepts options for dialect override,
custom formats and keywords, error budget, schema lint, security
shape-checking, ignored paths, and version-mismatch policy. See
[`docs/configuration.md`](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md) for the option
table, custom-keyword recipe, and bounded-error-collection details.
The canonical contract is the `ValidatorOptions` TSDoc.

## Framework integration

The adapter packages cover request validation and share export names
and option shapes; only the framework type differs:
[`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md),
[`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md), and
[`@oaverify/fastify`](https://github.com/oaverify/oaverify/blob/main/packages/oav-fastify/README.md).
Response validation, auth dispatch, upload parsing, and custom error
envelopes stay explicit in your application.

You are not locked into the adapters. For Next.js, Hono, Bun, Deno, or
a custom stack, the framework-neutral `validateRequest` /
`validateResponse` calls (or the Fetch helpers `validateFetchRequest` /
`validateFetchResponse`) plus the response helpers (`httpStatusFor`,
`allowHeaderFor`, `toProblemDetails`) wire up an inline adapter in
about fifteen lines. [docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md)
has that recipe, plus body parsing, response validation, uploads,
security, ignored paths, and custom error envelopes.

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
  built-in `RegExp`, which has no execution timeout. If your OpenAPI
  spec is attacker-controlled (e.g. multi-tenant upload), a
  catastrophic pattern like `(a+)+$` is a ReDoS vector against any
  string the validator checks. Pass a `regexCompiler` to
  `createValidator` to plug in `re2` or a complexity-checking engine;
  see ["Hardening against untrusted regex patterns"
  ](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#hardening-against-untrusted-regex-patterns).
- Recursive schemas validate by recursing on the JavaScript call
  stack. Unbounded, a deeply nested payload (a few thousand levels,
  only a few KB on the wire) can exhaust the stack and throw
  `RangeError: Maximum call stack size exceeded`. Set the `maxDepth`
  option (`CompileOptions` / `ValidatorOptions`) to bound recursion at
  the validator: a payload past the cap fails as a `depth` error (HTTP 400). For untrusted input set `maxDepth`, and
  optionally cap nesting at the parse boundary as a backstop; see
  ["Guarding against deeply nested payloads"
  ](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#guarding-against-deeply-nested-payloads).

## Contributing

See [CONTRIBUTING.md](https://github.com/oaverify/oaverify/blob/main/CONTRIBUTING.md) for branch / PR / release flow.
Development workflow (lint / typecheck / test / build) and the
conformance and performance sub-packages are described there and in
[AGENTS.md](https://github.com/oaverify/oaverify/blob/main/AGENTS.md).

## License

MIT. See [LICENSE](https://github.com/oaverify/oaverify/blob/main/LICENSE).
