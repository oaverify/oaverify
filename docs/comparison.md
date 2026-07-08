# oav vs other JavaScript OpenAPI validators

Ajv is the canonical JSON Schema validator for JavaScript, and
`express-openapi-validator` is the most widely-used middleware built
on top of it. Together they cover a large share of OpenAPI request /
response validation in JavaScript services and have done so for years.

They are not the only options. `openapi-backend` combines routing,
validation, auth, and mocking around operation handlers.
`openapi-enforcer` and `openapi-enforcer-middleware` cover document
loading, request/response validation, serialization, and mocks, with a
stronger OpenAPI 2.0 / 3.0 story than 3.1+. `openapi-request-validator`
and `openapi-response-validator` are smaller request/response pieces.
Spec validators and parsers such as `@seriousme/openapi-schema-validator`
and `@scalar/openapi-parser` validate the OpenAPI document at
build/load time; they don't sit in the request path.

This document spends most of its space on Ajv and
`express-openapi-validator` because they are the closest comparison for
oav's core surface: schema validation plus HTTP-layer request/response
checks. The broader ecosystem matters, but the same decision usually
comes down to the shape of integration you want.

## Ecosystem map

| Tool family                                    | Best fit                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Ajv                                            | JSON Schema validation, many drafts, maximum ecosystem maturity                       |
| `express-openapi-validator`                    | Existing Express apps that want one middleware to validate requests/responses         |
| `openapi-backend`                              | OperationId routing, auth handlers, validation, and mocking together                  |
| `openapi-enforcer` / middleware                | OpenAPI 2.0 / 3.0 services that want validation plus serialization/mocking            |
| `openapi-request-validator` / response sibling | Lower-level request or response checks around your own routing                        |
| Spec validators/parsers                        | Validating the OpenAPI document, resolving refs, linting, or tooling                  |
| oav                                            | HTTP-aware validation, streamability budgets, overlays, and standalone validator emit |

This document is about behavior and capabilities. For raw numbers
and methodology see [`performance/README.md`](../performance/README.md);
the host-stamped per-shape numbers are below.

## Performance

- **Host:** AWS c7i.large, Intel Xeon Platinum 8488C (Sapphire Rapids),
  x86_64, 2 vCPU, Linux
- **Runtime:** Node v22.23.1, Ajv 8.20.0
- **Method:** synthetic shape suite, 1000 ms/task, 500 ms cooldown,
  median of 3 runs; commit `6270795`, 2026-07-05

The harness measures five configurations: Ajv fast-fail
(`allErrors: false`), Ajv full-collect (`allErrors: true`), oav fast-fail
(flat, `maxErrors: 1`, the zero-config default), oav full-collect
(`maxErrors: Infinity`), and oav predicate (`output: "predicate"`).
Validate is compared against the matched Ajv mode: oav fast-fail vs Ajv
fast-fail, oav full-collect vs Ajv full-collect, oav predicate vs Ajv
fast-fail.

### Compile

oav's clearest, most consistent win. Ajv's compile is near-constant
per-schema overhead; oav scales with shape and runs an order of
magnitude or two faster. This matters wherever validator construction
is in the hot path (per-request, per-tenant, per-test, edge cold-start,
AOT module emit).

| shape               | Ajv     | oav      | speedup |
| ------------------- | ------- | -------- | ------- |
| `tiny`              | 7.82 ms | 27.4 µs  | 285×    |
| `petstore`          | 6.69 ms | 132.1 µs | 51×     |
| `tree`              | 7.05 ms | 70.0 µs  | 101×    |
| `composition`       | 7.04 ms | 297.9 µs | 24×     |
| `array-heavy`       | 6.68 ms | 97.7 µs  | 68×     |
| `unique-primitives` | 6.10 ms | 41.1 µs  | 149×    |
| `long-string`       | 6.29 ms | 73.5 µs  | 86×     |

### Validate

Each cell is oav's throughput as a percent of the matched Ajv mode:
`100%` is parity, above is oav faster, below is Ajv faster. On typical
request bodies the absolute per-call gaps are tens of nanoseconds, so
these percentages move real numbers only at extreme validation volume.

Because each column is normalized to a different Ajv baseline, cells
compare down a column, not across. A fast-fail cell below a
full-collect cell does not mean full-collect outruns fast-fail; on
single-error rejects the two modes do near-identical absolute work,
and fast-fail pulls ahead as the error count grows.

