# oaverify

[![npm](https://img.shields.io/npm/v/oaverify)](https://www.npmjs.com/package/oaverify)
[![CI](https://github.com/oaverify/oaverify/actions/workflows/ci.yml/badge.svg)](https://github.com/oaverify/oaverify/actions/workflows/ci.yml)
[![types included](https://img.shields.io/badge/types-included-blue)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/npm/l/oaverify)](https://github.com/oaverify/oaverify/blob/main/LICENSE)

Validate HTTP requests and responses against your OpenAPI spec.
OpenAPI 3.0, 3.1, and 3.2, for JavaScript and TypeScript services.
Large JSON bodies stream through a separate validator that checks
them as they arrive, and a design-time analyzer reports which bodies
stream and which must buffer before you ship.

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

One call covers the whole HTTP frame: method, path, parameters, body,
content type, status, and headers. Errors come back as a flat list of
typed leaves (`code`, `path`, `message`, `params`) you render yourself,
or a nested tree on request. Invalid input is a return value, not a
thrown exception, and oaverify never mutates your `req` / `res`.

**Reach for oaverify when you want**

- A pre-deploy answer to "which request and response bodies can stream,
  which must buffer, and how large can a buffer get?" `analyzeSpec`
  reports a per-operation peak-buffer budget from the spec alone;
  `oaverify stream-check openapi.yaml` prints it as a table.
- To validate large JSON bodies as they arrive, without holding a
  multi-GB payload in heap. A separate streaming engine
  (`@oaverify/stream`) checks the body against its
  operation schema while echoing the bytes through.
- Validator construction cheap enough to run per tenant, per test, or on
  a cold start. Compiling a spec's schemas runs one to two orders of
  magnitude faster than Ajv on the benchmark shapes, and steady-state
  validation is competitive; numbers and method in
  [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md#performance).
- Structured errors with stable codes and paths, ready for
  `application/problem+json`, logs, or your own client messages.
- A spec compiled to a single zero-dependency module that runs where
  `new Function()` is unavailable: Cloudflare Workers, Vercel Edge,
  Lambda@Edge, Deno Deploy. (`oaverify compile-spec openapi.yaml`.)
- To extend a spec you don't own (a per-tenant required header, an added
  auth requirement, a tightened schema) with overlays instead of forking.

**At a glance:**

| If you need                                         | Start with                |
| --------------------------------------------------- | ------------------------- |
| Generic JSON Schema validation across many drafts   | Ajv                       |
| Turnkey Express middleware with uploads + auth      | express-openapi-validator |
| Framework-neutral OpenAPI request/response checking | oaverify                  |
| Streaming validation of large JSON bodies           | oaverify                  |
| A pre-deploy report of which bodies can stream      | oaverify                  |
| Per-tenant or per-deployment spec overlays          | oaverify                  |
| Per-tenant or per-request validator construction    | oaverify                  |
| A standalone validator for edge / serverless        | oaverify                  |

See [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)
for the full feature map.

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

`@oaverify/core` is the library and carries no runtime dependencies. It parses
JSON; YAML support is a separate package because it pulls in a parser.
The adapters and the streaming engine depend on `@oaverify/core`, so installing
one gets you both.

```bash
npm install @oaverify/core             # the library, zero runtime deps
npm install @oaverify/yaml             # YAML + smart HTTP readers
npm install @oaverify/express4         # Express 4 adapter
npm install @oaverify/express5         # Express 5 adapter
npm install @oaverify/fastify          # Fastify adapter
npm install @oaverify/stream # streaming validation + analyzeSpec
npm install -g oaverify               # the CLI
```

Want to try it against your own spec before wiring anything in? The CLI
validates a request from the command line, no code required:

```bash
npx oaverify validate openapi.yaml --path "POST /pets" --body pet.json
```

A valid request prints nothing and exits `0`; validation errors print to
stdout and exit non-zero. (Redirect with `--output <file>`, or silence the
report and rely on the exit code with `--quiet`.)

`@oaverify/core` exposes its surface at five subpath entrypoints (`/schema`,
`/spec`, `/overlay-spec`, `/formats`, `/core`) alongside the root export.
See [`docs/modules.md`](https://github.com/oaverify/oaverify/blob/main/docs/modules.md)
for what each one exports.

## Quick start

### Express

```ts
import express from "express";
import { createValidator } from "@oaverify/core";
import { loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/yaml";
import { validateRequests } from "@oaverify/express5";

const { document } = await loadSpec({
  reader: createYamlFileReader(),
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
import { loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/yaml";

const { document } = await loadSpec({
  reader: createYamlFileReader(),
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

### Streaming large bodies

`createValidator` validates a fully-parsed value. For a body too large
to hold in memory, the separate `@oaverify/stream`
package validates it as it streams, echoing the bytes through to a sink
while reporting violations on a side channel. It is a second engine,
not a mode of `createValidator`: your router still picks the operation,
and the validator checks one resolved schema.

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
buffer. `analyzeSpec` answers which bodies stream and which buffer (and
how large a buffer can get) from the spec alone, before any traffic:

```ts
import { analyzeSpec } from "@oaverify/stream";

for (const op of analyzeSpec(document).operations) {
  for (const body of op.bodies) {
    console.log(`${op.method} ${op.path} ${body.role}: ${body.report?.peakBytes ?? body.error}`);
  }
}
```

`oaverify stream-check openapi.yaml` prints the same per-operation budget as
a table (`--fail-on-unbounded` makes it a CI gate). The stream validator
is versioned with the `@oaverify/core` family on the same 4.x line;
see [`packages/stream-validator/README.md`](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md)
for the engine, the buffer model, and the edit hooks.

### Overlay quickstart

`applyOverlays` rewrites the document in memory before the validator
is constructed. Typical shapes:

```ts
import { applyOverlays } from "@oaverify/core/spec";
import type { SpecOverlay } from "@oaverify/core/spec";

// Add a deployment-specific server. `addServers` appends; `servers`
// replaces wholesale.
const eu: SpecOverlay = {
  addServers: [{ url: "https://eu.api.example.com" }],
};

// Require an API key on POST /pets without forking the base spec.
const requireKey: SpecOverlay = {
  overrides: {
    "/pets": {
      operations: { post: { addSecurity: [{ apiKey: [] }] } },
    },
  },
};

// Apply one rule to every operation matching a tag (walks paths and
// webhooks).
const lockInternals: SpecOverlay = {
  modifyOperations: [
    {
      where: { tags: ["internal"] },
      apply: { addSecurity: [{ internalKey: [] }] },
    },
  ],
};

// Tighten an upstream schema; the original definition still applies.
const requirePetId: SpecOverlay = {
  extendSchemas: { Pet: { required: ["id"] } },
};

const patched = applyOverlays(document, [eu, requireKey, lockInternals, requirePetId]);
const validator = createValidator(patched);
```

The full verb surface (component-bucket fan-out, predicate iterators,
operation-level metadata) is documented in
[`docs/overlays.md`](https://github.com/oaverify/oaverify/blob/main/docs/overlays.md); cross-cutting integration
shapes live in [`docs/integration.md`](https://github.com/oaverify/oaverify/blob/main/docs/integration.md).

## Where to go next

| Task                                       | Read                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Wire into Express, Fastify, Next.js, Hono  | [docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md)                                 |
| Stream large bodies / check buffer budgets | [packages/stream-validator/README.md](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md) |
| Patch a spec you do not own                | [docs/overlays.md](https://github.com/oaverify/oaverify/blob/main/docs/overlays.md)                                       |
| Emit standalone validators                 | [packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md#compile-spec-output)       |
| Compare against Ajv and other tools        | [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)                                   |
| Migrate from express-openapi-validator     | [docs/migration-from-eov.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-from-eov.md)                   |
| Use custom formats, keywords, or limits    | [docs/configuration.md](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md)                             |
| Work out what "strict" controls            | [docs/strictness.md](https://github.com/oaverify/oaverify/blob/main/docs/strictness.md)                                   |
| Upgrade from v4 to v5                      | [docs/migration-v5.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v5.md)                               |

## How it compares

The JavaScript ecosystem already has solid OpenAPI validation tools:
Ajv for JSON Schema, `express-openapi-validator` for Express,
`openapi-backend` for operationId routing plus validation, and smaller
request/response validators for custom stacks. oaverify is aimed at
HTTP-aware validation with structured errors, streaming validation of
large bodies plus design-time buffer budgets, overlays, and standalone
OpenAPI validator output. See [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md)
for the feature map, and [docs/migration-from-eov.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-from-eov.md)
if you are migrating from `express-openapi-validator`.

On raw speed, oaverify and Ajv trade wins: oaverify compiles schemas one to two
orders of magnitude faster, validates competitively on typical bodies,
and runs a touch lighter on memory than `express-openapi-validator`;
Ajv leads narrowly on fast-fail rejection of some plain object shapes.
At normal request volumes these gaps are nanoseconds per call.

For the host-stamped per-shape numbers, the memory comparison, and the
methodology, see [docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md).
Raw benchmark data lives in
[`performance/`](https://github.com/oaverify/oaverify/blob/main/performance/README.md).

## Conformance

The [`conformance/`](https://github.com/oaverify/oaverify/blob/main/conformance/README.md) sub-package drives the
compiler and CLI against the upstream JSON Schema 2020-12 Test Suite,
a set of OpenAPI 3.0 / 3.1 / 3.2 petstore scenarios, and a handful of
real-world specs (Stripe, GitHub, DigitalOcean, Twilio, Asana, Box,
Adyen) that have to load and compile without error. See
[`conformance/REPORT.md`](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md) for pass / fail
counts by category.

Categories oaverify does not aim to cover:

- `$dynamicRef` with runtime dynamic-scope rebinding (oaverify resolves
  statically against the anchor map).
- The `optional/format/*` subtree (`format` is annotation-only by
  default per JSON Schema 2020-12 §6.3).
- A small tail of isolated optional cases (float-overflow handling,
  external-ref loading tied to dynamic scope).

OpenAPI specs hand-authored or generated for typical APIs rarely
touch any of these. If they matter for your use case, the
[report](https://github.com/oaverify/oaverify/blob/main/conformance/REPORT.md) lays out which tests fail and why.

## CLI

```bash
oaverify resolve openapi.yaml
oaverify validate openapi.yaml --request req.http
oaverify validate openapi.yaml --path "POST /pets" --body payload.json
oaverify validate openapi.yaml --path "GET /pets" --response --status 200 --body resp.json
oaverify compile-schema schema.json -o validator.mjs             # JSON Schema -> standalone validator
oaverify compile-spec openapi.yaml  -o validator.mjs             # OpenAPI   -> standalone HTTP validator (edge / Lambda)
oaverify stream-check openapi.yaml                               # per-operation streamability + peak-buffer budget
```

Flags: `--format text|json|summary`, `--depth n`, `--overlay file`
(repeatable), `-o file`, `--quiet`, `--dialect` (compile-schema /
compile-spec), `--requests-only` (compile-spec), `--only METHOD PATH`
(compile-spec, repeatable), `--verbose` / `--fail-on-unbounded` /
`--format json` (stream-check). See
[packages/cli/README.md](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md) for the full
surface, the `.http` file format, and both compile commands' output
contracts.

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
`oas30Dialect`). Unknown / missing `openapi` strings fall back to the
3.1 dialect by default; configure with
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

`@oaverify/core` is a validator library, not a middleware package: you write a short
adapter between your framework and `validateRequest` /
`validateResponse`, or use one of the companion adapter packages. An
inline Express 5 adapter is about this long:

```ts
import { allowHeaderFor, httpStatusFor, toProblemDetails } from "@oaverify/core";

app.use(async (req, res, next) => {
  const result = validator.validateRequest({
    method: req.method,
    path: req.path,
    query: req.query as Record<string, string | string[]>,
    headers: req.headers as Record<string, string | string[]>,
    contentType: req.get("content-type") ?? undefined,
    body: req.body,
  });
  if (result.valid) return next();
  const allow = allowHeaderFor(result.errors);
  if (allow !== undefined) res.setHeader("Allow", allow);
  res
    .status(httpStatusFor(result.errors))
    .type("application/problem+json")
    .json(toProblemDetails(result.errors, { instance: req.originalUrl }));
});
```

`httpStatusFor`, `allowHeaderFor`, and `toProblemDetails` accept either
the flat `errors` list or a tree `error`, so this wiring is the same
whichever `output` the validator uses.

Companion adapter packages cover common request-validation wiring:
[`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md),
[`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md), and
[`@oaverify/fastify`](https://github.com/oaverify/oaverify/blob/main/packages/oav-fastify/README.md). They share export
names and option shapes; only the framework type differs.

For Next.js, Hono, Bun, Deno, and custom frameworks, use the
framework-agnostic `validateRequest` / `validateResponse` calls or the
Fetch helpers (`validateFetchRequest`, `validateFetchResponse`). See
[docs/integration.md](https://github.com/oaverify/oaverify/blob/main/docs/integration.md) for body parsing,
response validation, uploads, security, ignored paths, and custom error
envelopes.

oaverify is not a drop-in replacement for `express-openapi-validator`.
The adapters cover request validation; response validation, auth
dispatch, upload parsing, and custom error envelopes stay explicit in
your application. In return, the validator does not mutate `req` or
`res`, OpenAPI 3.0 behavior is built into the dialect, and failures
come back as structured errors (a flat list by default, a nested tree
on request) rather than framework-specific error classes.

## Known limitations

Runtime behavior corners. For feature-scope tradeoffs against Ajv and
OpenAPI middleware packages (draft versions, `$data`, async
validation, response interception, upload helpers), see
[docs/comparison.md](https://github.com/oaverify/oaverify/blob/main/docs/comparison.md).

- `$dynamicRef` behaves like `$ref` with anchor lookup; no runtime dynamic-scope traversal.
- `style: deepObject` query parameters support only single-level nesting (`obj[key]=value`); OpenAPI 3.0–3.2 don't define nested semantics.
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
  the validator: a payload past the cap fails as a `depth` error (HTTP 400) instead of crashing. For untrusted input set `maxDepth`, and
  optionally cap nesting at the parse boundary as a backstop; see
  ["Guarding against deeply nested payloads"
  ](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#guarding-against-deeply-nested-payloads).

## Contributing

See [CONTRIBUTING.md](https://github.com/oaverify/oaverify/blob/main/CONTRIBUTING.md) for branch / PR / release flow.
Development workflow (lint / typecheck / test / build) and the
conformance and performance sub-packages are described there and in
[CLAUDE.md](https://github.com/oaverify/oaverify/blob/main/CLAUDE.md).

## License

MIT. See [LICENSE](https://github.com/oaverify/oaverify/blob/main/LICENSE).
