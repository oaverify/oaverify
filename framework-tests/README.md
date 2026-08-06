# framework-tests

Isolated integration tests for the `@oaverify/express4`,
`@oaverify/express5`, and `@oaverify/fastify` adapters.

## Why this lives outside the main workspace

The framework runtimes (express 4, express 5, fastify) are heavy
transitive-dependency surfaces and the source of most of our dependabot
noise. Their CVEs (`qs`, `path-to-regexp`, `fast-uri`, etc.) never reach
end users of the adapter packages: express and fastify are declared as
peer dependencies, so users install their own. The repo only needed them
for integration tests.

Moving those tests into this isolated pnpm root keeps the framework
runtimes out of the main workspace's `pnpm-lock.yaml`, which is what
the root dependabot directory scans. Dependabot watches this directory
separately (see `.github/dependabot.yml`); CVEs land here as their own
PRs rather than failing the main repo's security tab.

See issue #295 for the full rationale.

## Install + run

```sh
cd framework-tests
pnpm install --frozen-lockfile
pnpm check        # typecheck + test, which is exactly what CI runs here
pnpm test         # vitest run
pnpm typecheck    # tsc --noEmit
```

CI runs the same two commands in the `framework-tests` job.

## How express 4 and 5 coexist

Both express majors are installed via npm aliasing:

```json
"express-4": "npm:express@4.22.2",
"express-5": "npm:express@5.2.1"
```

Tests import via the alias (`import express from "express-4"`); the
matching `@types/express-4` / `@types/express-5` aliases keep type
resolution honest. The alias only changes the directory name in
`node_modules`; the installed code is the real express package, so
runtime behavior is identical to a normal `import express from "express"`
in user code.

## Why fastify still appears in `@oaverify/fastify`'s devDependencies

Express ships its types separately (`@types/express`), so the
`@oaverify/express{4,5}` adapter packages keep only `@types/express` as a
devDep and rely on this sub-package for the express runtime. Fastify
ships its own types, and there is no `@types/fastify` on
DefinitelyTyped; `packages/oav-fastify/src/*.ts` imports `import type { FastifyRequest } from "fastify"`,
which TypeScript can only resolve if the `fastify` package itself is
present at the package being type-checked. So `fastify` stays in
`@oaverify/fastify` devDependencies for type-check purposes, even though the
integration test runs here. Dependabot noise from fastify transitives
is therefore not eliminated by this split, only the much larger express
noise is.

## How tests reach into the main packages

`vitest.config.ts` registers `@oaverify/internal-*` aliases that resolve directly into
`../packages/<pkg>/src/index.ts`, the same way the main repo's vitest
config does. Tests run against source, not against built `dist/`
artifacts. The `pack-smoke` CI job already covers the dist surface.
