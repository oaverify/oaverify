# oav

[![npm](https://img.shields.io/npm/v/@aahoughton/oav)](https://www.npmjs.com/package/@aahoughton/oav)
[![CI](https://github.com/aahoughton/oav/actions/workflows/ci.yml/badge.svg)](https://github.com/aahoughton/oav/actions/workflows/ci.yml)
[![types included](https://img.shields.io/badge/types-included-blue)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/npm/l/@aahoughton/oav)](https://github.com/aahoughton/oav/blob/main/LICENSE)

Validate HTTP requests and responses against your OpenAPI spec.
OpenAPI 3.0, 3.1, and 3.2, for JavaScript and TypeScript services. One
call checks the whole HTTP frame (method, path, parameters, body,
content type, status, headers) and hands back structured errors you
render yourself.

This is the batteries-included package: the full `oav-core` validator
surface plus YAML spec readers and the `oav` CLI. For a zero-dependency
install (JSON or pre-parsed specs, for edge / serverless runtimes), use
[`@aahoughton/oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core)
directly; the programmatic surface is identical.

```ts
import { createValidator, createYamlFileReader } from "@aahoughton/oav";
import { loadSpec } from "@aahoughton/oav/spec";

const { document } = await loadSpec({
  reader: createYamlFileReader(),
  entry: "openapi.yaml",
});
const validator = createValidator(document);

const result = validator.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});
// result.valid -> boolean; result.errors -> typed error list
```

Two sibling packages are easy to miss from here. The framework
adapters ([below](#framework-integration)) wire this validator into
Express or Fastify as middleware. And for JSON bodies too large to
buffer, the separate
[`@aahoughton/oav-stream-validator`](https://www.npmjs.com/package/@aahoughton/oav-stream-validator)
package validates the body as it streams, with bounded memory; this
package's `oav stream-check openapi.yaml` reports which of a spec's
bodies can stream and which must buffer, before any traffic.

Tested against the JSON Schema 2020-12 test suite, OpenAPI 3.0 / 3.1 /
3.2 fixtures, real-world specs, and Express 4 / 5 + Fastify integration.
Full rationale, install matrix, the tool comparison, and benchmark
numbers live in the
[project README](https://github.com/aahoughton/oav/blob/main/README.md).

## When to use which

| Package    | When to use                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oav`      | Includes YAML readers and the `oav` CLI binary. Pulls in `yaml` and `commander`. `esbuild` is an optional peer dep; install it alongside `oav` if you use `oav compile-schema` / `oav compile-spec`.    |
| `oav-core` | Lean. Zero runtime dependencies. JSON specs only (or pre-parsed objects via the memory reader). Use on Cloudflare Workers, Vercel Edge, Lambda@Edge, or anywhere the YAML/CLI footprint isn't worth it. |

`oav` re-exports every subpath of `oav-core` at the matching path
(`oav/schema`, `oav/spec`, `oav/overlay-spec`, `oav/formats`,
`oav/core`, and the `*/internals` companions). Code written against
one swaps to the other by changing the package name in imports; no
surface changes.

## What this package adds

- **`createYamlFileReader()`**: file reader for `.yaml` / `.yml`
  paths. Calling `oav-core`'s `createFileReader()` on a YAML path
  throws an install-hint pointing here.
- **`createSmartHttpReader()`**: HTTP reader that parses both JSON
  and YAML by inspecting `Content-Type` / file extension.
- **`parseYamlString(source)`**: exposed for callers loading YAML
  out-of-band (e.g. fetched from a config service).
- **`loadSpecSync({ entry })`**: blocking spec loader for code that
  builds a validator in a synchronous bootstrap and can't `await`
  `loadSpec`. Its default reader covers `.yaml` / `.yml` and `.json`
  on disk, so a single call resolves a YAML spec and its cross-file
  `$ref`s. JSON-only callers can use `oav-core`'s `loadSpecSync` from
  `oav/spec`; see [the loader docs](https://github.com/aahoughton/oav/blob/main/packages/spec/README.md#synchronous-loading)
  for the blocking caveat and the load-or-skip pattern.

  ```ts
  import { createValidator, loadSpecSync } from "@aahoughton/oav";

  const { document } = loadSpecSync({ entry: "openapi.yaml" });
  const validator = createValidator(document);
  ```

- **The `oav` CLI binary**: `oav resolve`, `oav validate`,
  `oav compile-schema`, `oav compile-spec`, `oav stream-check`. See
  [`packages/cli/README.md`](https://github.com/aahoughton/oav/blob/main/packages/cli/README.md) for commands and
  flags.

Everything else (`createValidator`, `compileSchema`, error helpers,
formatters, `formatSummary`, `toProblemDetails`, HTTP-status helpers, …)
is re-exported from `oav-core`. Documentation for those lives in:

- [`packages/core/README.md`](https://github.com/aahoughton/oav/blob/main/packages/core/README.md): error tree,
  formatters, HTTP helpers.
- [`packages/validator/README.md`](https://github.com/aahoughton/oav/blob/main/packages/validator/README.md): the
  HTTP validator.
- [`packages/schema/README.md`](https://github.com/aahoughton/oav/blob/main/packages/schema/README.md): the JSON
  Schema compiler.
- [`packages/spec/README.md`](https://github.com/aahoughton/oav/blob/main/packages/spec/README.md): multi-file
  loader, resolver, overlays.
- [`packages/overlay-spec/README.md`](https://github.com/aahoughton/oav/blob/main/packages/overlay-spec/README.md):
  OpenAPI Overlay 1.0 spec-format translator.
- [`packages/formats/README.md`](https://github.com/aahoughton/oav/blob/main/packages/formats/README.md): built-in
  string format validators.

## Framework integration

`oav` is a validator, not a middleware package. Companion adapter
packages cover the framework wiring:
[`oav-express4`](https://github.com/aahoughton/oav/blob/main/packages/oav-express4/README.md),
[`oav-express5`](https://github.com/aahoughton/oav/blob/main/packages/oav-express5/README.md),
[`oav-fastify`](https://github.com/aahoughton/oav/blob/main/packages/oav-fastify/README.md). See
[`docs/integration.md`](https://github.com/aahoughton/oav/blob/main/docs/integration.md) for adapter recipes plus
manual integration patterns for Next.js, Hono, Bun, and Deno via
the Web Standards adapter.

## See also

- [Top-level `README.md`](https://github.com/aahoughton/oav/blob/main/README.md): full rationale, install
  matrix, comparison.
- [`docs/integration.md`](https://github.com/aahoughton/oav/blob/main/docs/integration.md): adapter recipes,
  security wiring, response validation, file uploads, migration.
- [`docs/overlays.md`](https://github.com/aahoughton/oav/blob/main/docs/overlays.md): extending an externally-owned
  base spec at load time.
- [`packages/stream-validator/README.md`](https://github.com/aahoughton/oav/blob/main/packages/stream-validator/README.md):
  streaming body validation and the buffer-budget analyzer.
- [`docs/comparison.md`](https://github.com/aahoughton/oav/blob/main/docs/comparison.md): feature and performance
  comparison vs Ajv and other tools.
