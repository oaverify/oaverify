# @oaverify/stream

A streaming JSON Schema 2020-12 validator for
[`@oaverify/core`](https://www.npmjs.com/package/@oaverify/core). It
validates a JSON document against a resolved schema **as it streams**,
echoing the input bytes through unchanged while reporting violations on a
side channel. Memory is bounded for forward-decidable schemas with
structural bounds (or configured caps), so multi-GB request bodies
validate without materializing in heap.

The trade-off is throughput: on a body that turns out valid,
streaming validation is slower than buffering the whole document and
validating it in memory. What it buys is the bounded footprint and
early rejection: memory stays flat regardless of body size, and an
invalid body can be refused before its tail arrives. If your bodies
fit comfortably in heap, the in-memory validator is the faster tool.

This is a second engine, not a mode of the in-memory validator.
`@oaverify/core`'s compiler is pull-based over a fully-parsed value; this engine
is push-based over a token stream. It reuses `@oaverify/core`'s in-memory
validator for the subtrees a compile-time classifier marks BUFFER (so
`format` assertion runs in that delegate, against the formats you register
through the `formats` option; no format library is bundled by default),
and reuses its flat error model.

It bundles nothing from `@oaverify/core`, declaring it as a regular
dependency instead, so installing the stream validator pulls the engine
it delegates to along with it.

```bash
npm install @oaverify/stream
```

Runnable examples (echo-through, spec bridging, input bounds, scalar
recovery, and the buffer-budget analyzer) live in the repo's
[`examples/` directory](https://github.com/oaverify/oaverify/blob/main/examples/README.md#streaming)
as `stream-*.ts`.

> **Versioned with the `@oaverify/core` family.** The stream validator tracks
> core/schema semantics closely enough that a core major is a stream
> compatibility event too. Per-package changelogs stay specific about what
> changed in this package.

## Usage

```ts
import { pipeline } from "node:stream/promises";
import { createStreamValidator } from "@oaverify/stream";

const validator = createStreamValidator(schema); // throws here if the schema can't be streamed

// Attach side-channel observers before piping: violations are emitted as
// the stream flows, so a listener added after `pipeline` would miss them.
validator.on("violation", (v) => console.warn(v.code, v.path, v.byteOffset));

try {
  await pipeline(request, validator, fs.createWriteStream(tmp));
  await rename(tmp, final); // reached only on a clean finish = valid
} catch (err) {
  // ValidationFailedError (well-formed but invalid) or a parse / I/O error
  await unlink(tmp).catch(() => {});
}

const verdict = await validator.result; // { valid, violations, peakBufferedBytes }
```

Output bytes are the input verbatim (provisional until a clean finish).
The default policy is `terminate` with `maxErrors: 1` (the first violation
destroys the stream and rejects the `pipeline`); `detach` instead seals
the verdict and raw-copies the tail.

Count and length limits resolve as early as the input allows: an
**over-limit** (`maxItems`, `maxProperties`, `maxLength`) fails at the
offending element / key / code point, before the rest of the value
streams, so under `terminate` an over-count body is rejected without
echoing its tail downstream. An **under-limit** (`minItems`,
`minProperties`, `minLength`) can only be known once the scope closes, so
it reports at the closing delimiter. The verdict is identical either way;
eager enforcement only moves _when_ the violation surfaces (and its byte
offset points at the cause rather than the delimiter).

### Supported schemas

The STREAM keyword set (`type`, scalar/string/number constraints,
`properties` / `items` / `required` / bounds / `propertyNames` /
`dependentRequired`, `$ref` recursion, boolean schemas) validates on the
forward spine in one pass. Forward composition (`allOf` / `anyOf` /
`oneOf` / `not` / `if`, all branches forward) **TEEs**: the value's events
fan out to one forward sub-spine per branch, so a composition body still
streams without materializing. Everything that genuinely needs the whole
value (object/array `enum` / `const`, `dependentSchemas`, `discriminator`,
`contains`, `uniqueItems`, a composition with a non-forward branch, or
`format` under an OpenAPI dialect) is a **BUFFER island**: the subtree is
materialized and delegated to `@oaverify/core/schema`'s in-memory validator,
bounded by `maxBufferedBytes`. Only a REJECT keyword
(`unevaluatedProperties` / `unevaluatedItems`), an unknown keyword, or an
unresolvable `$ref` fails fast at construction.

OpenAPI: pass `openApiVersion: "3.0" | "3.1" | "3.2"`. 3.0 is normalized
to 2020-12 shape (`nullable`, boolean `exclusive*`, `$ref` sibling
suppression) before classification; all three select OpenAPI semantics
(`format` asserts).

The engine validates one resolved schema and resolves `$ref` against
**the schema you pass**, not a separate document. An extracted request
body that is (or contains) an internal ref like
`#/components/schemas/Pet` must carry the document's ref containers
(`components` / `$defs` / `definitions`) alongside it, or construction
throws `unresolvable $ref`. Routing, content negotiation, OpenAPI version
detection, and body-schema lookup stay the caller's job; this package
validates one resolved schema, so those concerns sit above it.

For `streamValidatorForOperation`, edit hooks, and event coordinate
rules, see the
[streaming guide](https://github.com/oaverify/oaverify/blob/main/docs/streaming.md).

### Streamability analysis

`analyzeStreamability(schema, options)` is the design-time companion to the
runtime engine: it classifies a resolved schema and reports where it
buffers and how much, without reading a byte. The same classification the
engine runs on, turned into a peak-buffer budget you check before deploy.

```ts
import { analyzeStreamability } from "@oaverify/stream";

const report = analyzeStreamability(bodySchema, { openApiVersion: "3.1" });
report.classification; // "streamable" | "tee" | "buffer"
report.peakBytes; // schema-intrinsic peak in wire bytes, or "unbounded"
report.effectivePeakBytes; // peak under maxBufferedBytes (passes clamp to the cap)

// The punch list: positions with no structural bound fall back to the cap.
for (const p of report.positions.filter((p) => p.maxBytes === "unbounded")) {
  console.warn(`${p.path || "<root>"}: ${p.keyword} unbounded (${p.unboundedBy})`);
}
```

A peak is computable because the engine holds one materialized island at a
time: sequential positions (array items, object properties) buffer one at a
time, so the peak across siblings is a **max**, while a TEE's concurrent
sub-spines **sum**. A BUFFER island is bounded by its subtree's structural
keywords (`maxLength` / `maxItems` / `const` / `enum`, and a closed
object's properties), and `"unbounded"` where one is missing (an open
object is unbounded regardless of `maxProperties`). Sizes are an upper-bound estimate
in the same UTF-8 wire bytes `maxBufferedBytes` caps (heavy `\uXXXX`
escaping can exceed the per-character assumption), so treat the number as a
capacity-planning figure, not a runtime meter. An unstreamable schema
throws the same `ClassifierError` `createStreamValidator` raises.

The runtime meter is `verdict.peakBufferedBytes` on `validator.result`: the
high-water buffered wire bytes an actual stream reached, in the same model
(`0` when nothing buffered, a single island exact, sibling buffers maxed, a
TEE's branches summed, plus any edit-hook retention). Compare it to this
report's `peakBytes` to see how close real traffic came to the predicted
peak. The analyzer bounds the schema; `peakBufferedBytes` reports the input.

`analyzeSpec(document, options)` rolls this up over a whole resolved
OpenAPI document: one budget per operation, for the request body and each
response body. A body whose schema cannot be classified is reported with
an `error` field rather than throwing, so a sweep surveys the whole spec.
The `oaverify` CLI surfaces it as `oaverify stream-check <spec>` (a per-operation
table; `--verbose` lists each unbounded position, `--format json` emits
the `SpecBudget`, `--fail-on-unbounded` exits non-zero for CI):

```ts
import { createFileReader, resolveSpec } from "@oaverify/core/spec";
import { analyzeSpec } from "@oaverify/stream";

const { document } = await resolveSpec({ reader: createFileReader(), entry: "openapi.json" });
for (const op of analyzeSpec(document).operations) {
  for (const body of op.bodies) {
    const peak = body.report?.peakBytes ?? `error: ${body.error}`;
    console.log(`${op.method} ${op.path} ${body.role}${body.status ?? ""}: ${peak}`);
  }
}
```

## Status

Published to the default `latest` dist-tag, versioned with the
`@oaverify/core` family. The classifier
co-evolves with `@oaverify/core`'s keyword set inside the monorepo (a CI drift
test makes a divergence a build failure rather than silent breakage); the
published bundle pins `@oaverify/core` so the two move together.
