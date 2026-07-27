# CLAUDE.md: project-internal notes for contributors using Claude Code

## Contribution principles

How to make decisions when extending this repo. The mechanics
sections below cover _how_ to add a thing; this section is about
_whether_ and _what shape_.

### Surface tradeoffs honestly

When a design choice has real tradeoffs (fat vs thin adapter, mocks
vs integration tests, one PR vs many, opinionated default vs escape
hatch), say so. Recommend a lean. Defer the call rather than picking
silently. A half-articulated choice that survives review is harder
to revisit than one that was explicitly weighed. The point is the
surfacing, not the agonizing: options + lean + decision space, not
exhaustive analysis.

### Talk through design before drafting

For substantive new APIs (a new package, a non-trivial option
addition, a default-behavior shift), open the conversation before
writing code. Sketch the API shape, list open questions, recommend
defaults. The cost of one round-trip on the design saves several on
the implementation when an early choice would have wanted to be
different. For small fixes and obvious changes, just do it; judgment.

### Naming and consistency

Names that pair (`request`/`response`, `validateRequest`/`validateResponse`,
`Validator`/`ValidatorOptions`, `httpRequestFromExpress`/`httpRequestFromFetch`)
carry meaning beyond what each name says alone: a reader should be
able to predict one from the other. When you add a new symbol, look
for the sibling that should pair with it, even if you're only writing
one half today. Across-package symmetry is a feature: every adapter
package exports the same factory names with the same option shapes,
with only the framework-typed argument varying. Per-framework types
use framework-native names (`ExpressContext`, `FastifyContext`); names
that sit above the framework boundary stay identical everywhere.

If a name reads awkwardly in user code (`requestValidator(validator)`,
three "validator"s, three meanings), that's a signal to rename, not
to add a comment.

### Forward-compatible API shapes

Design v0 surfaces so v1 additions land as new exports / new options,
not changed semantics. The Express 4 adapter shipped with
`validateRequests` named so that any response-validating sibling
added later would slot in additively, sharing option names, the
default renderer, and the context shape. Picking those identifiers
up front cost nothing; doing it after the fact would have meant a
breaking rename. When you can't tell whether a new option will need
to extend later, lean toward shapes that widen additively (`select:
"first" | "deepest" | { byCode }`, not `byCodeOnly: boolean`).

### No magic

Prefer explicit docs warnings over silent runtime detection of common
gotchas. The Express adapter doesn't auto-detect missing
`express.json()`; the README flags it. Implicit fallbacks, surprise
behaviors, and "we'll figure out what you meant" all create debugging
dead ends. Better to error early with a clear message, or not at all
and let the user's own logic fail in a familiar way.

### Type as canonical contract

TSDoc on the type is the API reference. Prose docs (READMEs,
docs/integration.md) are recipes: worked examples that show how
the pieces compose, with backreferences to the type for the contract.
When adding a new option-bearing interface, lead its TSDoc with a
roadmap of the field groups so editor tooling surfaces the surface
on first read. When adding a recipe in docs/integration.md, include
a "see {type}" backreference so the reader knows where the source of
truth lives.

### Prose Style

LLM-like writing breaks reader flow. Readers familiar with the
patterns notice them, snap out of whatever they were absorbing, and
have to reset. Avoid the patterns for the reader's sake, not for
camouflage. Applies to docs, TSDoc, commit messages, PR descriptions,
and code comments. The big ones:

- **Em-dash.** Replace `—` with a period, comma, semicolon,
  parenthesis, or colon.
- **Contrastive negation.** "Not X, it's Y" / "not just X, but Y" /
  "this isn't a fix, it's a rewrite." Make the affirmative claim
  directly.
