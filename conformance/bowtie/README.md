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
Check it against [`REPORT.md`](../REPORT.md) first,
which documents the known gaps ($dynamicRef runtime scope, external and
cross-document `$ref` loading, and four singletons). Only what survives
that is news.
