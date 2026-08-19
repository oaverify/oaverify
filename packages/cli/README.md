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
oaverify check <spec>                                         # every class; exits 1 on spec violations (default gate: error)
oaverify check <spec> --findings conformance                  # one class only, and only that work
oaverify check <spec> --findings -unused-tag                  # everything except one code
oaverify check <spec> --fail-on warning                       # tighten: exit 1 on any finding
oaverify check <spec> --fail-on none                          # advisory: report everything, exit 0
oaverify check <spec> --severity 'unsatisfiable/*=error'      # regrade; the default gate reads the result
oaverify check <spec> --format sarif -o results.sarif             # SARIF 2.1.0 for code scanning
oaverify check <spec> --format json                           # { findings: [...] }, each classed
```

Schema findings are located by the operation they were compiled for,
then the path within that schema:

```
warning schema  silent-rewrite/required-not-in-properties
  GET /policies 200 response body (application/json) -> properties.items.allOf[0]
  required: "signedDate" is not declared in properties reachable here
```

Severity leads each line, because it is what decides whether to act now;
the class follows, because it says which pass to look at.

Most findings about a schema reached through a `$ref` are addressed by
the component it came from (`components.schemas.Pet.properties.tags`)
rather than by the route that reached it, because they are one edit at
one definition however many operations reach it.

`silent-rewrite/required-not-in-properties` is the exception, and the
example above shows it: it keeps the path from the operation. That rule
reports which property names are reachable at an instance position, and
a shared component says different things at different use sites, so the
definition would be the wrong place to send you.

Schemas compile per operation, so a component several operations share
would otherwise be reported once per operation. `check` prints it once
against the first operation that reached it and counts the rest; the
JSON envelope carries the count as `occurrences`.

```
schema [silent-rewrite/ref-siblings-oas30] GET /a 200 response body (application/json)
  -> components.schemas.Wrapper.properties.inner (and 2 more operation(s)): OAS 3.0: ...