- **Filler and hedging.** Throat-clearers ("honestly," "frankly,"
  "essentially") and stacked hedges ("may," "might," "could
  potentially") read as AI; drop them. Different from substantive
  adverbial use, e.g. the "honestly" in "Surface tradeoffs honestly"
  above.
- **Over-promising vocabulary.** "Robust," "elegant," "powerful,"
  "seamless," "comprehensive," "delve," "leverage," "unlock."
  Substantiate concretely or drop.

Generated output (error messages, log lines, anything the code itself
emits) is ASCII-only, simple, and concise. Data passed through from a
spec or user input is unchanged.

### Scope discipline

One PR per logical concern. Tightly-coupled fixes bundle (the
publish-tooling trio: preinstall guard + prepack + npm-pack guard
all touched the same script surface and shipped together).
Anything that could be reverted independently → separate PR.
Adjacent cleanups noticed during a fix → file as a `polish` issue,
don't sneak in. The `polish` label exists for "real but not urgent"
work: fix when next touching the area, not preemptively.

### Verify before declaring done

For substantive changes (new packages, behavior shifts, packaging
work), exercise the change end-to-end before committing. Mocks
cover the logic; smoke tests prove the integration. Bug fixes
start with a reproducer; confirming the bug exists rules out
fixing the wrong thing. The pack-smoke CI job catches install
regressions; if your change touches packaging, run the smoke
locally too (`pnpm pack` + `npm install` in `/tmp`).

## Build commands

```bash
pnpm install
pnpm build                        # tsup: oav-core + stream-validator + the oav CLI
pnpm test                         # vitest for everything
pnpm vitest run packages/schema   # run a single package's tests (path filter)
pnpm lint                         # oxlint + oxfmt --check + check:deps
pnpm check:deps                   # assert the @oaverify/internal-* dependency graph (see below)
pnpm fmt                          # oxfmt --write .
pnpm typecheck                    # tsc -b (composite project references)
pnpm oav <args>                   # run the built CLI (e.g. pnpm oaverify stream-check spec.yaml)
```

`pnpm test` uses vitest with workspace aliases from `vitest.config.ts` so
tests run against `packages/*/src` directly; no need to build before
testing.

`pnpm oav` runs `packages/oav/dist/cli.js`, so it needs a prior `pnpm build`
(which builds oav-core, the standalone stream-validator, and the CLI). The
standalone-tsup packages (`oav`, `stream-validator`, the three adapters)
set `emitDeclarationOnly: true` in their `tsconfig.json`: their `dist/` is
the tsup-built runtime artifact, and without this `tsc -b` (typecheck)
would emit per-file `.js` over the tsup bundle, breaking the built CLI
until the next `pnpm build`. Leave it in place. (The `@oaverify/internal-*` packages
bundled into `oav-core` don't need it: their `dist/` is unused, since the
root tsup bundles them from source.)

Use `pnpm pack` (not `npm pack`) for any workspace package. `npm pack`
ships unrewritten `workspace:*` deps; the prepack guard rejects it
with a hint, but the failure is a context switch best avoided by
reaching for `pnpm pack` directly.

## Dev-only sub-packages (standalone; not in the workspace)

- `conformance/`: upstream JSON Schema Test Suite + OpenAPI case
  harness. `cd conformance && pnpm install` to bootstrap.
- `performance/`: compile / validate benchmarks against other JSON
  Schema validators. `cd performance && pnpm install` to bootstrap.
- `framework-tests/`: real-server integration tests for the
  `oav-express4` / `oav-express5` / `oav-fastify` adapters. Owns the
  framework runtime devDeps so they stay out of the main lockfile and
  the main dependabot directory's scan (#295). Run with
  `cd framework-tests && pnpm install && pnpm test` (and `pnpm typecheck`,
  which is wired into CI). Express 4 and Express 5 coexist via npm
  aliasing (`express-4`, `express-5`); see the directory's README.
  Adapter-package unit tests (`extract.test.ts`, `middleware.test.ts`,
  `render.test.ts`, fastify's `hook.test.ts`) still live in their
  packages and run on `pnpm test` from the root.

All three have their own `package.json` + `pnpm-workspace.yaml` (with
empty `packages:` list so pnpm treats them as isolated roots). Their
external dev-dependencies (benchmark runners, competing validators,
framework runtimes, `tsx`) are NOT in the main workspace install.
`conformance/` and `performance/` are not type-checked in CI;
`framework-tests/` is.

The root `.npmrc` sets `auto-install-peers=false` so the adapter
packages' peer-dep declarations (`express`, `fastify`) do not
silently pull the framework runtimes into the main workspace
lockfile. `fastify` is the one exception still installed in the main
workspace: `oav-fastify/src/*.ts` imports `import type { FastifyRequest } from "fastify"`
and there is no `@types/fastify` on DefinitelyTyped, so the package
itself has to be present for tsc to resolve the type.

Each sub-root (`conformance/`, `framework-tests/`, `performance/`,
`performance/mem-bench/`) also ships its own `.npmrc` pinning
`auto-install-peers=true`. CI reads the sub-root `.npmrc` (it stops at
the sub-root's `pnpm-workspace.yaml` boundary), while dependabot's
lockfile refresh walks up to the root; the explicit per-root file
keeps them agreeing, otherwise dependabot writes
`autoInstallPeers: false` lockfiles and CI fails with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

## Architecture, package by package

Import surface is in [docs/modules.md](./docs/modules.md); each
package's README covers its responsibilities. The non-obvious nugget
per package:

- **`@oaverify/internal-core`**: the shared error-tree model and HTTP/format
  helpers. Every package except the leaf `@oaverify/internal-formats` depends on it;
  it depends on nothing.
- **`@oaverify/internal-schema`**: the JSON Schema 2020-12 compiler; walks a schema,
  dispatches each keyword via `KeywordDefinition.compile(ctx)`, and
  `eval`s the generated source through `new Function(deps, src)`.
  Boolean schemas are first-class; `$ref` uses an identity-keyed cache
  so self-recursive refs emit normal recursive calls. Codegen
  mechanics live behind the `@oaverify/core/schema/internals` subpath (not
  semver-covered; reach for them only when a plugin truly needs them).
- **`@oaverify/internal-formats`**: pure string validators, a `Record<string, (s:
string) => boolean>` shaped for `compileSchema`'s `formats` option. A
  leaf alongside `core`: no workspace dependencies.
- **`@oaverify/internal-spec`**: `DocumentReader` (file/http/memory/composite) plus
  `resolveSpec()`, which inlines external `$ref`s and leaves circular
  ones as internal refs. `applyOverlays()` is the extension system.
- **`@oaverify/internal-overlay-spec`**: OpenAPI Overlay 1.0 -> typed `SpecOverlay`.
  Closed-form recogniser, not a JSONPath engine; unrecognised target
  shapes throw with the offending string. Subpath `@oaverify/core/overlay-spec`.
- **`@oaverify/internal-router`**: sorted-list route matcher; `match` is a linear
  scan, O(routes x segments). Cheap for typical spec sizes (see #327).
- **`@oaverify/internal-validator`**: the HTTP orchestrator. `createValidator`
  pre-compiles per-operation schemas on first access and prefixes each
  sub-validator's subtree with its HTTP location (`body`, `query`, …)
  so error paths are unambiguous. Also exports the Fetch-API adapter
  (`httpRequestFromFetch`, …) for Next.js / Hono / Bun / Deno.
- **`@oaverify/stream`** (published standalone on its own
  independent `1.x` line, not folded into the `oav-core` bundle): a second, push-based
  streaming engine. Beyond
  `createStreamValidator`, it exports the **streamability analyzer**:
  `analyzeStreamability(schema)` returns a peak-buffer budget (where a
  schema buffers and how much, in wire bytes, `"unbounded"` where a
  structural bound is missing), and `analyzeSpec(doc)` rolls that up per
  operation (request + each response body). The analyzer mirrors the
  spine's `computeKind` (not just the classifier's `strategyOf`), so
  `contains` / asserting `format` / `uniqueItems` are caught as buffering;
  it is engine-free (calls neither the spine nor `createStreamValidator`),
  so a consumer importing only the analyzer does not pull the engine. Body
  extraction (`carryComponents`, `resolveLocalRef`) lives in the shared
  engine-free `openapi/body-schema.ts` so both `operation.ts` and the
  analyzer use it.
- **`@oaverify/internal-cli`**: thin commander wrapper. The one place it reaches past
  pure wiring is `stream-check`, which calls `analyzeSpec` and renders the
  per-operation table; the business logic stays in the analyzer, the CLI
  owns only the rendering (`stream-check.ts`).
- **`@oaverify/internal-oav-express4` / `oav-express5` / `oav-fastify`**: thin
  framework adapters with identical export names and option shapes
  (`validateRequests`, `httpRequestFrom<Framework>`,
  `renderProblemDetails`, `ValidateRequestsOptions`); only the
  framework-typed `Context` field names differ
  (`ExpressContext { req, res, next }` vs
  `FastifyContext { request, reply }`). `oav-express4` forwards thrown
  errors via `next(err)`; the express5 / fastify variants are
  async-native. See the "Naming and consistency" principle for why the
  shapes are kept identical.

## Dependency graph (strictly enforced; no cycles)

```
cli           → validator → router
                         → spec → core
                         → formats
                         → schema → core
                         → core
              → spec → core
              → overlay-spec → spec → core
              → core
              → stream-validator (the published @oaverify/stream)
overlay-spec  → spec → core
              → core
oav-express4  → validator → ... (same as cli's chain)
              → core
              (peer: express ^4)
oav-express5  → same chain, peer: express ^5
oav-fastify   → same chain, peer: fastify ^5
```

Asserted by `scripts/check-deps.mjs` (wired into `pnpm lint`): the
runtime `@oaverify/internal-*` graph (from each package's `dependencies`) stays
acyclic, and declarations match imports both ways (no `@oaverify/internal-*` declared
but unimported, none imported but undeclared). "Declared" unions
`dependencies` + `devDependencies`, since the internal `@oaverify/internal-*` packages
carry their deps at runtime while the published `@aahoughton/*` bundles
carry the same `@oaverify/internal-*` as build-only devDeps. Adding a real edge means
updating both the graph above and the relevant `package.json`; a phantom
or undeclared edge fails the build.

The `cli → stream-validator` edge is the one exception not asserted by
`check-deps`: the stream validator is published standalone as
`@oaverify/stream` (not an `@oaverify/internal-*` bundle-member), so the
CLI imports it by that published name, which `check-deps` (scoped to
`@oaverify/internal-*`) does not police. Its source alias lives in `workspace-aliases.ts`
(consumed by vitest + tsup) and the published `oaverify` carries it
as a real runtime dependency (the same shape the framework adapters use for
`@oaverify/core`). The `pack-smoke` job installs the locally-packed
stream-validator tarball alongside oav so this dep resolves to the workspace
build, not the registry. `stream-validator` is unlinked from the `oav-core`
release group (its own independent line, currently `1.x`), so a
`stream-validator` bump can ripple into a CLI release that picks it up.

## Extending the compiler

Full procedures for adding a keyword, a string format, or an output
format are in [docs/extending.md](./docs/extending.md); the
`KeywordCompileContext` field reference is the TSDoc on the type
(`packages/schema/src/keywords/types.ts`), per "Type as canonical
contract". Two gotchas the docs can't enforce, worth keeping in view:

- **Keyword flags drive specialization silently.** `applicator`,
  `annotation`, and `evaluates` on a `KeywordDefinition` change codegen
  paths; a wrong flag mis-fires correctness or perf with no error. See
  their TSDoc for what each breaks.
- **New error codes need a `BuiltInErrorParams` entry** in
  `packages/core/src/errors.ts`. Errors are emitted through generated
  JS source, so the compiler can't check the `code`/`params` contract;
  drift between the emitted shape and that type is a silent bug.

## Output modes and the error budget

The zero-config default is `output: "flat"` + `maxErrors: 1` (Ajv
parity). `output` (`"flat" | "tree" | "predicate"`) selects the result
shape; the deprecated `flat` / `predicate` booleans are aliases that
throw on conflict. `maxErrors` defaults to `1` and is orthogonal to
`output`. User-facing docs are in
[docs/configuration.md](./docs/configuration.md),
[docs/extending.md](./docs/extending.md), and the v3
[migration guide](./docs/migration-v3.md).

Codegen is specialized so `maxErrors: Infinity` emits source identical
to the un-budgeted path (zero overhead). The one gotcha for keyword
authors: the `kind` on `ctx.emitError` (`"leaf"` counts against the
budget, `"lift"` is an already-counted child being propagated and never
touches the counter). Pick wrong and the budget silently miscounts.
TypeScript forces the choice; the correctness of it is on the author.

A finite `maxErrors` must never change a valid/invalid verdict (it only
caps how many errors are _reported_). The budget short-circuit is unsafe
under evaluated-key tracking: a cap can exhaust mid-evaluation and
either starve a real error or truncate a sub-validator's evaluated-key
set, flipping an `unevaluated*` verdict. So `CompileState.gated` is
`finite maxErrors && !unevaluatedTracking`: schemas that use
`unevaluatedProperties` / `unevaluatedItems` collect every error (the
cap is not enforced). `unevaluated*` never appears in OpenAPI, so the
HTTP fast path is unaffected. Relatedly, `contains` tests membership
with a predicate sub-validator (never charging the budget for its
discarded per-item errors).

## Version support

User-facing version support is in the
[README `## Versions`](./README.md#versions); dialect internals (what
differs in 3.0, dispatch, per-version test layout) are in
[docs/dialects.md](./docs/dialects.md). Dispatch is a single
`dialectFor(version)` at construction, so added versions cost nothing
per request.

## Known limitations

- `$dynamicRef` currently behaves like `$ref` with an anchor lookup; no
  runtime dynamic-scope traversal. Good enough for schemas that don't
  actually rewire the extension point at runtime.
- `unevaluated*` evaluated-key tracking is gated at compile time on
  a one-pass walk of the root schema and any registered external
  schemas. If nothing uses `unevaluatedProperties` / `unevaluatedItems`,
  the compiler suppresses the per-function `evalProps` / `evalItems`
  Sets and the merge loop that threads them up to the caller.
  See `CompileState.unevaluatedTracking` and `schemaUsesUnevaluated`
  in `packages/schema/src/compiler/compiler.ts`.
- Recursive schemas validate by recursing on the native JS call stack
  (a self-`$ref` emits a recursive call). Unbounded, a payload nested
  a few thousand levels deep throws `RangeError` from stack exhaustion
  (empirically ~5k frames on a default Node stack). The
  `maxDepth` option (`CompileOptions` / `ValidatorOptions`) bounds it:
  the compiler instruments only recursive (`$ref` back-edge) calls with
  a `deps.depth` counter and emits a `depth` error leaf (HTTP 400) when
  the cap is exceeded, so a deep payload fails as a client error
  instead of crashing. Unset, codegen is byte-identical to the
  un-instrumented path (zero overhead); see `compileGuardedRefCall` in
  `packages/schema/src/keywords/ref.ts` and the `compiling` /
  `depthGated` fields on `CompileState`. `deepEqual` (for
  `uniqueItems` / `const` / `enum`) descends iteratively, so it can't
  overflow independently of `$ref` recursion. Untrusted callers can
  still cap nesting at the parse boundary for defense in depth (see
  docs/configuration.md "Guarding against deeply nested payloads").
