# @oaverify/stream

A streaming JSON Schema 2020-12 validator for
[`@oaverify/core`](https://www.npmjs.com/package/@oaverify/core). It
validates a JSON document against a resolved schema **as it streams**,
echoing the input bytes through unchanged while reporting violations on a
side channel. Forward validation avoids materializing the whole body.
Token accumulators, retained object names and edits still consume memory;
configure resource policies for the input your application accepts.

The trade-off is throughput: on a body that turns out valid,
streaming validation is slower than buffering the whole document and
validating it in memory. It can release completed values as input arrives
and refuse invalid input before its tail arrives. If your bodies
fit comfortably in heap, the in-memory validator is the faster tool.

This is a second engine, not a mode of the in-memory validator.
`@oaverify/core`'s compiler is pull-based over a fully-parsed value; this engine
is push-based over a token stream. It reuses `@oaverify/core`'s in-memory
validator for the subtrees a compile-time classifier marks BUFFER (so
`format` assertion runs in that delegate, against the built-in formats
plus any you add or override through the `formats` option),
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

Malformed UTF-8 in strings or keys is a parse error. `utf8: "replace"`
preserves the previous replacement decoding behavior. See
[Input Encoding](../../docs/streaming.md#input-encoding) and
`StreamValidatorOptions.utf8`.

Count and length limits resolve as early as the input allows: an
**over-limit** (`maxItems`, `maxProperties`, `maxLength`) fails at the
offending element / key / code point, before the rest of the value
streams, so under `terminate` an over-count body is rejected without
echoing its tail downstream. An **under-limit** (`minItems`,
`minProperties`, `minLength`) can only be known once the scope closes, so
it reports at the closing delimiter. The verdict is identical either way;
eager enforcement only moves _when_ the violation surfaces (and its byte
offset points at the cause rather than the delimiter).

### Input token policies

Set `maxKeyBytes` and `maxNumberBytes` to refuse excessively long input tokens
before accumulating them, including inside nested objects, buffered subtrees
and dropped values. Both default off and work with OpenAPI 3.0 as well as 3.1.
They limit input spelling independently of schema: quotes and escapes count
for keys; sign, fraction and exponent count for numbers. See
`StreamValidatorOptions.maxKeyBytes` and `StreamValidatorOptions.maxNumberBytes`
for the contract, and the [recipe](../../docs/streaming.md#input-token-limits).

Refusal throws `KeyLimitError` or `NumberLimitError`, errors the stream and
rejects `result`, regardless of validation budget or policy. After detach
has sealed validation, its unparsed tail is outside these checks. These
policies do not bound total heap or the number of retained names.

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
materialized and delegated to `@oaverify/core/schema`'s in-memory validator.
`maxBufferedBytes` is checked on parser events; it can be exceeded while an
unfinished token is arriving. Use the input token policies below to limit
keys and number spellings. Only a REJECT keyword
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
materializes subtrees and estimates their source spans, without reading a byte.
Its classifications and numbers do not cover all retained memory.

```ts
import { analyzeStreamability } from "@oaverify/stream";

const report = analyzeStreamability(bodySchema, { openApiVersion: "3.1" });
report.classification; // "streamable" | "tee" | "buffer"
report.peakBytes; // materialization estimate in wire bytes, or "unbounded"
report.effectivePeakBytes; // estimate after applying the per-region cap

// The punch list: positions with no structural bound fall back to the cap.
for (const p of report.positions.filter((p) => p.maxBytes === "unbounded")) {
  console.warn(`${p.path || "<root>"}: ${p.keyword} unbounded (${p.unboundedBy})`);
}
```

The model takes the maximum over sequential materialized values and sums
concurrent TEE branch peaks. It estimates a BUFFER island from its subtree's
structural keywords (`maxLength` / `maxItems` / `const` / `enum`, and a closed
object's properties), returning `"unbounded"` when a required bound is missing.
An open object is `"unbounded"` regardless of `maxProperties`, which the byte
model does not yet use. Estimates currently undercount JSON escaping,
whitespace and number spellings, so finite numbers are not conservative
bounds. `maxKeyBytes` and `maxNumberBytes` do not change these estimates.
An unstreamable schema throws the same `ClassifierError` as the runtime.

`verdict.peakBufferedBytes` measures materialized source spans plus edit-hook
retention. Zero means those measured categories contributed zero. Token
accumulators, completed-name sets, captures and stream queues are excluded.
Source spans also differ from heap: whitespace increases the former without
necessarily increasing the latter. Neither the analyzer nor this runtime
metric establishes an overall memory ceiling. See `StreamabilityReport` and
`StreamVerdict.peakBufferedBytes` for the contracts.

`analyzeSpec(document, options)` rolls this up over a whole resolved
OpenAPI document: one budget per operation, for the request body and each
response body. A body whose schema cannot be classified is reported with
an `error` field rather than throwing, so a sweep surveys the whole spec.
The `oaverify` CLI surfaces it as `oaverify stream-check <spec>` (a per-operation
table; `--verbose` lists each buffering position with its byte estimate or
missing bound and marks bounded estimates above `--max-buffered-bytes`,
`--format json` emits the `SpecBudget`, `--fail-on-unbounded` exits non-zero
for CI):

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
