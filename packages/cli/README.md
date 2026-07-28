# oaverify (CLI)

The `oaverify` binary: a thin wrapper around the oaverify library for shell
scripts, Makefiles, and CI.

## Install

```bash
# global install
npm install -g oaverify
oaverify --help

# one-off via npx
npx oaverify validate openapi.yaml --request req.http
```

The CLI lives in the `oaverify` package, not `@oaverify/core`. `@oaverify/core`
doesn't ship a `bin` or any CLI glue. `oaverify` carries `commander`
(argv parsing) as a regular dependency. `esbuild` (AOT bundling
for `compile-schema` / `compile-spec`) is an optional peer
dependency; install it alongside `oaverify` only if you use those
commands. Users who only need the programmatic API install
`@oaverify/core` instead.

## Two verbs

Most of what you will do is one of two questions, and they are different
commands because they are about different things.

```bash
oaverify check <spec>       # is my SPEC good?
oaverify validate <spec>    # does this PAYLOAD conform to my spec?
```

`check` inspects the document you wrote. `validate` inspects traffic
against it. Everything else here builds artifacts (`resolve`,
`compile-schema`, `compile-spec`) or reports a budget (`stream-check`).

## Commands

```bash
oaverify check <spec>                                         # hygiene + schema-lint findings
oaverify check <spec> --only schema                           # one class only
oaverify check <spec> --fail-on warning                       # CI gate: exit 1 on any finding
oaverify check <spec> --format json                           # { findings: [...] }, each classed
```

Schema findings are located by the operation they were compiled for,
then the path within that schema:

```
schema  silent-rewrite/required-not-in-properties
  GET /policies 200 response body (application/json) -> properties.items.allOf[0]
  required: "signedDate" is not declared in properties reachable here
```

```bash

oaverify resolve <spec>                                       # stitch a multi-file spec
oaverify resolve <spec> --overlay overlay1.json --overlay overlay2.json

oaverify validate <spec> --request req.http                   # full HTTP request from a .http file
oaverify validate <spec> --path "POST /pets" --body body.json
oaverify validate <spec> --path "GET /pets" --response --status 200 --body resp.json

oaverify compile-schema <schema.json> -o v.mjs                # single JSON Schema -> standalone validator
oaverify compile-schema <schema.json> --dialect openapi-3.0

oaverify compile-spec <openapi.yaml> -o v.mjs                 # OpenAPI spec -> standalone HTTP validator
oaverify compile-spec <openapi.yaml> --requests-only -o v.mjs
oaverify compile-spec <openapi.yaml> --only "POST /pets" -o v.mjs

oaverify stream-check <openapi.yaml>                          # per-operation streaming-buffer budget
oaverify stream-check <openapi.yaml> --verbose                # list each unbounded buffering position
oaverify stream-check <openapi.yaml> --fail-on-unbounded      # CI gate: exit 1 if any body is unbounded
```

Pass `-` as the file path to read from stdin (e.g. `--body -`).

`<spec>` and `--overlay <file>` accept local paths, `file://` URIs,
and `http://` / `https://` URLs (both JSON and YAML over HTTP). Relative
`$ref`s inside a URL-hosted spec resolve against the URL's base.