Valid input:

| shape               | oav fast-fail | oav full-collect | oav predicate |
| ------------------- | ------------- | ---------------- | ------------- |
| `tiny`              | 138%          | 153%             | 136%          |
| `petstore`          | 95%           | 97%              | 110%          |
| `tree`              | 112%          | 110%             | 131%          |
| `composition`       | 181%          | 178%             | 216%          |
| `array-heavy`       | 117%          | 114%             | 209%          |
| `unique-primitives` | 174%          | 167%             | 173%          |
| `long-string`       | >1000×†       | >1000×†          | >1000×†       |

Invalid input (averaged across failure-position fixtures):

| shape               | oav fast-fail | oav full-collect | oav predicate |
| ------------------- | ------------- | ---------------- | ------------- |
| `tiny`              | 84%           | 105%             | 121%          |
| `petstore`          | 85%           | 97%              | 160%          |
| `tree`              | 87%           | 108%             | 180%          |
| `composition`       | 109%          | 74%              | 219%          |
| `array-heavy`       | 112%          | 77%              | 210%          |
| `unique-primitives` | 323%          | 309%             | 319%          |
| `long-string`       | 43%           | 87%              | >1000×†       |

The trade-off: oav fast-fail trails Ajv fast-fail modestly on plain
object rejection (`tiny`/`petstore`/`tree` at 84–87%), leads on
`composition` and `array-heavy`, and leads clearly on `uniqueItems`.
oav full-collect stays close to Ajv full-collect: ahead on most
accept-path shapes, mixed on rejection (trailing on `composition` and
`array-heavy`, where collecting every error costs more). oav predicate
mode, which skips error materialisation, is at or above parity
everywhere.

† `long-string` is a pathological shape. On the accept path oav is
roughly three to four thousand times faster than Ajv (capped here to
`>1000×`), because Ajv's handling of very long length-bounded strings is
expensive on this input while oav short-circuits. The reject path is
noisier and swings the other way for fast-fail (oav at 43%). Read this
row as a shape-specific signal, not a typical result.

### Memory

Steady-state HTTP-server footprint over 50,000 requests, oav vs
`express-openapi-validator` (which wraps Ajv), both Express 4 against the
same 40-schema spec and identical traffic:

| metric                          | oav      | eov + Ajv |
| ------------------------------- | -------- | --------- |
| Baseline RSS                    | 77.1 MB  | 85.8 MB   |
| Steady-state RSS (avg)          | 102.3 MB | 102.7 MB  |
| Steady-state heap used (avg)    | 12.6 MB  | 14.5 MB   |
| Post-idle RSS                   | 102.2 MB | 102.6 MB  |
| Throughput (ms / 500-req batch) | 894 ms   | 920 ms    |

