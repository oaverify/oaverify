# Bowtie harness

Runs oaverify's JSON Schema engine under
[Bowtie](https://docs.bowtie.report/), the meta-validator that drives every
JSON Schema implementation through the official test suite with one
protocol. Bowtie gives two things the sibling `run-json-schema-suite.ts`
cannot: verdicts from other implementations on the same case, so a
divergence can be read against what the rest of the ecosystem does, and a
suite pulled live from upstream `main` rather than a local clone.

It does not replace the conformance runner. That one is the committed
baseline CI ratchets against; this one is an outward comparison.

## What it is

- `harness.ts` speaks version 1 of the Bowtie harness protocol
  (`start` / `dialect` / `run` / `stop`) over stdin/stdout.
- `build.mjs` bundles it with the engine into one dependency-free ESM
  file via esbuild, reading aliases from `workspace-aliases.ts`.
- `Dockerfile` packages that bundle as the image Bowtie runs.

The compile/validate path mirrors the sibling `run-json-schema-suite.ts`:
`compileSchema` with `jsonSchemaDialect` and `builtInFormats`, with each
case's `registry` fed through the `external` map the way that runner feeds
the suite's `remotes/` directory.

**Only JSON Schema 2020-12 is advertised.** The engine ships three dialects
and the other two (`openapi31Dialect`, `oas30Dialect`) are OpenAPI flavours
rather than JSON Schema drafts. Advertising a draft the engine does not
compile would report suite failures that are really harness lies.

## Running it

Build the image from the repository root, so the engine sources are in
context:

```bash
docker build -f conformance/bowtie/Dockerfile -t localhost/oaverify-harness .
```

Smoke first. A broken harness reads exactly like a broken validator, so a
green smoke run is the gate before trusting any suite numbers:

```bash
bowtie smoke -i localhost/oaverify-harness
```

Then the suite, against whichever implementations you want to compare with:

```bash
bowtie suite 2020-12 \
  -i localhost/oaverify-harness \
  -i js-ajv -i js-hyperjump -i python-jsonschema -i rust-boon -i go-jsonschema \
  > report-2020-12.json

bowtie summary -s failures -f markdown < report-2020-12.json
```

The optional suite takes a URL instead of the short name:

```bash
bowtie suite \
  https://github.com/json-schema-org/JSON-Schema-Test-Suite/blob/main/tests/draft2020-12/optional/ \
  -i localhost/oaverify-harness -i js-ajv -i js-hyperjump \
  -i python-jsonschema -i rust-boon -i go-jsonschema \
  > report-optional.json
```

Bowtie itself installs with `uv tool install bowtie-json-schema` and needs a
container runtime; reference implementation images are pulled on first use.

## Iterating on the harness

`node build.mjs` writes `dist/harness.mjs` (gitignored). Driving the
protocol by hand is faster than a container rebuild for anything but a
packaging change:

```bash
node build.mjs
printf '%s\n' \
  '{"cmd":"start","version":1}' \
  '{"cmd":"dialect","dialect":"https://json-schema.org/draft/2020-12/schema"}' \
  '{"cmd":"run","seq":1,"case":{"description":"const","schema":{"const":37},"registry":null,"tests":[{"description":"no","instance":{}},{"description":"yes","instance":37}]}}' \
  '{"cmd":"stop"}' | node dist/harness.mjs
```

A compile or runtime failure becomes an `errored` result for the affected
tests and never ends the process: one uncompilable schema must not take the
remaining cases down with it.

## Reading the results

A divergence from the other implementations is a question, not a verdict.
Check it against [`REPORT.md`](../REPORT.md) first, which documents the
known gaps (external and cross-document `$ref` loading, plus two
singletons). Only what survives that is news.

Worth knowing what that check was worth the first time it ran: all 20
divergences of the day matched REPORT.md one for one, in both
directions, with nothing new. A harness that agrees exactly with the
record you already keep is one you can then trust on a question the
record does not answer, which is how the `$dynamicRef` gap behind #663
got measured.

## `bowtie perf`, and the benchmarks it cannot measure here

`bowtie perf` compares timings across implementations. Two of its four
default benchmarks are meaningless for oaverify, and they fail in the
direction that flatters us, so check before quoting a number.

`Draft2020-12_MetaSchema` and `nested_schemas` both `$ref` the 2020-12
metaschema. oaverify does not ship the JSON Schema metaschema documents,
so `compileSchema` throws `cannot resolve $ref` and every timed iteration
measures how fast we raise an error. On `nested_schemas` that reads as a
second-place finish and an 8x win over ajv, which is entirely an artifact.
`OpenAPI_Spec_Schema` (internal `$defs` only) and `useless_keywords`
(no refs) are self-contained, and their numbers are real.

Confirm a benchmark before trusting it, by feeding its schema through the
harness and checking for `errored`:

```bash
printf '%s\n' '{"cmd":"start","version":1}' \
  '{"cmd":"dialect","dialect":"https://json-schema.org/draft/2020-12/schema"}' \
  "{\"cmd\":\"run\",\"seq\":1,\"case\":{\"description\":\"x\",\"schema\":$SCHEMA,\"registry\":null,\"tests\":[{\"description\":\"t\",\"instance\":{}}]}}" \
  '{"cmd":"stop"}' | docker run -i --rm localhost/oaverify-harness
```

Registering the metaschema in the harness would turn both benchmarks
green and would also clear two of the four known suite errors. Resist it.
The harness would then have a capability the library does not, which is
the same failure mode as advertising a dialect the engine cannot compile.
The fix belongs in the library or nowhere.

The keyword benchmarks (`-k`) are all self-contained and do measure real
work. Read them as compile throughput rather than validation speed: the
harness compiles per case, and oaverify is a compiling validator, so
codegen lands inside the timing. `additionalProperties` is the clearest
case. It builds one schema of 99,999 properties (the benchmark's "Array
length" parameter does not vary that; every size builds
`max_array_length - 1` properties, which is why its timings are flat),
and oaverify comes last of four at roughly 1.9x ajv. Measured in-process
on that shape, compile is ~364ms against ~15ms per validate. The result
is a statement about generating code for a 100k-property schema, not
about validating one.
