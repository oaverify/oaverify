# oav

[![npm](https://img.shields.io/npm/v/@aahoughton/oav)](https://www.npmjs.com/package/@aahoughton/oav)
[![CI](https://github.com/aahoughton/oav/actions/workflows/ci.yml/badge.svg)](https://github.com/aahoughton/oav/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@aahoughton/oav)](https://github.com/aahoughton/oav/blob/main/LICENSE)

The command-line tool for [oav](https://github.com/aahoughton/oav):
validate requests, responses, and examples against an OpenAPI 3.0 /
3.1 / 3.2 document, resolve multi-file specs, report streaming budgets,
and compile standalone validators.

This package ships the `oav` binary and nothing else. The library API
lives in
[`@aahoughton/oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core);
importing from this package will not resolve.

## Install

Try it without installing:

```bash
npx @aahoughton/oav validate openapi.yaml --path "POST /pets" --body pet.json
```

Or put it on your PATH:

```bash
npm install -g @aahoughton/oav
```

As a project dev-dependency, for CI checks or build-time validator
generation:

```bash
npm install --save-dev @aahoughton/oav
```

`compile-schema` and `compile-spec` bundle with esbuild, which is an
optional peer dependency. Install `esbuild` alongside if you use them;
the other commands do not need it.

## Commands

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `validate`       | Check a request, response, or body against the spec          |
| `resolve`        | Stitch a multi-file document and print the result            |
| `stream-check`   | Report the per-operation streaming buffer budget             |
| `compile-spec`   | Emit a standalone HTTP validator module for a whole document |
| `compile-schema` | Emit a standalone validator module for a single JSON Schema  |

Full flags and output shapes are in
[`packages/cli/README.md`](https://github.com/aahoughton/oav/blob/main/packages/cli/README.md).

A quick taste. Validation exits `0` when the payload conforms and
non-zero when it does not, so it drops into CI as-is:

```bash
oav validate openapi.yaml --path "POST /pets" --body pet.json
oav validate openapi.yaml --path "GET /pets/{id}" --body body.json --response --status 200
```

Errors print as a nested tree carrying `code`, `path`, `message`, and
`params`. `params` includes the offending value, so a finding is
self-explanatory without a second lookup:

```json
{
  "code": "enum",
  "path": ["body", "status"],
  "message": "must be one of the allowed values",
  "params": { "allowed": ["open", "closed"], "actual": "pending" }
}
```

Ask which bodies can stream before you ship:

```bash
oav stream-check openapi.yaml
```

YAML and JSON both work everywhere a spec is accepted, including specs
fetched over HTTP where the server advertises YAML by `Content-Type`.

## Using the library instead

To validate inside your application rather than from a shell:

```bash
npm install @aahoughton/oav-core
```

```ts
import { createValidator } from "@aahoughton/oav-core";

const validator = createValidator(document);
const result = validator.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});
```

Add [`@aahoughton/oav-yaml`](https://www.npmjs.com/package/@aahoughton/oav-yaml)
if your specs are YAML; `oav-core` parses JSON only, which is what keeps
it free of runtime dependencies.

For framework wiring there are adapter packages
([`oav-express4`](https://github.com/aahoughton/oav/blob/main/packages/oav-express4/README.md),
[`oav-express5`](https://github.com/aahoughton/oav/blob/main/packages/oav-express5/README.md),
[`oav-fastify`](https://github.com/aahoughton/oav/blob/main/packages/oav-fastify/README.md)),
and for bodies too large to buffer there is
[`@aahoughton/oav-stream-validator`](https://www.npmjs.com/package/@aahoughton/oav-stream-validator).

## See also

- [Top-level `README.md`](https://github.com/aahoughton/oav/blob/main/README.md): rationale, install matrix, comparison.
- [`docs/modules.md`](https://github.com/aahoughton/oav/blob/main/docs/modules.md): what each package and subpath exports.
- [`docs/integration.md`](https://github.com/aahoughton/oav/blob/main/docs/integration.md): adapter recipes and manual wiring for Next.js, Hono, Bun, Deno.
- [`packages/stream-validator/README.md`](https://github.com/aahoughton/oav/blob/main/packages/stream-validator/README.md): streaming validation and the buffer-budget analyzer.
