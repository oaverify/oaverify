# AGENTS.md: notes for agents and contributors working in this repo

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.

User-facing documentation lives in [`docs/`](./docs) and in each
package's README; the import surface is in
[docs/modules.md](./docs/modules.md). This file holds what you cannot
derive from reading the code: how to decide, which commands actually
gate CI, and the handful of design facts that a plausible-looking
change gets wrong.

## Working agreements

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

That symmetry is why `packages/oav-express4` and `packages/oav-express5`
contain near-identical files. The duplication is deliberate: sharing
~220 lines would cost a package boundary and framework-agnostic types,
and `middleware.ts` diverges exactly where Express 4 and 5 semantics do.
A DRY pass across the adapters is not wanted.

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

A corollary, because it has already been violated: a rule constraining
what a caller may pass belongs in the TSDoc. Header-name casing lived
only as a `// lowercased keys` comment in a recipe while the type said
nothing, and the lookup code drifted into three strategies underneath.

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
pnpm build                        # tsup: @oaverify/core + stream + yaml + check + the oaverify CLI
pnpm check                        # the PR gate: test + typecheck + lint + lint:type-aware
pnpm test                         # vitest for everything
pnpm vitest run packages/schema   # run a single package's tests (path filter)
pnpm lint                         # oxlint + oxfmt --check + check:deps
pnpm lint:type-aware              # oxlint --type-aware (NOT part of `pnpm lint`; CI runs it)
pnpm check:deps                   # assert the @oaverify/internal-* dependency graph (see below)
pnpm check:release                # assert release.yml's package lists against release-please-config.json
pnpm fmt                          # oxfmt --write .
pnpm typecheck                    # tsc -b (composite project references)
pnpm clean                        # drop dist/, coverage/, *.tsbuildinfo
pnpm grid-check [rev]             # differential: the parameter grid, this tree vs a base revision
pnpm oaverify <args>              # run the built CLI (e.g. pnpm oaverify stream-check spec.yaml)
```

`pnpm test` uses vitest with workspace aliases from `vitest.config.ts` so
tests run against `packages/*/src` directly; no need to build before
testing.

**`pnpm lint` is not the whole lint gate.** CI runs `pnpm lint:type-aware`
as a separate step (`.github/workflows/ci.yml`), and `pnpm lint` does not
include it. It enables oxlint's type-aware rules, which need type
information and so catch a class the plain pass cannot see:
`typescript(no-misused-spread)` on `[...str].length` is the one that has
actually bitten, and the fix was to use the existing `countCodePoints`
helper rather than suppress it. A green `pnpm lint` locally and a red
`lint` job in CI is this, every time. Before committing, run the four
that CI runs:

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm lint:type-aware
```

If `pnpm typecheck` reports errors in files you have not touched, the
incremental `tsc -b` state is stale rather than the code being wrong;
`pnpm clean && pnpm typecheck` settles it. A fresh clone typechecks with
no build at all, so this is always a local-state problem and CI never
sees it.

`pnpm oaverify` runs `packages/oav/dist/cli.js`, so it needs a prior `pnpm build`
(which builds `@oaverify/core`, `@oaverify/stream`, `@oaverify/syntax`,
`@oaverify/check`, and the CLI; the CLI loads `@oaverify/check` at runtime,
so a build that skips it leaves every subcommand crashing on import).
That set is not "everything publishable": `pnpm build` means "make the
CLI runnable from the repo", so it covers exactly the CLI's runtime
dependency closure and deliberately skips the three adapters, whose
`dist/` nothing in-repo consumes (tests run from `src` via aliases;
publishing rebuilds via each `prepack`). `scripts/check-release-lists.mjs`
(wired into `pnpm lint` as `check:release`) derives that closure from
`packages/oav/package.json` and asserts the build script matches, and
asserts `release.yml`'s three hand-maintained package lists (dispatch
tag validator, Pack loop, publish ORDER) against
`release-please-config.json`. The
standalone-tsup packages (`oaverify`, `stream-validator`, `check`, the three adapters)
set `emitDeclarationOnly: true` in their `tsconfig.json`: their `dist/` is
the tsup-built runtime artifact, and without this `tsc -b` (typecheck)
would emit per-file `.js` over the tsup bundle, breaking the built CLI
until the next `pnpm build`. Leave it in place. (The `@oaverify/internal-*`
packages bundled into `@oaverify/core` don't need it: their `dist/` is unused,
since the root tsup bundles them from source.)

Use `pnpm pack` (not `npm pack`) for any workspace package. `npm pack`
ships unrewritten `workspace:*` deps; the prepack guard rejects it
with a hint, but the failure is a context switch best avoided by
reaching for `pnpm pack` directly.

## Differential checking

```bash
pnpm grid-check           # ~5,100 parameter requests, this tree vs main
pnpm grid-check <rev>     # vs any revision
```

Run it on any branch that touches parameter deserialization, routing, or
coercion. It builds the base revision in a temporary worktree, runs the
same generated grid against both, and triages every difference into
regressions, intended fixes, silent value changes, error-shape changes,
crashes, and grid drift. Full rationale in
[scripts/grid/README.md](./scripts/grid/README.md).

It is a review aid and CI does not run it. A deliberate behaviour change
lands in the regression bucket, which is correct; the point is that you
read the list rather than that it stays empty.

Two things it exists to catch that nothing else here does. The **silent**
bucket (both revisions accept the request, the handler receives a
different value) has no other gate, and it is what #751 shipped. And a
consistency relation cannot see a defect that is symmetric under its own
transformation, which is why #742 survived 21,420 metamorphic cases and
three review passes; the differential is what found it.

It is not a conformance corpus, and a clean run means "nothing changed"
rather than "this is correct": two revisions wrong the same way is a
clean run. It also carries known holes that a large case count disguises,
the largest being that `style` and `explode` are always declared here and
are left unset on ~92% of real published parameters, which is a different
code path. `scripts/grid/README.md` lists the rest. Read them before
treating a green `grid-check` as coverage.

## Coverage

```bash
pnpm test:coverage        # vitest run --coverage; enforces the thresholds
pnpm coverage:by-package  # roll the summary up per package (advisory)
```

The thresholds in `vitest.config.ts` are a ratchet, set just under the
numbers on the day the gate landed. Raise one when a run clears the next
step; never lower one to turn a red run green. A file that genuinely
cannot be covered gets an exclude naming what does exercise it, the way
`packages/oav/src/cli.ts` names `pack-smoke`.

Three things the numbers don't say:

- `coverage.include` is explicit because v8 only sees files a test
  imported. Without it, a module nothing loads is absent from the report
  rather than reported at 0%.
- The global number averages a 10x spread; `@oaverify/internal-schema`
  is a quarter of all statements and can carry a thin package under the
  floor. `pnpm coverage:by-package` splits it. No per-package
  thresholds: fourteen numbers to maintain, and the per-package view
  works better as a review input than a gate.
- Coverage runs only in the main workspace, so the adapter packages are
  understated by whatever `framework-tests/` contributes.

## Architecture: the non-obvious, package by package

Import surface is in [docs/modules.md](./docs/modules.md); each
package's README covers its responsibilities. What follows is only what
a reader does not derive from the code quickly enough, and gets wrong
in the meantime.

- **`@oaverify/internal-core`**: owns the public structural contracts
  (`HttpRequest`, `HttpResponse`, the error tree, formatters). Changing
  or adding an error code starts here.
- **`@oaverify/internal-schema`**: the JSON Schema 2020-12 compiler; walks a
  schema, dispatches each keyword via `KeywordDefinition.compile(ctx)`,
  and `eval`s the generated source through `new Function(deps, src)`.
  Boolean schemas are first-class; `$ref` uses an identity-keyed cache
  so self-recursive refs emit normal recursive calls. Codegen mechanics
  sit behind `@oaverify/core/schema/internals`, which is outside the
  semver contract.
- **`@oaverify/internal-formats`**: the built-in format validators,
  shaped as `Record<string, FormatDefinition>` because that shape is
  `compileSchema`'s `formats` option. One registry whatever JSON type a
  format constrains: string formats are bare predicates (the shorthand),
  `int32` / `int64` declare `type: "number"`, and `false` registers a
  name that asserts nothing. `FormatDefinition` and `normalizeFormat`
  live in `internal-core`, which is the edge that stops this package
  being a leaf. Keeping one registry is what leaves `KNOWN_FORMATS`,
  `unknownFormats` and the stream options with nothing to change when
  a numeric format is added.
- **`@oaverify/internal-metaschema`**: the published OpenAPI meta-schemas,
  pinned per version, plus `metaschemaVersionOf()` dispatch. Consumed by
  `@oaverify/check`'s conformance pass through the `/conformance`
  subpath, and bundled into that tarball. The 3.0 document
  is generated from the checked-in upstream draft-04 document by
  `scripts/convert-oas30.mjs` and is never hand-edited. Keep the package
  off `@oaverify/core`'s entries: `metaschemaFor` reaches all three
  documents, so anything importing it pays ~100KB. 3.1/3.2 stub the
  Schema Object and 3.0 describes it in full, which is why conformance
  and the schema classes overlap only on 3.0; docs/strictness.md carries
  the precedence rule.
- **`@oaverify/internal-spec`**: `DocumentReader` (file/http/memory/composite)
  plus `resolveSpec()`, which **hoists** external schema targets into
  `components.schemas` and leaves an internal `$ref` at each use site,
  so a schema keeps an address instead of being copied per reference.
  That address is what the `discriminator` matches its branches by
  (#553) and what gives a recursive external schema a legal home
  (#556); it also means a schema used by N operations is stored once.
  External refs in non-schema positions (Response, Parameter, Path Item
  Objects) still inline, and a cycle among _those_ still stitches under
  `$defs.__ext__`. `applyOverlays()` is the extension system.
- **`@oaverify/internal-overlay-spec`**: OpenAPI Overlay 1.0 -> typed
  `SpecOverlay`. A closed-form recogniser, not a JSONPath engine;
  unrecognised target shapes throw with the offending string.
- **`@oaverify/internal-router`**: sorted-list route matcher; `match` is a
  linear scan, O(routes x segments). Deliberate, and cheap for typical
  spec sizes (see #327).
- **`@oaverify/internal-validator`**: the HTTP orchestrator. `createValidator`
  pre-compiles per-operation schemas on first access and prefixes each
  sub-validator's subtree with its HTTP location (`body`, `query`, …)
  so error paths are unambiguous. Also exports the Fetch-API adapter
  (`httpRequestFromFetch`, …) for Next.js / Hono / Bun / Deno.
- **`@oaverify/stream`**: a second, push-based streaming engine, published
  standalone. Beyond `createStreamValidator` it exports the
  streamability analyzer: `analyzeStreamability(schema)` returns a
  peak-buffer budget (`"unbounded"` where a structural bound is
  missing), and `analyzeSpec(doc)` rolls that up per operation. Two
  constraints hold it together. It mirrors the spine's `computeKind`
  rather than the classifier's `strategyOf` alone, because `strategyOf`
  marks `contains`, asserting `format`, `uniqueItems`, and complex
  `enum`/`const` as forward/scalar while the spine still materializes
  them, so `strategyOf` alone under-reports buffering (`nodeKind` in
  `analyzer/analyze.ts`). And it is engine-free, calling neither the
  spine nor `createStreamValidator`, so importing only the analyzer does
  not pull the engine; body extraction therefore lives in the shared
  `openapi/body-schema.ts`.
- **`@oaverify/internal-cli`**: thin commander wrapper. The two places
  it reaches past pure wiring are `stream-check`, which calls
  `analyzeSpec` and renders the per-operation table, and `check`, which
  calls `checkSpec` and renders that. Business logic stays in the
  analyzer and in `@oaverify/check`; the CLI owns flag parsing, the text
  report and the exit codes. Loading is the CLI's too, because it is the
  asynchronous half and `checkSpec` is deliberately synchronous.
- **`@oaverify/check`**: the composed document check, published. Owns
  the six passes, the finding contract, the code registry, the grading
  table and the SARIF emitter. `checkSpec` takes a `ResolvedSpec`, not
  an `OpenAPIDocument`: provenance regions and `inlinedComponents` are
  byproducts of resolution that a document cannot reconstruct, and
  without them every finding loses `target.source` and SARIF loses its
  locations. Two hazards live here. The `precompile` /
  `stats.schemaLintIssues` pair in `check.ts` is order-sensitive:
  compiling is what fills the stats array, so a read before the call
  reports nothing. The two need not be adjacent: `precompile` returns a
  materialised array. That compile is what the class costs (#624).
  And only a failure to build the validator becomes
  `CheckAbortedError` / exit 2; a throw from any other pass propagates
  to exit 3, as it did before the move.
- **`@oaverify/express4` / `@oaverify/express5` / `@oaverify/fastify`**: thin
  framework adapters with identical export names and option shapes
  (`validateRequests`, `httpRequestFrom<Framework>`,
  `renderProblemDetails`, `ValidateRequestsOptions`); only the
  framework-typed `Context` field names differ
  (`ExpressContext { req, res, next }` vs
  `FastifyContext { request, reply }`). `@oaverify/express4` forwards
  thrown errors via `next(err)`; the express5 / fastify variants are
  async-native. See "Naming and consistency" for why the shapes, and the
  duplication, are kept.
- **`@oaverify/syntax`**: the parsers, and the only published package
  that carries one (`@oaverify/core` is JSON-only and dependency-free).
  Its YAML readers compose ahead of the JSON-only ones; `loadSpecSync` exists in both
  packages with different reader defaults. See docs/modules.md.

## Package roles, and where a third-party dependency may go

Five roles. The role decides which third-party runtime dependencies a
package may carry, and `scripts/check-deps.mjs` asserts it from the
manifests, so getting it wrong fails `pnpm lint` rather than reaching a
design conversation.

| Role    | Packages                                                                       | Third-party runtime deps                    |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| kernel  | `@oaverify/core`, `@oaverify/stream`, every `@oaverify/internal-*` bar the CLI | none, ever                                  |
| source  | `@oaverify/syntax`                                                             | the parsers, whatever the syntax            |
| check   | `@oaverify/check`                                                              | analysis-only, required to produce findings |
| cli     | `oaverify`, `@oaverify/internal-cli`                                           | composition and presentation                |
| adapter | `@oaverify/express4`, `@oaverify/express5`, `@oaverify/fastify`                | none; frameworks are peers                  |

The kernel's promise is the load-bearing one: it operates on
already-parsed JavaScript values, so there is nothing in it a
third-party library could be for, and someone embedding a validator
never takes on parser or tooling weight to get one. Everything else is
downstream of keeping that true.

Two rules that are easy to get wrong from the table alone:

- **The list in `ROLES` is by dependency name, not by role alone.** "The
  CLI may take composition dependencies" would permit a JSON parser to
  sit in the CLI, which is the thing the check exists to reject. A new
  dependency is a deliberate edit there with a role to justify it; a
  version bump touches nothing.
- **A private bundle member's dependency is a published dependency.** It
  ships inside whichever tarball bundles it, which is why the internal
  packages are in the table at all and why `@oaverify/internal-cli`
  carrying `commander` is a real dependency of `oaverify`.

A capability that needs a parser and has no home is a sign the roles are
wrong, not a reason to hide it in the nearest package that already has a
dependency.

### Large vendored reference data

Data is its own class, and the roles above do not decide it. The
OpenAPI meta-schemas are the case: ~100KB of vendored documents with no
runtime behaviour of their own, which `metaschemaFor` reaches all three
of, so anything importing it pays for all three.

Keep it off `@oaverify/core`, and bundle it into the package whose
public semantics require it. `@oaverify/internal-metaschema` is bundled
into `@oaverify/check`, which is the only package that needs the
documents to do its job.

Promote it to a published package when a **second published consumer**
needs the same data as part of its own public semantics. Publishing
earlier buys symmetry and costs a tarball, a release-group member and a
pack-smoke entry, for a package nobody imports directly. An editor
integration is the expected first trigger: completion and hover are
driven by these documents, so a package offering them would be the
second consumer, and its promotion belongs in that design rather than
ahead of it.

## Dependency graph (strictly enforced; no cycles)

Every `@oaverify/internal-*` package's runtime `dependencies`, as an
adjacency list. Read it as a DAG: a tree drawing cannot express shared
nodes without repeating them, and repetition is how edges went missing
here before.

```
core            (leaf)
formats       → core
schema        → core
spec          → core
router        → core
overlay-spec  → core spec
metaschema    → core schema
validator     → core formats router schema spec
cli           → core formats overlay-spec schema spec validator
```

`scripts/check-deps.mjs` (wired into `pnpm lint`) asserts that graph
from the manifests: it stays acyclic, and declarations match imports both
ways (no `@oaverify/internal-*` declared but unimported, none imported
but undeclared). "Declared" unions `dependencies` + `devDependencies`,
since the internal packages carry their deps at runtime while the
published `@oaverify/*` bundles carry the same ones as build-only
devDeps. Adding a real edge means updating the relevant `package.json`;
a phantom or undeclared edge fails the build.

The script reads the manifests, not this file, so the list above can
drift out of date while `pnpm check:deps` stays green. It has. If you
need the authoritative graph, generate it:

```bash
for d in packages/*/; do jq -r 'select(.name|startswith("@oaverify/internal-"))
  | "\(.name) -> \((.dependencies//{})|keys|map(select(startswith("@oaverify/internal-")))|join(" "))"' \
  "$d/package.json" 2>/dev/null; done
