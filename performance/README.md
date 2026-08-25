# @oaverify-dev/performance

Cross-library benchmarks for `@oaverify/internal-schema` against
[ajv](https://github.com/ajv-validator/ajv) on the 2020-12 dialect, plus
steady-state memory against
[express-openapi-validator](https://github.com/cdimascio/express-openapi-validator)
in a real HTTP server. Compile, validate and footprint, on synthetic shapes
and on real specs.

## What it needs

- **Its own `pnpm install`.** A separate pnpm root; these deps are not in
  the main workspace install.
- **ajv**, [tinybench](https://github.com/tinylibs/tinybench) and
  [`@apidevtools/json-schema-ref-parser`](https://github.com/APIDevTools/json-schema-ref-parser),
  installed here.
- **A prior root `pnpm build`** for `bench-real-world.mjs` and `bench:mem`,
  which drive built artifacts rather than source.
- **A second `pnpm install` in [`mem-bench/`](./mem-bench)** for
  `bench:mem`, which spawns two servers from that nested root. Without it
  the driver fails with `server ... exited early (1)`.
- **`--expose-gc`** for `bench:anatomy`; its script passes the flag.

## Run

```bash
cd performance
pnpm install
cd mem-bench && pnpm install && cd ..    # only for bench:mem

pnpm check                               # typecheck + smallest cross-library run
pnpm bench                               # cross-library, default 500ms per task
pnpm bench:long                          # 1500ms per task
pnpm bench:render                        # render the newest results file as markdown
pnpm bench:http                          # HTTP request/response hot paths
pnpm bench:mem                           # memory vs express-openapi-validator
pnpm bench:large                         # large-payload behaviour
pnpm bench:stream                        # streaming validator throughput
pnpm bench:dynamic                       # $dynamicRef cost
pnpm bench:endpoint                      # per-endpoint validation
pnpm bench:anatomy                       # error-tree allocation anatomy
pnpm typecheck
```

`pnpm check` takes ~30s for a single schema at the minimum budget. That is
not the budget's fault: tinybench warms up every task and ajv's compile is
milliseconds per operation, so warmup dominates whatever budget you set.
The figure is host-dependent: ~2.7ms on an M3 Ultra, ~9ms on the
c7i.large that [docs/comparison.md](../docs/comparison.md) is stamped to.

## What it gates

Nothing. No benchmark is wired into CI, and `results/` is gitignored,
because timings depend on the host and committing them across contributors
would be misleading. Compare runs locally, or check out an older commit and
re-run.

That also means nothing here can fail a build, so a regression only shows up
if somebody looks. The `meta` block in every results file records host CPU,
arch, Node and ajv versions, git commit, time-per-task and cooldown, so a
number can always be traced back to the machine that produced it.

## Reading the results

### Synthetic mode

```
=== petstore: object with required + scalar properties; realistic small API payload ===
compile:
  ajv compile                  162 ops/s       6.29ms / op
  ajv-reused compile          2.1K ops/s     490.21µs / op
  oav compile                 5.7K ops/s     188.01µs / op
validate:
  ajv validate (valid)               8.79M ops/s     117.39ns / op
  ...
```

Per-library line per task. `ops/s` is tinybench's measured throughput,
`/ op` is mean latency per call. Bigger ops/s is faster. The relative table
at the end normalizes against ajv as baseline. For publishable markdown
tables, run `pnpm bench:render` against the JSON rather than reading this
console output.

### Spec mode

```
=== Real-world spec: path/to/openapi.yaml ===
277 unique request/response body schemas.
compile (per library, aggregated across every schema):
  ajv         total  3858.40ms   mean    13.93ms   p95    41.17ms   max    54.78ms
  oav         total    336.77ms   mean     1.22ms   p95     3.86ms   max     5.92ms
```

- `total` is wall-clock time to compile every body schema in the spec.
- `mean`, `p95`, `max` describe the per-schema distribution.
- Schemas that fail to compile are counted separately and a sample of their
  error messages is printed below the table. A library that rejects an OAS
  3.0-specific keyword like `nullable` shows up here; that is a real
  property of the library, not a benchmark artifact.

### Memory mode (`mem.ts`)

The block below shows the shape of the output, not a result. Its numbers
came from one run on one machine and disagree with the host-stamped table
in [docs/comparison.md](../docs/comparison.md) on which library holds
less at baseline, which is what a 10-15 MB RSS spread does to a ~6 MB
difference. Read the committed comparison for findings, and this for
what the columns mean.

```
=== Steady-state memory: 100 × 500 = 50000 reqs ===

metric                                 oav       eov+ajv   Δ (eov-oav)
------------------------------------------------------------------------
baseline  RSS                       77.0MB       108.9MB        31.9MB  (-29%)
baseline  heapUsed                   8.8MB        12.1MB         3.3MB
steady    RSS (avg last 5)          98.3MB       117.1MB        18.8MB  (-16%)
steady    heapUsed (avg)            11.9MB        14.6MB         2.7MB
growth    RSS                       14.9MB         5.5MB        -9.4MB
growth    heapUsed                   0.5MB         0.3MB        -0.2MB

batch throughput (avg ms per 500-req batch): oav 75ms, eov 80ms
```

What to look at:

- **`baseline RSS`**: the library plus validator-set footprint at rest,
  right after `app.listen`. Stable across runs on one host. The current
  reference numbers are in
  [docs/comparison.md](../docs/comparison.md#memory).
- **`steady heapUsed`**: V8 heap after 50k requests with GC forced before
  each sample. The cleaner signal for retention.
- **`growth` rows**: delta from post-warmup to end-of-run. Both libraries
  plateau; if either grows without bound the value here diverges and the
  steady rows keep rising across runs.
- **`steady RSS`** is noisier than heapUsed: V8 expands the heap in chunks,
  and when a chunk boundary falls mid-run the final RSS differs by 10-15 MB
  between runs even though the working set is stable. RSS is what the OS
  accountancy shows and includes V8's uncommitted-but-reserved pages.
- **Status-code distribution** is printed above the table; both servers
  should agree on every batch. A mismatch means the validators diverge on
  some request shape and the comparison is invalid.

Raw per-batch data lands in `results/mem-<timestamp>.json`.

### Results file

Each `run.ts` invocation writes `./results/<iso-timestamp>.json`: a
`meta` block stamping the host and configuration (timestamp, commit,
Node and ajv versions, platform / CPU, per-task timing, mode), which
is what makes a committed number traceable, and a `results` array of
`{ schema, metric, lib, validity?, hz, mean, variant? }` rows. The
full shapes are `RunOutput` / `Result` in [`run.ts`](./run.ts).

## Which entry point when

| You want to know...                                                    | Use                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Is oav competitive with ajv on shape X?                                | `run.ts` (synthetic, pick the matching schema in `schemas.ts` or add one) |
| How does library choice scale across a real spec's schemas?            | `run.ts --spec=<path>`                                                    |
| Does this real spec load cleanly through oav's pipeline?               | `bench-real-world.mjs`                                                    |
| How long does oav take from spec-on-disk to "first validated request"? | `bench-real-world.mjs`                                                    |
| Did HTTP validator request/response orchestration get faster?          | `bench-http-validator.ts`                                                 |
| What's the steady-state memory cost of each library in an HTTP server? | `mem.ts`                                                                  |

## Entry points

### `run.ts`: cross-library schema benchmark

```bash
pnpm bench -- --filter=petstore                 # one schema only
pnpm bench -- --time=250                        # quick smoke
pnpm bench -- --cooldown=500                    # fallow sleep after each task
pnpm bench -- --spec=path/to/openapi.yaml       # real spec mode
pnpm bench:render results/<timestamp>.json      # a specific run
```

`render.ts` emits three tables, one concern each: **compile** (both ajv
modes against oav), **validate / valid input**, and **validate / invalid
input**, each across the five configs. `--cooldown` adds a fallow sleep after every task;
set it for publishable runs to limit thermal and GC cross-talk between
tasks.

Two modes, one script:

- **Default (synthetic).** Iterates the schemas in `./schemas.ts`, a curated
  shape distribution (trivial scalar, flat object, recursive `$ref`,
  `oneOf`+`allOf` composition, large array of small objects, `uniqueItems`
  array, and an object with large length-bounded strings). Measures both
  `compile` and `validate`; validate has separate valid and invalid tasks so
  neither library wins by short-circuiting.

- **`--spec=<path>` (real-world).** Loads the given OpenAPI entry via
  `@apidevtools/json-schema-ref-parser`, to keep the input identical across
  both libraries, extracts every unique request- and response-body schema,
  and times each library's compile across the whole set with plain
  `performance.now()`. Validate is skipped in this mode: real-world schemas
  do not come with paired valid/invalid fixtures, and any synthetic input
  would favour one library's fast path. For validate throughput on real
  shapes, copy the body schema into `schemas.ts` with hand-authored inputs
  and run the synthetic mode.

### `bench-real-world.mjs`: oav end-to-end on one spec

```bash
pnpm build                                      # dist/ needs to exist
node performance/bench-real-world.mjs <spec> [...more]
```

Not a library comparison. Runs oav's full OpenAPI pipeline on one or more
specs and reports oav `loadSpec` duration (or FAIL plus the error when it
throws), `@apidevtools/json-schema-ref-parser` duration for comparison,
`createValidator` construction, `validateRequest` cold-path median and max
across ~50 sampled ops, hot-path median after caches are warm, and heap
usage.

Use it to sanity-check that a new spec loads end-to-end, or to
regression-check `@oaverify/internal-spec` / `@oaverify/internal-validator`.

### `bench-http-validator.ts`: HTTP request/response hot paths

Runs `createValidator` once for a small OpenAPI document with multiple
declared request and response body media types, then times the hot
`validateRequest` and `validateResponse` calls. It includes valid body
matches and wrong-Content-Type failures, so changes to HTTP orchestration
and media-type negotiation have a direct benchmark.

### `mem.ts`: steady-state memory under HTTP load

Spawns the two Express 4 servers in [`mem-bench/`](./mem-bench), one
wrapping oaverify and one express-openapi-validator, and drives an
identical round-robin request mix at both, forcing GC between samples.
[Memory mode](#memory-mode-memts) above says how to read the output;
mem-bench's README covers the servers and the spec they validate.

```bash
BATCHES=20 PER_BATCH=500 WARMUP=250 pnpm bench:mem   # quick smoke
```

## Methodology

**Compile (synthetic).** Each hot-loop iteration is only the library's work.
ajv is measured twice, because the two answers differ by two orders of
magnitude and only one of them describes a long-lived service (#935):

- **ajv**: `new Ajv({allErrors, strict:false}).compile(schema)`, a fresh
  instance per iteration. A fresh `Ajv2020` compiles the 2020-12
  meta-schema before it compiles anything the caller passed, so this
  column is dominated by that and is near-constant across schema sizes.
  It is the honest number for a process that compiles one schema and
  exits. Read a flat column here as the meta-schema, not as ajv having
  constant per-schema cost.
- **ajv-reused**: one instance shared across iterations, which is what a
  service holding per-tenant or per-test validators has. ajv caches
  compiled schemas by object identity, so the schema is evicted with
  `removeSchema` after each compile; without that, every iteration after
  the first is a cache hit and measures roughly 0.1 us. Eviction was
  chosen over a clone pool (which silently becomes a cache hit once
  tinybench outruns the pool) and over cloning in the loop (0.7-2.8 us
  on these shapes, charged to ajv alone); it costs ~0.1 us and leaves
  both libraries compiling the identical object.
- **oav**: `compileSchema(schema, opts)` with pre-built `opts`. There is
  no instance to reuse and no meta-schema to compile, so one task covers
  it.

`render.ts` quotes oav's speedup against **ajv-reused**, since that is the
deployment shape the claim in the root README is about.

**Compile (spec mode).** Same per-library semantics, one iteration per
schema. Ajv runs with `logger: false` so OAS-specific format warnings do not
flood stdout.

**Validate (synthetic).** Every library pre-compiles its validator once,
outside the timed loop. The hot path is literally `validator(sample)`: no
closures, no cursor math, no per-iteration setup; each task validates one
fixed payload.

The **valid** path uses one representative sample per shape. The **invalid**
path runs one task per authored invalid fixture, because where and how badly
a payload fails dominates the number: a `uniqueItems` duplicate near the
start against the end, a first- against last-element array failure, a cheap
early reject against an expensive late one. Each fixture is its own
pure-loop task; `render.ts` reports the median across them with the min-max
range, so the published invalid number spans the failure-position spread
rather than a single cherry-picked point. The fixtures in `schemas.ts` are
deliberately authored to cover that spread (early / mid / deep / late /
many-errors).

Before any timing, a pre-flight pass validates every authored input under
all five configs and asserts the verdict matches its label, catching a
mislabeled fixture or an ajv/oav disagreement that would otherwise silently
time the wrong path.

The bench runs five validators so each comparison is apples-to-apples: `oav`
is the zero-config default (flat, `maxErrors: 1`) and pairs with `ajv-fast`
(`allErrors: false`); `oav-all` collects every error and pairs with `ajv`
(`allErrors: true`); `oav-predicate` is the boolean fast path.

## Where the numbers live

Per-shape results, with the host and commit they were measured on, are in
[docs/comparison.md](../docs/comparison.md#performance). They are not
repeated here: two places asserting the same percentages is how one of them
comes to be wrong.

## Why oav's rejection path costs more

The remaining validate overhead against ajv comes from two structural
choices rather than anything incidental:

- Schemas containing applicators (`properties` / `items` / `allOf` / ...)
  compile to a function call rather than inlining into the enclosing body.
  V8 monomorphizes hot-loop calls better than it handles massive inline
  bodies.
- On the rejection path oav still builds a structured leaf for the failing
  keyword, where ajv assembles something flatter.

`output: "predicate"` sheds that error infrastructure entirely: no leaf
allocation, no path snapshot, no params object, no message string, no
wrapper. Every failure short-circuits to `return false;`. It cannot be
combined with a finite `maxErrors`, because the two are semantically
incompatible, and the compiler throws rather than picking one.
