# Examples

Self-contained TypeScript examples that exercise the most common
`oaverify` entry points. Each file loads a spec from [`specs/`](./specs)
and prints what it did to stdout, the same pattern a real application
uses.

## Running

From the repo root, after `pnpm install`:

```bash
pnpm dlx tsx examples/<example>.ts
```

The examples import from `packages/*/src` directly so they work without
`pnpm build`. Third-party consumers would write
`import { ... } from "@oaverify/core"` instead; the logic
translates 1:1. `resolveSpec`, `loadSpec`, and the readers live at
`@oaverify/core/spec`, and the YAML readers
(`createYamlFileReader`, `createSmartHttpReader`) come from
`@oaverify/syntax`, since `@oaverify/core` is JSON-only.

The streaming examples import from `packages/stream-validator/src`, which
translates to `@oaverify/stream`. That is a separate
package (not part of the `oaverify` / `@oaverify/core` re-export), versioned
independently on its own version line:

```bash
npm install @oaverify/stream
```

## What's in here

| File                           | Spec                  | Shows                                                                               |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------- |
| `basic-validation.ts`          | `petstore.yaml`       | Load a spec → `createValidator` → request + response checks                         |
| `custom-formats.ts`            | `contacts.yaml`       | Register a user format (E.164 phone) via the `formats` option                       |
| `custom-keywords.ts`           | `widgets.yaml`        | Register a schema keyword (`activeTenant`) via the `keywords` option                |
| `cross-field-validation.ts`    | `ranges.yaml`         | Cross-field constraint (`max >= min`) via an object-level custom keyword            |
| `max-errors.ts`                | `items.yaml`          | Fast-fail and bounded error collection on a bulk-invalid payload                    |
| `output-modes.ts`              | `items.yaml`          | `output: "flat" / "tree" / "predicate"` on one invalid request                      |
| `max-depth.ts`                 | `tree.yaml`           | Bound a recursive schema so deep nesting is a 400, not a `RangeError`               |
| `combine-validators.ts`        | `petstore` + `items`  | `combineValidators`: one gateway over several specs, overlap and no-owner policy    |
| `versions.ts`                  | `pets-3.{0,1,2}.yaml` | 3.0, 3.1, and 3.2 side by side: `nullable`, QUERY method, etc.                      |
| `overlay.ts`                   | `petstore.yaml`       | Minimal overlay: merge a gateway header requirement into one op                     |
| `overlay-petstore-schema.ts`   | `petstore.yaml`       | Extend the `Pet` component with a deployment-required field                         |
| `overlay-petstore-endpoint.ts` | `petstore.yaml`       | Require an `X-Tenant` header on `POST /pets` via an endpoint overlay                |
| `spec-digest.ts`               | `uploads.yaml`        | Derive middleware config (multer limits, required headers) from the spec at startup |
| `spec-check.ts`                | `catalog.yaml`        | Check the spec itself: every example validated against the schema it illustrates    |
| `fetch-handler.ts`             | `petstore.yaml`       | Web Standards `Request`/`Response` handler: Next.js, Hono, Bun, Deno                |

See [`docs/overlays.md`](../docs/overlays.md) for a walk-through of the overlay
shape and when to use each section (`extendSchemas`, `replaceSchemas`,
`overrides`, `addPaths`).

`spec-check.ts` covers the one check class `@oaverify/core` carries on
its own. The other four (`hygiene`, `schema`, `conformance`, `redos`)
need the conformance meta-schemas and the ReDoS detector, which core does
not carry, so they live in `@oaverify/check`. That package composes all
five as a library call (`checkSpec`), and `oaverify check` is the CLI in
front of it. The file shows both halves: the core-only library call, and
the CLI invocations for the rest.
See [`docs/strictness.md`](../docs/strictness.md).

### Why there is no Express or Fastify example here

The framework adapters are the most likely first contact with the
library, so their absence from this directory is deliberate rather than
an oversight. These examples run against the main workspace, which does
not install `express` (the root `.npmrc` sets `auto-install-peers=false`
so adapter peer deps stay out of the main lockfile, #295), and
`pnpm typecheck` type-checks this directory. An adapter example here
would neither run nor type-check without undoing that.

The adapter recipes live in
[`docs/integration.md`](../docs/integration.md), and
[`framework-tests/`](../framework-tests), which owns the framework
runtimes, exercises all three adapters against real servers.
`fetch-handler.ts` is the runnable middleware-shaped example, since the
Web Standards path needs no adapter package and no peer dependency.

### Streaming

The streaming validator (`@oaverify/stream`) is a second
engine: it validates a JSON body as the bytes flow through,
echoing them out unchanged, without buffering the whole document. The
runtime examples break the load-a-spec / print-a-verdict mold: they pipe
a lazily generated body through `createStreamValidator` and read the
side channel, so each fabricates its body inline rather than loading a
fixture. `stream-budget.ts` is the design-time exception: it analyzes a
spec (`ingest.yaml`) and prints the buffer budget without streaming any
bytes at all.

| File                       | Shows                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| `stream-basic.ts`          | `pipeline` echo-through; the `violation` channel and `result` verdict             |
| `stream-from-spec.ts`      | Bridge a resolved spec to a body validator with `streamValidatorForOperation`     |
| `stream-limits.ts`         | Bound untrusted input: `enforceBounds`, `maxTotalBytes`, eager `maxItems`         |
| `stream-recover-fields.ts` | Recover top-level scalars with `valueEvents` while a large body streams           |
| `stream-budget.ts`         | Pre-deploy buffer budget with `analyzeSpec`: peak bytes, the unbounded punch list |

## Conventions

- Specs live in [`specs/`](./specs) as YAML files, loaded via
  `loadSpec` + `createYamlFileReader`. The same pattern works for a
  real application's spec; swap the entry path.
- Success paths print `ok`; failure paths print the formatted error
  tree so you can see what the validator surfaces.