```

### Mapping a finding back to source

`location` is display text. Its shape varies by class, it is free to
change wording, and it is not meant to be parsed. To locate a finding
programmatically, read `target`, and to find the file it was written in
read `target.source`.

Both are specified in
[the published CLI README](https://github.com/oaverify/oaverify/blob/main/packages/oav/README.md#the-check---format-json-contract),
which is the canonical statement because it is the one a consumer who
ran `npm i oaverify` actually has. It carries the closed `anchor`
vocabulary, what absence means for each field, and the stability
promise. This file does not restate it, so that there is one copy to
keep true.

Three things that belong here rather than there, being the reasoning
behind the contract rather than the contract:

**Why `scoped-definition` exists.** `required` is checked against the
property names reachable at an _instance_ position, and a component says
different things at different use sites. Reporting such a finding as
`definition` would send a reader to fix shared text that is not wrong.

**What `source` does not claim.** It addresses the node the resolved
node was built from, and does not promise the two hold the same value.
The resolver rewrites every external `$ref` into an internal one on the
way through, so a value-equality guarantee would have to abstain on the
most common node in a resolved multi-file spec.

**Whose route `via` is.** Where `anchor` is `definition` or
`scoped-definition`, `via` is how the resolver first reached that shared
definition, not the route this particular finding took to it. That is
the same caveat `anchor` already carries for `pointer`: a shared
definition is reported once, addressed where it is written.

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

Pass `-` as the file path to read from stdin. That works for `<spec>`
in every command that takes one, as well as for `--body` and
`--request`:

```bash
redocly bundle openapi.yaml | oaverify check -
jq 'del(.paths["/internal"])' openapi.json | oaverify stream-check -
```

Generated, bundled and filtered specs are the ones you least want to
write to disk in CI, and this saves the temp file.

Three things to know about it.

**Format is a stated rule, not detection.** `-` has no extension to
dispatch on, so: read the stream to completion, strip a BOM, trim
leading whitespace, and if the first character is `{` parse as JSON,
otherwise parse as YAML. The whole stream has to be read before either
parser runs, so the rule costs nothing. The one shape it decides
against is a spec written in top-level YAML flow style
(`{openapi: 3.1.0, ...}`), which is legal YAML and vanishingly rare for
a piped document.

**Relative `$ref`s resolve against the working directory**, since `-`
has no directory of its own. Bundled specs are self-contained, so this
rarely comes up; pipe through a file when it does.

**One stream, one reader.** `oaverify validate - --body -` asks stdin
for two different things and exits 3 saying so. A spec on stdin with
`--body` or `--request` reading a file is fine.

A file literally named `-` is unreachable this way; refer to it as
`./-`.

`<spec>` and `--overlay <file>` accept local paths, `file://` URIs,
and `http://` / `https://` URLs (both JSON and YAML over HTTP). Relative
`$ref`s inside a URL-hosted spec resolve against the URL's base.

`--request` takes a `.http` file; see [`.http` file format](#http-file-format)
below for the expected shape.

## Flags

| Flag                                          | Command                                                  | Meaning                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format text\|json\|summary`                | validate                                                 | Error rendering. Default `text`. `summary` is one line per leaf.                                                                                                                                                                                                                                                                            |
| `--depth <n>`                                 | validate                                                 | Truncate error tree depth (text format).                                                                                                                                                                                                                                                                                                    |
| `--overlay <file>`                            | check / resolve / validate / compile-spec / stream-check | Repeatable; applies overlays in order. Accepts a standard OpenAPI Overlay 1.0 document or a typed `SpecOverlay`; anything else exits 3.                                                                                                                                                                                                     |
| `--findings <terms>`                          | check                                                    | Which findings to report (default: all): comma-separated terms in `--severity`'s key grammar, `-` prefixed to exclude. A term without `-` also decides which checks run, so it is how a run avoids work. Order is irrelevant; `malformed` is refused. See [docs/strictness.md](../../docs/strictness.md#which-findings-you-get---findings). |
| `--severity <map>`                            | check                                                    | Regrade findings before `--fail-on` reads them: comma-separated `<key>=<level>`, key being a code, a family as `name/*`, or a class. Most specific wins. `malformed` is refused. See [docs/strictness.md](../../docs/strictness.md#when-you-disagree-with-the-grading).                                                                     |
| `--fail-on <level>`                           | check                                                    | Non-zero exit on any finding at or above `<level>`: `none` (advisory, always exit 0 short of malformed), `warning` (any finding), `error` (specification violations), `fatal`. Default `error`, so a spec violation fails with no flag; note this makes `--severity` gate-affecting.                                                        |
| `--format text\|json\|sarif`                  | check / stream-check                                     | check: one finding per line, or `{ findings }` plus `skipped` when an exclusion dropped anything. stream-check: per-operation table, or the `SpecBudget`.                                                                                                                                                                                   |
| `--dialect 2020-12\|openapi-3.1\|openapi-3.0` | compile-schema / compile-spec                            | Schema dialect. Defaults: 2020-12 (compile-schema), auto-detect from `openapi` field (compile-spec).                                                                                                                                                                                                                                        |
| `--requests-only`                             | compile-spec                                             | Skip response-validator emit. Smaller output.                                                                                                                                                                                                                                                                                               |
| `--max-total-bytes <n>`                       | compile-spec                                             | Byte cap on the emitted Fetch helpers' body read: a positive integer or `none`. Default 1048576 (1 MiB).                                                                                                                                                                                                                                    |
| `--return-values`                             | compile-spec                                             | Also hand back the deserialized parameter values from the emitted `validateRequest`, under a `value` field. Default off. Rejected with `--output-mode predicate`, which returns a bare boolean. Mirrors `returnValues`.                                                                                                                     |
| `--validate-security <mode>`                  | compile-spec                                             | Reject requests missing the declared credential: `off` (default), `shape`, `strict`. Shape-only, and never credential verification. Mirrors `validateSecurity`.                                                                                                                                                                             |
| `--only <method-path>`                        | compile-spec                                             | Repeatable; restrict emit to given ops, e.g. `--only "POST /pets"`.                                                                                                                                                                                                                                                                         |
| `--output-mode flat\|tree\|predicate`         | compile-spec                                             | Result shape of the emitted validators. Default `flat`. Mirrors `output`.                                                                                                                                                                                                                                                                   |
| `--max-errors <n>`                            | compile-spec                                             | Leaf-error cap baked in: a positive integer or `all`. Default `1`. Mirrors `maxErrors`.                                                                                                                                                                                                                                                     |
| `--unknown-formats error\|ignore`             | compile-schema / compile-spec                            | Policy for `format` names outside the built-in set. `error` (default): refuse, naming them, exit 3. `ignore`: emit without asserting them, one stderr warning per name; compile-spec also records each in the module's `warnings` export. Mirrors `unknownFormats`.                                                                         |
| `--remote-refs <mode>`                        | resolve / check / validate / compile-spec / stream-check | How far `http(s)` reads may go, **the entry document included**: `same-origin` (default), `allow`, `deny`. See [docs/configuration.md](../../docs/configuration.md#resolving-untrusted-specs).                                                                                                                                              |
| `--untrusted`                                 | resolve / check / validate / compile-spec / stream-check | Treat the document as hostile: confine file reads to the entry's directory, tighten the size and time caps, and imply `--remote-refs same-origin`. An explicit `--remote-refs` overrides that half.                                                                                                                                         |
| `--fail-on-unbounded`                         | stream-check                                             | Exit non-zero if any request/response body has an unbounded peak buffer. CI gate.                                                                                                                                                                                                                                                           |
| `--verbose`                                   | stream-check                                             | List each unbounded buffering position with its path under its body.                                                                                                                                                                                                                                                                        |
| `--max-buffered-bytes <n>`                    | stream-check                                             | Buffer cap the effective peak is computed against (clamps over-cap positions to the cap).                                                                                                                                                                                                                                                   |
| `-o <file>`                                   | all                                                      | Write output to a file instead of stdout.                                                                                                                                                                                                                                                                                                   |
| `--quiet`                                     | resolve / check / validate / stream-check                | Exit code only, no stdout.                                                                                                                                                                                                                                                                                                                  |
| `-V, --version`                               | (top level)                                              | Print the installed version and exit.                                                                                                                                                                                                                                                                                                       |

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

- **No custom keywords or registered format functions.** A validator
  function registered at runtime can't be serialised to standalone
  source. This is the hard constraint; no option changes it.
- **Unknown format names are policy, not capability.** A `format`
  name outside `@oaverify/core/formats` has no validator behind it
  either way, so the question is only whether to say so loudly. By
  default both compile commands refuse with exit code 3 and a listing
  of the names; `--unknown-formats ignore` emits anyway, without
  asserting them (matching the runtime) and with a stderr warning per
  name. The warnings go to stderr, so `compile-schema s.json > v.mjs`
  still writes a clean module.
- **The input must be a JSON Schema, not an OpenAPI document.** Fed a
  spec, every top-level key is an unknown keyword and the emitted
  `validate()` would accept everything; `compile-schema` detects a
  top-level `openapi` / `swagger` field and refuses with exit code 2,
  pointing at `compile-spec`.
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

The emitted `validate*` return the same result shapes as the library,
with the same zero-config default (flat + `maxErrors: 1`);
`--output-mode` and `--max-errors` mirror the `output` / `maxErrors`
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

### Flag notes

The [Flags table](#flags) above covers the whole set; four deserve
more than a row:

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
- **`--validate-security <mode>`**: bakes the runtime's
  `validateSecurity` into the module. `off` (the default) emits no
  security machinery at all, so a compiled module neither carries the
  document's requirements nor checks them, matching
  `createValidator`'s default. `shape` and `strict` enforce the
  declared requirement, operation-level or document-level, with the
  precedence OpenAPI defines.

  The check is shape-only. It confirms a credential of the declared
  kind arrived, and never that it is valid, so a passing request is not
  an authenticated one. It also ignores scopes entirely. `shape`
  silently satisfies schemes it cannot inspect (`oauth2`,
  `openIdConnect`, `mutualTLS`, HTTP schemes other than bearer and
  basic); when a document requires nothing else, the emitted module
  records a `warnings` entry saying the gate accepts every request.
  `strict` refuses those schemes instead.

  For real enforcement, compose rather than configure. `getOperation`
  returns the matched operation with its requirement and its scopes,
  which is more than this check ever inspects:

  ```js
  const op = getOperation(req);
  const required = op?.operation.security ?? documentSecurity;
  if (required && !myAuth(req, required)) return unauthorized();
  const result = validateRequest(req);
  ```

- **`--return-values`**: the emitted `validateRequest` and
  `validateFetchRequest` additionally return the parameter values they
  deserialized while validating, under `value`, grouped by HTTP
  location. Same channel and same presence rule as `createValidator`'s
  `returnValues`: a parameter appears when the call reached it,
  deserialized it, and its schema accepted the result, so `value` is
  present on a failing request too and carries whatever passed. Off by
  default, and emission is byte-identical to the flag's absence when it
  is off.

### Bundle size

Output scales with operation count and schema complexity, and both
numbers matter: the file on disk, and what it compresses to. The
platform limits below are on the compressed artifact, so a raw byte
count read against them is wrong by roughly an order of magnitude at
this end of the range.

Measured on four real published documents, full emit and
`--requests-only`, as `bytes (gzip)`:

| Document                       | Ops | Full emit        | `--requests-only` |
| ------------------------------ | --- | ---------------- | ----------------- |
| `examples/specs/petstore.yaml` | 2   | 89 KB (21 KB)    | 83 KB (20 KB)     |
| ably.io platform               | 22  | 712 KB (39 KB)   | 394 KB (32 KB)    |
| peertube                       | 186 | 3.1 MB (171 KB)  | 1.3 MB (83 KB)    |
| github.com                     | 845 | 34.7 MB (2.1 MB) | 8.2 MB (417 KB)   |

The three named documents are from
[APIs.guru](https://apis.guru/), which `detection/real-world/specs`
pins; the last three needed `--unknown-formats ignore`, since published
documents routinely name formats outside the built-in set.

Two things the table shows that a single column would not. Compression
does most of the work, because the bulk of a large emit is repetitive
generated validator source: github.com is 34.7 MB on disk and 2.1 MB
compressed, a 16x ratio that grows with size. And `--requests-only` is
worth far more at scale than at petstore scale, 4x on github.com against
1.07x on petstore, because response schemas dominate a large document.

Against the platform limits, both of which are on the compressed
artifact: Cloudflare Workers' 10 MB fits through 845 operations with
room to spare. Lambda@Edge's 1 MB viewer-function limit fits through
low hundreds of operations (186 ops compresses to 171 KB) and is
exceeded somewhere before 845. `--only` shrinks output proportionally
to what it drops and is the lever when a deployment serves a subset.

### Not serialised

Same limits as `compile-schema`, plus:

- **Custom formats / custom keywords**: the validator function
  can't be serialised. Compile dynamically with `createValidator`
  if you need them.
- **External `$ref`s**: internal refs within the document compile
  fine; multi-file external refs must be pre-inlined via `oaverify
resolve` or `resolveSpec` before running `compile-spec`.
- **Validator options with no counterpart**: the emitted module
  compiles one configuration, and it is `createValidator`'s default.
  Some options survive into the artifact, each through a flag in the
  table above (`output`, `maxErrors`, `unknownFormats`, `maxTotalBytes`,
  `returnValues`, the dialect). The rest of
  `ValidatorOptions` has no flag to carry it, so a deployment that opts
  into one and a module compiled from the same document answer
  differently on the requests that option decides:
  `strictQueryParameters` and `allowBracketedQueryArrays` are two that
  do. The parity grid under `packages/cli/test/aot-grid` carries a case
  for each one it has measured, and its registry is the current list
  rather than this paragraph. `validateSecurity` is the exception, and a
  defect rather than a limit: the emitted module always checks
  operation-level security, which is no setting of that option
  ([#895](https://github.com/oaverify/oaverify/issues/895)).

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

One taxonomy across every command, rather than a per-command meaning.
The table, and what exit 2 and exit 4 mean, are in
[the published CLI README](https://github.com/oaverify/oaverify/blob/main/packages/oav/README.md#exit-codes),
for the same reason as the finding contract above: a CI job is written
by someone who installed `oaverify`, not by someone reading this file.

## `.http` file format

```
POST /pets?limit=10 HTTP/1.1
Content-Type: application/json
X-Tenant-Id: abc-123

{"name": "Fido", "species": "dog"}
```

A blank line separates headers from body. CRLF and LF both work.
