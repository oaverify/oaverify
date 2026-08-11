# oaverify vs other JavaScript OpenAPI validators

Ajv is the canonical JSON Schema validator for JavaScript, and
`express-openapi-validator` is the most widely-used middleware built on
top of it. Together they cover a large share of OpenAPI request /
response validation in JavaScript services and have done so for years.
The map below places the rest.

oaverify covers both halves, split across two verbs: `oaverify check`
asks what is wrong with a document, `oaverify validate` asks whether a
payload conforms. Most of this document compares against Ajv and
`express-openapi-validator`, the closest comparison for the traffic
half; [Defect detection](#defect-detection) covers the document half,
where the comparison is against linters instead.

## Ecosystem map

| Tool family                                    | Best fit                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Ajv                                            | JSON Schema validation, many drafts, maximum ecosystem maturity                  |
| `express-openapi-validator`                    | Existing Express apps that want one middleware to validate requests/responses    |
| `openapi-backend`                              | OperationId routing, auth handlers, validation, and mocking together             |
| `openapi-enforcer` / middleware                | OpenAPI 2.0 / 3.0 services that want validation plus serialization/mocking       |
| `openapi-request-validator` / response sibling | Lower-level request or response checks around your own routing                   |
| Spec validators/parsers                        | Validating the OpenAPI document, resolving refs, or tooling                      |
| Spectral / Redocly                             | Linting an OpenAPI document for style and structure, with large default rulesets |
| oaverify                                       | HTTP-aware validation, spec checking, streamability budgets, overlays, AOT emit  |

This document is about behavior and capabilities. For raw numbers
and methodology see [`performance/README.md`](../performance/README.md);
the host-stamped per-shape numbers are below.

## Performance

- **Host:** AWS c7i.large, Intel Xeon Platinum 8488C (Sapphire Rapids),
  x86_64, 2 vCPU, Linux
- **Runtime:** Node v22.23.2, Ajv 8.20.0
- **Method:** synthetic shape suite, 1000 ms/task, 500 ms cooldown,
  median of 3 runs; commit `2cd9140`, 2026-08-07

The harness measures five configurations: Ajv fast-fail
(`allErrors: false`), Ajv full-collect (`allErrors: true`), oaverify fast-fail
(flat, `maxErrors: 1`, the zero-config default), oaverify full-collect
(`maxErrors: Infinity`), and oaverify predicate (`output: "predicate"`).
Validate is compared against the matched Ajv mode: oaverify fast-fail vs Ajv
fast-fail, oaverify full-collect vs Ajv full-collect, oaverify predicate vs Ajv
fast-fail.

### Compile

oaverify's clearest, most consistent win. Ajv's compile is near-constant
per-schema overhead; oaverify scales with shape and runs an order of
magnitude or two faster. This matters wherever validator construction
is in the hot path (per-request, per-tenant, per-test, edge cold-start,
AOT module emit).

| shape               | Ajv     | oaverify | speedup |
| ------------------- | ------- | -------- | ------- |
| `tiny`              | 7.89 ms | 39.6 µs  | 199×    |
| `petstore`          | 6.66 ms | 180.8 µs | 37×     |
| `tree`              | 6.63 ms | 132.4 µs | 50×     |
| `composition`       | 6.97 ms | 429.5 µs | 16×     |
| `array-heavy`       | 6.46 ms | 141.6 µs | 46×     |
| `unique-primitives` | 6.04 ms | 55.2 µs  | 109×    |
| `long-string`       | 6.03 ms | 98.1 µs  | 61×     |

### Validate

Each cell is oaverify's throughput as a percent of the matched Ajv mode:
`100%` is parity, above is oaverify faster, below is Ajv faster. On typical
request bodies the absolute per-call gaps are tens of nanoseconds, so
these percentages move real numbers only at extreme validation volume.

Because each column is normalized to a different Ajv baseline, cells
compare down a column, not across. A fast-fail cell below a
full-collect cell does not mean full-collect outruns fast-fail; on
single-error rejects the two modes do near-identical absolute work,
and fast-fail pulls ahead as the error count grows.

Valid input:

| shape               | oaverify fast-fail | oaverify full-collect | oaverify predicate |
| ------------------- | ------------------ | --------------------- | ------------------ |
| `tiny`              | 138%               | 141%                  | 136%               |
| `petstore`          | 89%                | 97%                   | 109%               |
| `tree`              | 100%               | 92%                   | 124%               |
| `composition`       | 137%               | 157%                  | 171%               |
| `array-heavy`       | 118%               | 115%                  | 210%               |
| `unique-primitives` | 172%               | 174%                  | 174%               |
| `long-string`       | >1000×†            | >1000×†               | >1000×†            |

Invalid input (averaged across failure-position fixtures):

| shape               | oaverify fast-fail | oaverify full-collect | oaverify predicate |
| ------------------- | ------------------ | --------------------- | ------------------ |
| `tiny`              | 84%                | 102%                  | 122%               |
| `petstore`          | 94%                | 95%                   | 142%               |
| `tree`              | 89%                | 108%                  | 183%               |
| `composition`       | 111%               | 79%                   | 214%               |
| `array-heavy`       | 109%               | 77%                   | 208%               |
| `unique-primitives` | 330%               | 315%                  | 330%               |
| `long-string`       | 42%                | 85%                   | >1000×†            |

The trade-off: oaverify fast-fail trails Ajv fast-fail modestly on plain
object rejection (`tiny`/`petstore`/`tree` at 84–94%), leads on
`composition` and `array-heavy`, and leads clearly on `uniqueItems`.
oaverify full-collect stays close to Ajv full-collect: ahead on most
accept-path shapes, mixed on rejection (trailing on `composition` and
`array-heavy`, where collecting every error costs more). oaverify predicate
mode, which skips error materialisation, is at or above parity
everywhere.

† `long-string` is a pathological shape. On the accept path oaverify is
several thousand times faster than Ajv (capped here to `>1000×`),
because Ajv's handling of very long length-bounded strings is expensive
on this input while oaverify short-circuits. The reject path is noisier
and swings the other way for fast-fail (oaverify at 42%), while
predicate mode, which allocates no error at all, is faster still than
the accept path and is capped the same way. Read this row as a
shape-specific signal, not a typical result.

### Memory

Steady-state HTTP-server footprint over 50,000 requests, oaverify vs
`express-openapi-validator` (which wraps Ajv), both Express 4 against the
same 40-schema spec and identical traffic:

| metric                          | oaverify | eov + Ajv |
| ------------------------------- | -------- | --------- |
| Baseline RSS                    | 77.1 MB  | 71.4 MB   |
| Steady-state RSS (avg)          | 102.3 MB | 103.9 MB  |
| Steady-state heap used (avg)    | 13.2 MB  | 14.6 MB   |
| Post-idle RSS                   | 102.0 MB | 104.7 MB  |
| Throughput (ms / 500-req batch) | 871 ms   | 909 ms    |

The steady-state footprints track each other closely; oaverify carries a
little less heap and turns the same workload over a few percent faster.
Neither footprint is large; the gap is unlikely to decide a deployment.
(Batch times are not comparable across runs of this table: the driver
is bound by Node's fetch client, which shifts between Node versions.)

Full methodology, the synthetic shape definitions, the `--spec` mode for
real-world OpenAPI documents, and the raw host-stamped JSON live in
[`performance/README.md`](../performance/README.md).

## Defect detection

The performance tables above measure the traffic half. This measures the
document half: given a spec with one seeded defect, which tools report
_that_ defect. Each case is a minimal document; a tool scores only when
its output matches the case's declared signal, and every scored cell is
traceable to the finding that scored it in
[`detection/results/audit.md`](../detection/results/audit.md).

Ajv 8.20, Spectral CLI 6.15, Redocly CLI 2.4, default rulesets:

| class                       | oaverify | ajv | spectral | redocly |
| --------------------------- | -------- | --- | -------- | ------- |
| malformed (6)               | 6/6      | 4/6 | 5/6      | 5/6     |
| lint (7)                    | 7/7      | 5/7 | 2/7      | 4/7     |
| structural (8)              | 7/8      | 2/8 | 7/8      | 5/8     |
| style (6)                   | 3/6      | 0/6 | 6/6      | 6/6     |
| control false positives (4) | 0        | 0   | 0        | 0       |
| total findings raised       | 25       | 19  | 170      | 182     |

Read the rows, not a total. `style` is where oaverify loses and is meant
to: operationId conventions and undefined security schemes are outside
what it claims to check, and the class exists so the corpus can show
that. `control` holds four clean documents where any finding is a false
positive; every tool scores 0, which is the result you want from a
control.

The last row is the one worth dwelling on. Across 27 seeded-defect cases
plus 4 controls, oaverify raises 25 findings and catches 23 of the 27
defects; Spectral raises 170 findings to catch 20, Redocly 182 to catch 20. Linters with broad default rulesets
report a great deal that nobody seeded, which is reasonable behavior for
a linter and a different job from answering "will this spec validate
traffic the way its author intended".

Caveats, because this table is easy to over-read:

- **Not a ranking, and the tools are not interchangeable.** Spectral and
  Redocly are document linters. Ajv does not lint specs at all, so the
  comparable operation is compiling each schema the document carries with
  `strict` and `strictRequired` on. That is the only reason Ajv appears
  in a spec-linting table.
- **Not a CI gate.** A matrix that turns red when Spectral ships a rule
  is noise, so it is run on demand rather than per-commit. The numbers
  move with the tool versions above.
- **A miss can be a wording mismatch** rather than a real blind spot,
  where a tool reports the defect without the signal the case declares.

Methodology, the case format, and the reasoning behind each class live in
[`detection/README.md`](../detection/README.md).

## Where Ajv (+ express-openapi-validator) does more

Capabilities that the Ajv stack covers and oaverify does not.

- **Multiple JSON Schema drafts.** Ajv supports draft-04, draft-06,
  draft-07, draft-2019-09, 2020-12, and JTD. oaverify compiles 2020-12 and
  OpenAPI 3.0's constrained dialect only; earlier drafts and JTD are
  not supported.
- **Data-mutating options.** `coerceTypes`, `removeAdditional`, and
  `useDefaults` let Ajv mutate the validated value in place: coercing
  strings to numbers, stripping undeclared properties, filling missing
  properties from `default`. oaverify treats validation as a yes/no
  question and does not mutate inputs.
- **Schema-level AOT (programmatic surface).** Ajv's `standaloneCode`
  is a library API that takes a map of named schemas and emits one
  module with interlinked validators: cross-schema `$ref`s resolve
  at emit time, CommonJS or ESM output. `oaverify compile-schema` is
  CLI-only and single-schema: multi-schema projects need to run it
  per schema, with a preceding `oaverify resolve` step to inline any
  cross-references. For build tools scripting many emits, Ajv's API
  is more ergonomic; oaverify has no batched programmatic equivalent.
- **Named schema registry.** `addSchema` / `getSchema` / `removeSchema`
  give Ajv a name-to-validator map that cross-schema `$ref`s resolve
  through. oaverify accepts an `external: Map<string, Schema>` on
  `compileSchema`; fine for one-shot compiles, less ergonomic for apps
  that build up a schema collection incrementally.
- **Full RFC 3986 URI resolution.** Ajv handles absolute-URI `$ref`s
  and `$id` base-URI rewrites natively. oaverify requires external /
  multi-file refs to be pre-inlined by `@oaverify/core/spec`'s `resolveSpec()`
  before compile, and accepts fragment-only refs thereafter.
- **Single-pass meta-schema validation of a schema.** Ajv validates your
  schema against the draft's meta-schema at compile time, so one pass
  covers every keyword uniformly, including keywords Ajv itself has no
  special handling for. oaverify arrives at schema defects by several
  narrower routes instead: `schemaLint` flags unknown-keyword typos
  (`minimumx: 5`) and partially-implemented features, each keyword
  rejects values it cannot use (`minimum: "5"`, `type: "Boolean"`,
  `required: "id"` all throw, the last two with a suggested correction), a
  pre-pass rejects non-schema values in schema-valued slots
  (`items: [ ... ]`, `if: null`), and `oaverify check`'s `conformance`
  class validates the whole document against the pinned OpenAPI
  meta-schema.

  What Ajv buys here is uniformity. Its guarantee is structural: every
  keyword is checked because the meta-schema describes them all, so a
  keyword nobody has thought about is still covered. In
  oaverify a check lives on the keyword that has one, so an
  unexercised corner can accept what it is handed. On measured coverage
  oaverify comes out ahead (6/6 `malformed` and 7/7 `lint` cases against
  Ajv's 4/6 and 5/7; see [Defect detection](#defect-detection)), and Ajv's
  property is still the one you would want if you were betting on the
  case nobody has written a test for.

- **`$data` references.** Ajv's non-standard extension where one
  keyword's value comes from the data being validated
  (`{ minimum: { $data: "1/min" } }`). oaverify doesn't implement it. The
  common use case (cross-field constraints like `max >= min`)
  works in oaverify via an object-level custom keyword that sees the
  whole object and reaches siblings directly; see
  [`examples/cross-field-validation.ts`](../examples/cross-field-validation.ts).
  Trade-off: the constraint sits on the parent object in the schema
  rather than inside the constrained field's own subschema.
- **Async validation.** Ajv supports async formats and keywords (e.g.
  a format that hits a database). oaverify's formats and custom keywords
  are synchronous.
- **`express-openapi-validator` conveniences.** `req.body` /
  `req.query` type coercion by mutation, `fileUploader` (multer
  integration), `securityHandlers` (credential-verifying dispatch;
  oaverify's security check is shape-only and verifies no credential),
  and `operationHandlers` filesystem auto-loading are one-liner
  options with no oaverify equivalent. See
  [`integration.md`](./integration.md) for the recipes that replace
  them.

## Where oaverify does more

Capabilities oaverify has that Ajv (alone or with
`express-openapi-validator`) doesn't.

- **Spec checking as a first-class verb.** `oaverify check <spec>` answers
  "what is wrong with this document" across five classes: `conformance`
  (is it a legal OpenAPI document for its version, against the pinned
  meta-schema), `schema` (will the schemas compile, and do they lint
  clean), `hygiene` (unused components, path-template placeholders with no
  matching parameter declaration), `examples` (does every `example` and
  `examples` entry satisfy the schema it illustrates), and `redos` (can a
  `pattern` be made to backtrack). Findings carry a class and a severity
  as separate fields, because they cut across each other: `hygiene` holds
  both a specification violation and pure housekeeping. `--findings` selects
  what is reported, `--fail-on warning|error|fatal` is the CI gate. Ajv validates
  schemas, not documents, and `express-openapi-validator` reports document
  problems only as a side effect of failing to build. See
  [`strictness.md`](./strictness.md) for the class model and
  [Defect detection](#defect-detection) for measured coverage.
- **ReDoS detection on spec patterns.** The `redos` class reports a
  `pattern` whose ambiguity is _proven_ rather than heuristically
  suspected, and echoes a witness input that the pattern matches more than
  one way, so the finding carries its own evidence. Separately,
  `createValidator` accepts a `regexCompiler` so you can route every
  pattern in the spec through `re2` or another complexity-bounded engine
  at runtime. Neither Ajv nor `express-openapi-validator` inspects
  patterns for catastrophic backtracking.
- **Bounded recursion depth.** Recursive schemas validate on the native JS
  call stack in both oaverify and Ajv, so a deeply nested payload can
  exhaust it (empirically around 5k frames on a default Node stack).
  oaverify's `maxDepth` (`CompileOptions` / `ValidatorOptions`) instruments
  only `$ref` back-edges and emits a `depth` error leaf, turning a
  `RangeError` crash into a 400. Unset, codegen is byte-identical to the
  un-instrumented path, so the guard costs nothing when unused. Ajv has no
  equivalent option.
- **Streaming body validation.** The separate
  `@oaverify/stream` package validates a JSON body
  against its operation schema as it streams, echoing the input bytes
  through to a sink and reporting violations on a side channel. Memory
  stays bounded for schemas with structural bounds (or configured
  caps), so a multi-GB body validates without materializing in heap. A
  second, push-based engine that reuses oaverify's keyword set and flat error
  model. Ajv and `express-openapi-validator` validate a fully-parsed
  value; there is no streaming path.
- **Design-time buffer budgets.** `analyzeSpec(document)` reports, per
  operation, which request and response bodies can stream, which must
  buffer, and how large a buffer can get (in wire bytes, or
  `"unbounded"` where the schema has no structural cap), without reading
  a byte of traffic. It runs the same classifier the streaming engine
  uses, so the budget matches runtime behavior. The CLI surfaces it as
  `oaverify stream-check <spec>`, with `--fail-on-unbounded` as a CI gate.
  An Ajv + middleware stack can validate the parsed body, but a buffer
  budget needs the resolved (and overlaid) operation schema and the
  streaming classifier in one place; in a split stack no one layer
  normally holds that whole view.
- **HTTP-aware validation.** Route matching, content-type negotiation,
  parameter `style` / `explode` deserialisation, response status
  matching (exact, then NXX class, then default) are part of one
  `validateRequest` / `validateResponse` call. Ajv is a JSON Schema
  validator; wiring the HTTP layer on top of it is what
  `express-openapi-validator` does, and only for Express.
- **AOT-compiled HTTP validator.** `oaverify compile-spec <openapi.yaml>`
  emits a single ES module exposing the full `validateRequest` /
  `validateResponse` / `getOperation` surface with every operation's
  schemas pre-compiled. Runs on Cloudflare Workers, Vercel Edge,
  Lambda@Edge, Deno Deploy, or as a drop-in `.mjs`. The ajv +
  `express-openapi-validator` stack has no equivalent at this layer:
  ajv's `standaloneCode` covers the schema layer, and reassembling the
  HTTP layer on top of it (router, content-type dispatch, parameter
  deserialisation, response-status matching, security-shape checks)
  is reimplementing `express-openapi-validator` from scratch. Ajv's
  runtime `.compile()` also doesn't run on edge runtimes: it uses
  `new Function()`, which the Workers / Edge sandbox forbids.
  compile-spec skips runtime compile, so the output runs on those
  sandboxes directly. Bundle-size tradeoff: fits
  Cloudflare Workers' 10 MB limit through Stripe-scale specs
  (~2–3 MB output); fits Lambda@Edge's 1 MB viewer-function limit for
  low-hundreds of ops. Custom formats and custom keywords aren't
  serialised; compile dynamically with `createValidator` if you need
  them.
- **Built-in OpenAPI 3.0 dialect.** `nullable`, boolean
  `exclusiveMaximum` / `exclusiveMinimum`, and
  `$ref`-suppresses-siblings are keyword definitions in the 3.0
  vocabulary stack, selected once at `createValidator` time. eov
  reaches the same semantics by a different route: switching to
  `ajv-draft-04` (draft-04 handles boolean `exclusiveMaximum` and
  `$ref`-suppresses-siblings natively) and preprocessing `nullable`
  out of the schema before compile (rewriting `{ nullable: true,
type: "string" }` to `{ type: ["string", "number", "boolean",
"object", "array"] }` with an `x-eov-type` side channel to narrow
  back). Different mechanism, equivalent behavior.
- **First-class overlays.** `applyOverlays` rewrites an
  externally-owned base spec at load time (add a required header to
  every operation, extend a component schema, swap a response shape)
  without forking or preprocessing the upstream file.
- **Opt-in structured error tree.** Like Ajv, the default output is a
  flat errors array. Pass `output: "tree"` and errors instead preserve
  the applicator structure (`oneOf` with per-branch `children`, `allOf`
  with failed-conjunct children), so HTTP consumers can inspect which
  branch of a composition failed without parsing message strings. Ajv
  has no equivalent nested shape. Either way, leaves carry their HTTP
  location in the path (`body.items[3].name`, `query.limit`).
- **Predicate mode.** `compileSchema(schema, { output: "predicate" })`
  returns `{ validate: (x) => boolean }`. No error tree construction,
  no path snapshotting, no accumulator allocation. Ajv's
  `allErrors: false` still maintains error infrastructure; oaverify's
  predicate mode compiles to a different function entirely.
- **Explicit error budget.** `maxErrors: N` caps the errors collected
  and short-circuits hot loops when the budget is exhausted. The default
  is `1` (fast-fail); Ajv has
  `allErrors: true | false` but no explicit count budget. Pass
  `Number.POSITIVE_INFINITY` for zero-overhead uncapped collection
  (codegen emits plain `errors.push` with no budget checks).
- **Direction-aware body transforms.** Request-body validators reject
  `readOnly` properties and exempt them from `required`; response-body
  validators do the same for `writeOnly`. Applied as a pre-compile
  transform so the compiler itself is direction-agnostic.
- **Discriminator.** First-class OpenAPI discriminator support: a
  single-dispatch alternative to `oneOf` whose error message names the
  offending property and value rather than listing per-branch
  failures. eov supports discriminator by preprocessing the schema
  (walking `oneOf` / `anyOf` at load time and rewriting the branches
  into a form ajv can validate). Functionally equivalent, different
  implementation shape.
- **Compile-time observability.** `CompiledSchema.stats` exposes
  `functionCount`, `unevaluatedTrackingEmitted`, and
  `emittedTreeRuntime` so tests can assert on compiler optimizations
  directly rather than grepping the generated source.

## Runtime dependencies

Ajv 8 has four runtime dependencies:

| Dependency             | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `fast-deep-equal`      | Structural equality for `const` / `enum` / `uniqueItems`        |
| `json-schema-traverse` | Walk schema subtrees                                            |
| `fast-uri`             | RFC 3986 URI parsing for `$id` / `$ref` resolution              |
| `require-from-string`  | Load compiled-validator source as a module (standalone codegen) |

oaverify's compiler and validator have zero runtime dependencies:
`@oaverify/core` carries none and parses JSON only. A parser is a
separate install (`@oaverify/syntax` for YAML), as is the CLI
(`oaverify`). The two efficiency libraries Ajv pulls in
(`fast-deep-equal`, `json-schema-traverse`) have equivalents in-tree;
the two capability libraries (`fast-uri`, `require-from-string`) map to
features oaverify doesn't implement (see "Where Ajv does more" above).

## Summary

The JavaScript ecosystem has several OpenAPI validation tools with
different integration shapes. Pick the one whose shape fits how your
service is already wired.

Pick Ajv + `express-openapi-validator` when you want multi-draft
support, a large userbase, data-mutating validation (`coerceTypes`,
`removeAdditional`, `useDefaults`), the one-line middleware
integration for Express, or the edge Ajv still holds on fast-fail
rejection of plain object shapes (see the Performance tables above).
Pick `openapi-backend` when routing and
operation handlers should be driven by the spec. Pick
`openapi-enforcer` when its OpenAPI 2.0 / 3.0 validation,
serialization, and mocking model fits your service.

Pick Spectral or Redocly when you want broad style and convention linting
of the document with a large ruleset out of the box.

Pick oaverify when you want a structured error tree, streaming validation of
large bodies with a design-time buffer budget you can check before
deploy, overlays over specs you don't own, an OpenAPI 3.0 dialect built
into the validator, explicit control over where validation runs in your
HTTP stack, or standalone OpenAPI HTTP validator output for
edge/serverless deployments. It also fits compile-heavy workloads: the
benchmarks show one to two orders of magnitude faster schema compile
than Ajv; see the Performance section above.

For the document rather than the traffic, pick oaverify when the question
is whether a spec will validate the way its author intended: `oaverify
check` gates on document conformance, schema compilation, hygiene,
examples that contradict their schema, and provably ambiguous patterns,
with a class-and-severity model built for CI rather than a style ruleset.
Reach for a linter alongside it when you also want naming and convention
rules.

For benchmark numbers rather than feature comparisons, see
[`performance/README.md`](../performance/README.md).
