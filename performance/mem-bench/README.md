# @oaverify-dev/mem-bench

Two Express 4 servers over the same OpenAPI document, one wrapping
oaverify and one wrapping
[express-openapi-validator](https://github.com/cdimascio/express-openapi-validator)
(which pulls in ajv). They exist to be measured, not to be run directly.

The driver is [`../mem.ts`](../mem.ts), from the `performance/` root:

```bash
cd performance
pnpm bench:mem                                       # 100 x 500 = 50,000 requests
BATCHES=6 PER_BATCH=200 WARMUP=100 pnpm bench:mem    # quick smoke
```

This is a **separate pnpm root** from `performance/` for one reason: it
needs `express` and `express-openapi-validator` installed as real
dependencies so both servers resolve their own framework, and neither
belongs in the benchmark root's dependency tree. Bootstrap it once:

```bash
cd performance/mem-bench
pnpm install
```

`pnpm bench:mem` will fail with `server ... exited early (1)` if this has
not been done.

## What each server exposes

Both serve the endpoints in [`openapi.yaml`](./openapi.yaml) (~40 schemas:
discriminated payment-method unions, nested address and amount objects,
array-of-items transfers) plus one instrumentation route:

- `GET /__memory` returns `process.memoryUsage()` plus uptime.
- `GET /__memory?gc=1` forces two GC passes first, so a reading is taken
  against a collected heap rather than whatever the allocator happened to
  be holding. Needs `--expose-gc`, which `mem.ts` passes.

`/__memory` is registered **before** the validation middleware in both
servers, deliberately. It is not in the spec, so a validator that ran
first would 404 the probe and the driver would have nothing to read.

## Which imports go where

`server-oav.mjs` imports from the library packages, not from `oaverify`:

| Symbol                                                                   | From                  |
| ------------------------------------------------------------------------ | --------------------- |
| `createValidator`, `httpStatusFor`, `allowHeaderFor`, `toProblemDetails` | `@oaverify/core`      |
| `loadSpec` (async)                                                       | `@oaverify/core/spec` |
| `createYamlFileReader`                                                   | `@oaverify/yaml`      |

The `oaverify` package is the CLI and exports nothing importable, and
`@oaverify/core` is JSON-only and dependency-free, which is why the YAML
reader comes from a different package. Importing from `oaverify` is what
broke this harness before; there is no root export to fall back on, so it
fails at startup rather than degrading.