The steady-state footprints track each other closely; oav carries a
little less heap and turns the same workload over a few percent faster.
Neither footprint is large; the gap is unlikely to decide a deployment.
(Batch times are not comparable across runs of this table: the driver
is bound by Node's fetch client, which shifts between Node versions.)

Full methodology, the synthetic shape definitions, the `--spec` mode for
real-world OpenAPI documents, and the raw host-stamped JSON live in
[`performance/README.md`](../performance/README.md).

## Where Ajv (+ express-openapi-validator) does more

Capabilities that the Ajv stack covers and oav does not.

- **Multiple JSON Schema drafts.** Ajv supports draft-04, draft-06,
  draft-07, draft-2019-09, 2020-12, and JTD. oav compiles 2020-12 and
  OpenAPI 3.0's constrained dialect only; earlier drafts and JTD are
  not supported.
- **Data-mutating options.** `coerceTypes`, `removeAdditional`, and
  `useDefaults` let Ajv mutate the validated value in place: coercing
  strings to numbers, stripping undeclared properties, filling missing
  properties from `default`. oav treats validation as a yes/no
  question and does not mutate inputs.
- **Schema-level AOT (programmatic surface).** Ajv's `standaloneCode`
  is a library API that takes a map of named schemas and emits one
  module with interlinked validators: cross-schema `$ref`s resolve
  at emit time, CommonJS or ESM output. `oav compile-schema` is
  CLI-only and single-schema: multi-schema projects need to run it
  per schema, with a preceding `oav resolve` step to inline any
  cross-references. For build tools scripting many emits, Ajv's API
  is more ergonomic; oav has no batched programmatic equivalent.
- **Named schema registry.** `addSchema` / `getSchema` / `removeSchema`
  give Ajv a name-to-validator map that cross-schema `$ref`s resolve
  through. oav accepts an `external: Map<string, Schema>` on
  `compileSchema`; fine for one-shot compiles, less ergonomic for apps
  that build up a schema collection incrementally.
- **Full RFC 3986 URI resolution.** Ajv handles absolute-URI `$ref`s
  and `$id` base-URI rewrites natively. oav requires external /
  multi-file refs to be pre-inlined by `oav/spec.resolveSpec()`
  before compile, and accepts fragment-only refs thereafter.
- **Full meta-schema validation.** Ajv can validate your schema
  against the draft's meta-schema at compile time, catching both
  unknown-keyword typos and wrong value shapes (e.g. `minimum: "5"`
  when it should be a number). oav ships a narrower `strict` option
  that catches unknown-keyword typos (`minimumx: 5`) and flags
  partially-implemented features; it doesn't check value shapes
  against the meta-schema.
- **`$data` references.** Ajv's non-standard extension where one
  keyword's value comes from the data being validated
  (`{ minimum: { $data: "1/min" } }`). oav doesn't implement it. The
  common use case (cross-field constraints like `max >= min`)
  works in oav via an object-level custom keyword that sees the
  whole object and reaches siblings directly; see
  [`examples/cross-field-validation.ts`](../examples/cross-field-validation.ts).
  Trade-off: the constraint sits on the parent object in the schema
  rather than inside the constrained field's own subschema.
- **Async validation.** Ajv supports async formats and keywords (e.g.
  a format that hits a database). oav's formats and custom keywords
  are synchronous.
- **`express-openapi-validator` conveniences.** `req.body` /
  `req.query` type coercion, `res.json` interception for response
  validation, `fileUploader` (multer integration), `securityHandlers`
  (credential-verifying dispatch; oav does shape-only security
  validation but doesn't verify credentials),
  `operationHandlers` filesystem auto-loading, and `ignorePaths` /
  `ignoreUndocumented` are one-liner options. oav leaves these to the
  adapter; see [`integration.md`](./integration.md) for recipes.

## Where oav does more

Capabilities oav has that Ajv (alone or with
`express-openapi-validator`) doesn't.

- **Streaming body validation.** The separate
  `@aahoughton/oav-stream-validator` package validates a JSON body
  against its operation schema as it streams, echoing the input bytes
  through to a sink and reporting violations on a side channel. Memory
  stays bounded for schemas with structural bounds (or configured
  caps), so a multi-GB body validates without materializing in heap. A
  second, push-based engine that reuses oav's keyword set and flat error
  model. Ajv and `express-openapi-validator` validate a fully-parsed
  value; there is no streaming path.
- **Design-time buffer budgets.** `analyzeSpec(document)` reports, per
  operation, which request and response bodies can stream, which must
  buffer, and how large a buffer can get (in wire bytes, or
  `"unbounded"` where the schema has no structural cap), without reading
  a byte of traffic. It runs the same classifier the streaming engine
  uses, so the budget matches runtime behavior. The CLI surfaces it as
  `oav stream-check <spec>`, with `--fail-on-unbounded` as a CI gate.
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
- **AOT-compiled HTTP validator.** `oav compile-spec <openapi.yaml>`
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
  `allErrors: false` still maintains error infrastructure; oav's
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

oav's compiler and validator have zero runtime dependencies. The lean
`oav-core` package ships exactly that (no runtime deps),
and accepts JSON specs. The `oav` package adds YAML readers for
`.yaml` spec files and the `oav` CLI. The two efficiency
libraries Ajv pulls in (`fast-deep-equal`, `json-schema-traverse`)
have equivalents in-tree; the two capability libraries (`fast-uri`,
`require-from-string`) map to features oav doesn't implement (see
"Where Ajv does more" above).

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

Pick oav when you want a structured error tree, streaming validation of
large bodies with a design-time buffer budget you can check before
deploy, overlays over specs you don't own, an OpenAPI 3.0 dialect built
into the validator, explicit control over where validation runs in your
HTTP stack, or standalone OpenAPI HTTP validator output for
edge/serverless deployments. It also fits compile-heavy workloads: the
benchmarks show one to two orders of magnitude faster schema compile
than Ajv; see the Performance section above.

For benchmark numbers rather than feature comparisons, see
[`performance/README.md`](../performance/README.md).