```

Published companion packages contribute no edges to the graph above,
since they are not bundle members: their internal deps sit in
`devDependencies` and are bundled at publish. They are **not** outside
`check-deps` altogether, which is easy to assume and wrong. The script
reads every `packages/*/package.json`, unions `dependencies` and
`devDependencies`, filters to `@oaverify/internal-*`, and matches that
against imports in both directions. So a published package that
declares an internal it does not import fails the build as a phantom
dependency, exactly as an internal one would; only the acyclicity check
skips them.

`@oaverify/stream`, `@oaverify/syntax` and `@oaverify/check` share the
shape: internal packages appear as build-only devDeps and get bundled at
publish, while the runtime `dependencies` name the published surface
(`@oaverify/core`, plus `yaml` and `redos-detector` respectively). The
three adapters take the same shape, each depending on `@oaverify/core`
with the framework as a peer (`express ^4`, `express ^5`,
`fastify ^5`). The published `oaverify` CLI depends on
`@oaverify/core`, `@oaverify/check`, `@oaverify/stream`, and
`@oaverify/syntax`, with `esbuild` as a peer for `compile-spec`.

`@oaverify/check` is the one companion that bundles an internal package
rather than rewriting it to a `@oaverify/core` subpath:
`@oaverify/internal-metaschema` is not a core entry, for the ~100KB
reason above, so its tsup config carries a `bundledWorkspace` map the
way `packages/oav`'s does. `packages/oav` stopped bundling it when the
conformance pass moved, which `test/alias-parity.test.ts` records in
`NOT_IN_OAV_BUNDLE`. So the
CLI's edge to the stream validator is real and unasserted. Its source alias
lives in `workspace-aliases.ts` (consumed by vitest + tsup), the
published `oaverify` carries it as a real runtime dependency, and the
`pack-smoke` job installs the locally-packed tarball so the dep resolves
to the workspace build rather than the registry. `stream-validator` is
linked into the `@oaverify/core` release group because its public
contract tracks the core/schema semantics.

## Repo layout and dev-only sub-roots

`packages/` holds the workspace. Four top-level directories are
standalone roots, plus `performance/mem-bench/` nested inside one of
them. Each has its own `package.json` + `pnpm-workspace.yaml` (empty
`packages:` list, so pnpm treats them as isolated), a README, and a
`typecheck` script over the same `tsconfig.json` template:

| Directory          | What it is                                                  | Bootstrap                                        | In CI               |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------ | ------------------- |
| `conformance/`     | Upstream JSON Schema Test Suite + OpenAPI case harness      | `cd conformance && pnpm install && pnpm corpora` | all of it, on PRs   |
| `performance/`     | Compile / validate benchmarks against other validators      | `cd performance && pnpm install`                 | no                  |
| `framework-tests/` | Real-server integration tests for the three adapters (#295) | `cd framework-tests && pnpm install`             | typecheck + tests   |
| `detection/`       | Labelled corpus: which OpenAPI defects each tool catches    | `cd detection && pnpm install && pnpm detect`    | no (see its README) |

`pnpm corpora` is the bootstrap step that is easy to miss: the upstream
corpora are gitignored and pinned in `corpora.json`, and every runner
that compares against a committed baseline calls `assertPinned` and
refuses to report numbers from a drifted checkout.

`performance/mem-bench/` is a fifth root nested inside `performance/`,
and needs its own `pnpm install` before `pnpm bench:mem` will start. It
holds two Express servers (oav and express-openapi-validator) that exist
to be measured rather than run; see its README. Its sources are `.mjs`,
so its `typecheck` runs `checkJs` over the two servers instead of the
usual `*.ts` include.

Every one of them answers to `pnpm check`, which runs what CI gates for
that directory, so the verb means the same kind of thing in each root and
at the top level. `detection/`'s is typecheck only, because `pnpm detect`
rewrites three committed files under `results/` and a command called
`check` should not dirty the tree. `mem-bench`'s is typecheck only too,
because its servers exist to be measured and a benchmark is not a gate. `performance/`'s runs the smallest
cross-library benchmark and still takes ~30s, because tinybench warms up
every task against ajv's ~2.7ms compile and warmup dominates any budget.

CI invokes these through their own package scripts (`pnpm openapi`,
`pnpm suite --check-baseline`, …) rather than `pnpm tsx run-<x>.ts`, so
the commands in the docs and the commands in the gate are the same
commands. Keep it that way when adding a runner: add the script, reference
the script, and fold it into that root's `check`.

`check` is deliberately not what CI _invokes_, though: CI keeps one step
per runner so a failure names itself in the UI. For `conformance/` the two
sets are now identical, so a new runner has to be added in both places.

Scheduled jobs cover what the pin cannot. Every conformance runner gates
PRs against the pinned corpus, cached so the required check never needs the
network. `nightly-upstream` then re-runs the suites against upstream HEAD
with `--floating`, which classifies extra failures as ours or upstream's by
whether the unit gained cases (`conformance/floating.ts`); and
`corpus-freshness` reports pins that are behind, plus (via
`pnpm metaschema:stale`) a vendored metaschema whose dated URL now
serves different bytes.

None of the three blocks a PR, and a red scheduled workflow notifies almost
nobody, so `nightly-report` opens or updates one issue labelled
`nightly-upstream` and closes it when that job recovers. Only
`nightly-upstream` gates the issue: a pin being behind is the expected
state much of the time, so the freshness result is reported in the issue
body rather than holding it open. That is the "something goes red" for
the larger checks.

`conformance/bowtie/` is a fifth dev-only tree and is deliberately
absent from that table: it is not a pnpm root. Its toolchain is Docker
plus the `bowtie` CLI (`uv tool install bowtie-json-schema`), so it has
no `package.json`, no lockfile, and therefore nothing for the
dependabot rule below to declare. Its one build input is esbuild,
pinned in its `Dockerfile`. See its README.

Their external dev-dependencies (benchmark runners, competing
validators and linters, framework runtimes, `tsx`) are deliberately
absent from the main workspace install. Adapter-package unit tests
still live in `packages/*` and run on a root `pnpm test`.

Adding a root means adding a `.github/dependabot.yml` entry for it.
Advisory scanning reads every lockfile in the repo, but dependabot only
opens PRs for directories declared there, so an undeclared root gets
alerts it can never fix on its own. `detection/` sat that way until
#629.

The root `.npmrc` sets `auto-install-peers=false` so the adapter
packages' peer-dep declarations (`express`, `fastify`) do not silently
pull the framework runtimes into the main workspace lockfile. `fastify`
is the one exception still installed in the main workspace:
`packages/oav-fastify/src/*.ts` imports `import type { FastifyRequest } from "fastify"`
and there is no `@types/fastify` on DefinitelyTyped, so the package
itself has to be present for tsc to resolve the type.

Each sub-root (`conformance/`, `framework-tests/`, `performance/`,
`performance/mem-bench/`) also ships its own `.npmrc` pinning
`auto-install-peers=true`. CI reads the sub-root `.npmrc` (it stops at
the sub-root's `pnpm-workspace.yaml` boundary), while dependabot's
lockfile refresh walks up to the root; the explicit per-root file keeps
them agreeing, otherwise dependabot writes `autoInstallPeers: false`
lockfiles and CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

## Before you edit the compiler

Procedures for adding a keyword, a string format, or an output format
are in [docs/extending.md](./docs/extending.md); the
`KeywordCompileContext` field reference is the TSDoc on the type
(`packages/schema/src/keywords/types.ts`), per "Type as canonical
contract". Three rules that fail silently when you get them wrong:

- **Keyword flags drive specialization.** `applicator`, `annotation`,
  and `evaluates` on a `KeywordDefinition` change codegen paths; a wrong
  flag mis-fires correctness or perf with no error. See their TSDoc for
  what each breaks.
- **New error codes need a `BuiltInErrorParams` entry** in
  `packages/core/src/errors.ts`. Errors are emitted through generated
  JS source, so the compiler cannot check the `code`/`params` contract;
  drift between the emitted shape and that type is a silent bug.
- **`ctx.emitError`'s `kind` carries budget semantics.** `"leaf"` is a
  fresh error and counts against `maxErrors`; `"lift"` is an
  already-counted child being propagated and never touches the counter.
  Pick wrong and the budget silently miscounts.

One invariant sits above keyword authoring, because it constrains
anyone tempted to optimize budget behavior: **a finite `maxErrors` must
never change a valid/invalid verdict.** It caps how many errors are
reported and nothing else. Evaluated-key tracking is why the
short-circuit has special rules; see docs/extending.md "Verdict safety
under a finite budget" for the full model.

## Landmines

- **Recursion runs on the native JS call stack.** A self-`$ref` emits a
  recursive call, so an unbounded payload nested a few thousand levels
  deep throws `RangeError` (empirically ~5k frames on a default Node
  stack). The `maxDepth` option (`CompileOptions` / `ValidatorOptions`)
  bounds it and emits a `depth` error leaf (HTTP 400) instead. Unset,
  codegen is byte-identical to the un-instrumented path. See
  `compileGuardedRefCall` in `packages/schema/src/keywords/ref.ts` and
  docs/configuration.md "Guarding against deeply nested payloads".
- **`$dynamicRef` resolves against a runtime stack of schema
  resources** since #663, not a flattened anchor map. The stack pushes
  on exactly two statically-known edges (an applicator descending into
  a subschema declaring `$id`, and a ref landing in another resource),
  so the compiler wraps those entry points and unwinding is structural:
  no keyword has to know the scope exists. Binding is dynamic only for
  a plain-name reference whose static target declares the matching
  `$dynamicAnchor`, per the 2020-12 bookending rule; everything else
  compiles as `$ref`. The whole mechanism is gated on a compile unit
  using both keywords, so codegen is byte-identical when it does not.
- **`unevaluated*` tracking is compile-time gated** on a one-pass walk
  of the root schema and registered external schemas, so it is free when
  unused and not free when used. See `CompileState.unevaluatedTracking`
  and `schemaUsesUnevaluated` in
  `packages/schema/src/compiler/compiler.ts`.

Output modes are user-facing: the zero-config default is `output:
"flat"` + `maxErrors: 1` (Ajv parity), `output` is `"flat" | "tree" |
"predicate"`, and the boolean aliases were removed in v5 (#497). See
[docs/configuration.md](./docs/configuration.md) and the
[v5](./docs/migration-v5.md) and [v6](./docs/migration-v6.md)
migration guides.

## Version support

User-facing version support is in the
[README `## Versions`](./README.md#versions); dialect internals (what
differs in 3.0, dispatch, per-version test layout) are in
[docs/dialects.md](./docs/dialects.md). Dispatch is a single
`dialectFor(version)` at construction, so added versions cost nothing
per request.