`--request` takes a `.http` file; see [`.http` file format](#http-file-format)
below for the expected shape.

## Flags

| Flag                                          | Command                                          | Meaning                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--format text\|json\|summary`                | validate                                         | Error rendering. Default `text`. `summary` is one line per leaf; `flat` is its deprecated alias.                                        |
| `--depth <n>`                                 | validate                                         | Truncate error tree depth (text format).                                                                                                |
| `--overlay <file>`                            | resolve / validate / compile-spec / stream-check | Repeatable; applies overlays in order. Accepts a standard OpenAPI Overlay 1.0 document or a typed `SpecOverlay`; anything else exits 3. |
| `--only <classes>`                            | check                                            | Comma-separated subset of `hygiene`, `schema`. Default: all.                                                                            |
| `--fail-on <level>`                           | check                                            | Non-zero exit on any finding at or above `<level>`. Currently only `warning`.                                                           |
| `--format text\|json`                         | check / stream-check                             | check: one finding per line, or `{ findings }`. stream-check: per-operation table, or the `SpecBudget`.                                 |
| `--dialect 2020-12\|openapi-3.1\|openapi-3.0` | compile-schema / compile-spec                    | Schema dialect. Defaults: 2020-12 (compile-schema), auto-detect from `openapi` field (compile-spec).                                    |
| `--requests-only`                             | compile-spec                                     | Skip response-validator emit. Smaller output.                                                                                           |
| `--only <method-path...>`                     | compile-spec                                     | Repeatable; restrict emit to given ops, e.g. `--only "POST /pets"`.                                                                     |
| `--output-mode flat\|tree\|predicate`         | compile-spec                                     | Result shape of the emitted validators. Default `flat`. Mirrors `output`.                                                               |
| `--max-errors <n>`                            | compile-spec                                     | Leaf-error cap baked in: a positive integer or `all`. Default `1`. Mirrors `maxErrors`.                                                 |
| `--fail-on-unbounded`                         | stream-check                                     | Exit non-zero if any request/response body has an unbounded peak buffer. CI gate.                                                       |
| `--verbose`                                   | stream-check                                     | List each unbounded buffering position with its path under its body.                                                                    |
| `--max-buffered-bytes <n>`                    | stream-check                                     | Buffer cap the effective peak is computed against (clamps over-cap positions to the cap).                                               |
| `-o <file>`                                   | all                                              | Write output to a file instead of stdout.                                                                                               |
| `--quiet`                                     | resolve / validate / stream-check                | Exit code only, no stdout.                                                                                                              |

## `compile-schema` output

`oaverify compile-schema <schema.json>` emits an ESM module exporting a
`validate(data)` function matching `compileSchema(schema).validate(data)`.
esbuild bundles the runtime helpers into the output, so the resulting
module has zero imports. Typical output is ~13 KB for a small schema,
~20–40 KB for a schema that touches every built-in format.

Use for Lambda zips, Cloudflare Workers, Vercel Edge, single-file
deployments: anywhere `new Function()` is forbidden or the runtime
library footprint is unwanted.

Constraints on the input schema:

- **Built-in formats only.** If the schema references `format: "..."`
  names outside `@oaverify/core/formats`, compile fails with exit
  code 3 and a listing of the unknown names. Custom formats aren't
  serialisable to standalone source.
- **No custom keywords.** Same reason: the keyword's validator
  function can't be serialised.
- **External `$ref`s must be pre-inlined.** Run `oaverify resolve` over
  a multi-file input first, or use `@oaverify/core/spec`'s `resolveSpec`
  programmatically, before piping the schema into `compile-schema`.

## `compile-spec` output

`oaverify compile-spec <openapi.yaml>` emits an ESM module exposing the
same surface as `createValidator(document)`: `validateRequest`,
`validateResponse`, `validateFetchRequest`, `validateFetchResponse`,
`getOperation`, `detectedVersion`, `warnings`. Every operation's
parameter / body / response schemas are pre-compiled and inlined.
esbuild bundles everything; the resulting module has zero imports.

The emitted `validate*` return the same result shapes as the library:
`{ valid: true }` or `{ valid: false, errors, truncated }`, stopping at
the first error by default (flat + `maxErrors: 1`), the same zero-config
behaviour as `createValidator`. `--output-mode` and `--max-errors`
(below) tune the shape, exactly mirroring the `output` / `maxErrors`
options.

Consumers who were running `createValidator(await loadSpec(...))` at
application boot get the same behavior with no YAML parse, no
`$ref` walk, no schema compilation at load time. Target use cases:

- **Cloudflare Workers / Vercel Edge**: the runtime sandbox
  forbids `new Function()`, which rules out `ajv.compile()` at
  runtime. Pre-compiled output sidesteps it.
- **Lambda@Edge / viewer functions**: 1 MB zipped; the full
  library + YAML parser graph doesn't fit. A compile-spec output for
  a small-to-medium spec does.
- **Lambda + API Gateway**: shaves 5–50 ms off cold starts by
  removing spec parse + schema compile from the critical path.
- **Single-file drops** (Deno subhosting, Val.town, `deno compile`,
  `bun build --compile`): one `.mjs`, no node_modules.

### Flags

- **`--overlay <file>`** (repeatable): applies overlays at build
  time. Same semantics as `oaverify resolve`.
- **`--dialect <name>`**: forces a specific schema dialect. Default
  is auto-detected from the spec's `openapi` field.
- **`--output-mode flat|tree|predicate`**: result shape of the emitted
  validators, mirroring `createValidator`'s `output`. Default `flat`
  (a de-nested `errors` list); `tree` for the nested `error` tree;
  `predicate` for a bare boolean.
- **`--max-errors <n>`**: leaf-error cap baked into the validators,
  mirroring `maxErrors`. A positive integer or `all` (unbounded).
  Default `1` (fast-fail). A failing result sets `truncated: true`
  when the cap was reached.
- **`--requests-only`**: skips response-validator emit.
  `validateResponse` / `validateFetchResponse` are still exported but
  report every response as valid (a passing result in the configured
  output mode). Output shrinks significantly on response-heavy specs
  (rough rule of thumb: ~50% smaller on Stripe-shape, ~20–30% on
  petstore-shape).
- **`--only "METHOD PATH"`** (repeatable): restricts emit to
  specified operations. OR-combined across multiple flags. Paths not
  matching any `--only` are dropped from the router. Methods dropped
  from a partially-filtered path return `code: "route"` (404),
  treating the filtered emit as "this deployment's surface" rather
  than "a partial view of the full spec". Gateway-routing layers
  that expect 405 (method not implemented here, try another
  service) need to account for this.

### Bundle size

Output size scales with op count and schema complexity:

| Spec shape     | Ops  | Output (bundled) |
| -------------- | ---- | ---------------- |
| petstore       | 2    | ~20 KB           |
| Adyen Checkout | 23   | ~200 KB          |
| Stripe         | 400+ | ~2–3 MB          |

Fits Cloudflare Workers' 10 MB compressed limit through Stripe-scale.
Fits Lambda@Edge's 1 MB viewer-function limit through low-hundreds
of ops. `--requests-only` and `--only` both shrink output materially.

### Not serialised

Same limits as `compile-schema`, plus:

- **Custom formats / custom keywords**: the validator function
  can't be serialised. Compile dynamically with `createValidator`
  if you need them.
- **External `$ref`s**: internal refs within the document compile
  fine; multi-file external refs must be pre-inlined via `oaverify
resolve` or `resolveSpec` before running `compile-spec`.

### Relationship to ajv's `standaloneCode`

Ajv's `standaloneCode` emits a compiled JSON Schema validator as
module source; `compile-schema` does the same. `compile-spec` adds
the HTTP layer on top: router matching, content-type dispatch,
parameter deserialisation (style / explode), response status
matching, and shape-only security checks, emitted directly rather
than hand-built over a standalone schema validator.

## `stream-check` output

`oaverify stream-check <openapi.yaml>` reports the streaming-buffer budget
for every operation: for the request body and each response body, which
bodies stream, which must buffer, and how large a buffer can get. It is
the streamability analysis (`@oaverify/stream`'s
`analyzeSpec`) surfaced over a whole resolved spec, so a deployer can
see before deploy where a body would be materialized in heap.

The default `text` envelope is a per-operation table. `--verbose` lists
each unbounded buffering position with its path and the keyword that
left it unbounded. `--format json` emits the `SpecBudget` payload for
machine consumers. `--fail-on-unbounded` exits `1` when any body has an
unbounded peak, so CI can reject a spec that can't stream within a
fixed memory bound; `--max-buffered-bytes <n>` computes the effective
peak against a chosen cap. Overlays apply first (`--overlay`, same
semantics as `oaverify resolve`).

A body whose schema can't be classified is reported with an error
rather than aborting the sweep, so one unclassifiable body doesn't hide
the budget for the rest of the spec.

## Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | clean                                                                        |
| 1    | a domain check failed: validation errors, or findings met a `--fail-on` gate |
| 2    | the input could not be loaded, resolved, or compiled                         |
| 3    | CLI usage error                                                              |

One taxonomy across every command, rather than a per-command meaning.
Note in particular that `check` does not vary its exit code by finding
class: a single run can report several classes at once, so the class
lives in the output and the exit code answers only "did this pass".

## `.http` file format

```
POST /pets?limit=10 HTTP/1.1
Content-Type: application/json
X-Tenant-Id: abc-123

{"name": "Fido", "species": "dog"}
```

A blank line separates headers from body. CRLF and LF both work.
