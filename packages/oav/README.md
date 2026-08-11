# oaverify

[![npm](https://img.shields.io/npm/v/oaverify)](https://www.npmjs.com/package/oaverify)
[![CI](https://github.com/oaverify/oaverify/actions/workflows/ci.yml/badge.svg)](https://github.com/oaverify/oaverify/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/oaverify)](https://github.com/oaverify/oaverify/blob/main/LICENSE)

The command-line tool for [oaverify](https://github.com/oaverify/oaverify):
validate requests and responses against an OpenAPI 3.0 / 3.1 / 3.2
document, check spec quality, resolve multi-file specs, report
streaming budgets, and compile standalone validators.

This package ships the `oaverify` binary and nothing else. The library API
lives in
[`@oaverify/core`](https://www.npmjs.com/package/@oaverify/core);
importing from this package will not resolve.

## Install

Try it without installing:

```bash
npx oaverify validate openapi.yaml --path "POST /pets" --body pet.json
```

Or put it on your PATH:

```bash
npm install -g oaverify
```

As a project dev-dependency, for CI checks or build-time validator
generation:

```bash
npm install --save-dev oaverify
```

`compile-schema` and `compile-spec` bundle with esbuild, which is an
optional peer dependency. Install `esbuild` alongside if you use them;
the other commands do not need it.

## Commands

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `validate`       | Check a request, response, or body against the spec          |
| `check`          | Report document conformance, spec hygiene, and schema issues |
| `resolve`        | Stitch a multi-file document and print the result            |
| `stream-check`   | Report the per-operation streaming buffer budget             |
| `compile-spec`   | Emit a standalone HTTP validator module for a whole document |
| `compile-schema` | Emit a standalone validator module for a single JSON Schema  |

Full flags and per-command output shapes are in
[`packages/cli/README.md`](https://github.com/oaverify/oaverify/blob/main/packages/cli/README.md).
The two contracts a CI job or a downstream tool has to build on, the
exit codes and the shape of a `check` finding, are below.

A quick taste. Validation exits `0` when the payload conforms and
non-zero when it does not, so it drops into CI as-is:

```bash
oaverify validate openapi.yaml --path "POST /pets" --body pet.json
oaverify validate openapi.yaml --path "GET /pets/{id}" --body body.json --response --status 200
```

Errors print as a nested tree carrying `code`, `path`, `message`, and
`params`. `params` includes the offending value, so a finding is
self-explanatory without a second lookup:

```json
{
  "code": "enum",
  "path": ["body", "status"],
  "message": "must be one of the allowed values",
  "params": { "allowed": ["open", "closed"], "actual": "pending" }
}
```

Ask which bodies can stream before you ship:

```bash
oaverify stream-check openapi.yaml
```

YAML and JSON both work everywhere a spec is accepted, including specs
fetched over HTTP where the server advertises YAML by `Content-Type`.

## Reading a spec you did not write

A `$ref` is a file read or an outbound HTTP request, and what it names
ends up in the resolved document. Every command that reads a spec takes
two flags that bound how far those reads go.

```bash
oaverify check vendor.yaml --remote-refs same-origin
oaverify check /srv/uploads/tenant-42/openapi.json --untrusted
```

`--remote-refs` governs every http(s) read, **the entry document
included**:

| Value                   | Effect                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `same-origin` (default) | only the origin a remote entry was served from; a local or piped entry opted into none, so nothing remote resolves |
| `allow`                 | any http(s) URI resolves                                                                                           |
| `deny`                  | no http(s) read at all, so a remote entry is refused                                                               |

Pointing the tool at a remote spec is consent to that origin rather than
to one URI, so a sibling file on the same host resolves under
`same-origin`. A hop to another host does not.

The default changed in v7. Before it, any `$ref` to any host resolved,
including from a local entry, which made a spec you did not write able
to direct a request anywhere the machine could reach. `--remote-refs
allow` restores that in one word; see
[docs/migration-v7.md](https://github.com/oaverify/oaverify/blob/main/docs/migration-v7.md).

`--untrusted` treats the document as hostile: file reads confined to the
entry's directory, tighter size and time caps, and `--remote-refs
same-origin` implied. An explicit `--remote-refs` overrides that.

The library makes the same choice by composing readers rather than by
flag. See
[docs/configuration.md](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#resolving-untrusted-specs).

## Exit codes

One taxonomy across every command, rather than a per-command meaning.

| Code | Meaning                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | clean                                                                                                                                      |
| 1    | a domain check failed: validation errors, or findings met the `--fail-on` gate (default `error` for `check`; `--fail-on none` is advisory) |
| 2    | the input could not be read, resolved, or parsed                                                                                           |
| 3    | CLI usage error                                                                                                                            |
| 4    | `check` graded the document and at least one schema is malformed                                                                           |

Exit 2 means there is no report to read on stdout: the file could not
be opened, a `$ref` would not resolve, the YAML would not parse. It
means the same thing in every command that loads a spec. When `check`
aborts partway, any findings the passes had already produced are
written to stderr under the abort message, which is diagnostics rather
than a report: stdout stays empty, so `--format json` never carries a
partial body.

Exit 4 is `check`-only and means the opposite. The document was graded
in full and the report on stdout is complete, but one or more findings
make it uncompilable. Those are reported under the class `malformed`
with the code `malformed-schema`. `check` grades the rest of the
document rather than stopping at the first one, so a run that exits 4
still carries every other finding it could reach. Exit 4 outranks
`--fail-on`: a document that cannot be compiled is not a gate result.

`check` does not vary its exit code by finding class. A single run can
report several classes at once, so the class lives in the output and the
exit code answers only "did this pass".

## The `check --format json` contract

Verbatim output of `oaverify check ./entry.yaml --format json` on a
two-file spec whose defect lives in the referenced file. A stable
interface: the fields below keep their names and meanings;
additions arrive as new fields, and a removal or a change of meaning is
a breaking change of this package.

```json
{
  "findings": [
    {
      "class": "schema",
      "severity": "warning",
      "code": "silent-rewrite/required-not-in-properties",
      "location": "POST /orders request body (application/json) -> <root>",
      "message": "required: \"shipped\" at <root> is not declared in properties reachable here (likely a typo)",
      "target": {
        "pointer": "/components/schemas/Order/required",
        "anchor": "scoped-definition",
        "source": {
          "uri": "order.yaml",
          "pointer": "/components/schemas/Order/required",
          "via": [
            {
              "uri": "./entry.yaml",
              "pointer": "/paths/~1orders/post/requestBody/content/application~1json/schema"
            }
          ]
        }
      }
    }
  ]
}
```

`class` is one of `hygiene`, `schema`, `malformed`, `conformance`,
`examples`, `redos`; `severity` is `warning`, `error` or `fatal`.
`location` is display text: its wording varies by class and is free to
change, so read `target` instead of parsing it.

**`target` addresses the finding, or is absent.** `target.pointer` is an
RFC 6901 pointer into the resolved document, percent-decoded with `~0` /
`~1` retained. It is never best-effort: an external `$ref` target and an
anchor name a schema but no position in the graded document, so those
report no `target` at all rather than an address that goes nowhere.

It addresses the **resolved** document, so it can name a position no
author typed. That is what `target.source` is for. A component reached
across documents keeps its own name (`/components/schemas/Cat/required`,
agreeing with `target.source.pointer`) rather than being copied under a
derived one; specs assembled from several files got that in 5.3.0.

**`target.anchor` says what following the pointer gets you**, which is
what a consumer needs before it edits anything. A closed vocabulary:

| Anchor              | Meaning                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `node`              | The finding's own address. Editing there affects nothing else.                                                                |
| `definition`        | Shared text reached through a `$ref`. Editing there affects every use site.                                                   |
| `scoped-definition` | Shared text, but the finding holds only on the route `location` names, and the definition may be correct for its other users. |

**`target.source` says which file the node was written in**, for a spec
assembled from several. `uri` is the document, `pointer` addresses the
node within it, and `via` is the chain of references the resolver
followed to reach it, outermost first, each hop naming the `$ref` node
itself. An empty `via` means the node was reached in the entry document
without crossing a reference, which is every node of a single-file spec.

The three arrive together or not at all. `source` absent means no source
node corresponds to this one: the container that holds hoisted schemas
and the root extension that stitched externals live under are the
resolver's own, and anything an overlay rewrote or added has no position
in a file to give. Every `uri` is resolved against the spec argument, so
it comes back in the form that argument was given in: `oaverify check
./openapi.yaml` reports `./schemas/order.yaml`, and an absolute path
reports absolute paths.

**Two more fields appear where they apply.** `occurrences` counts how
many operations reported the same defect, when more than one; a
component reached from several operations is one defect and one edit.
`reasons` carries the validator's leaf errors for a rejected value, on
`examples` findings only, so a consumer reads `params.allowed` and
`params.actual` rather than parsing them out of `message`. No two
entries are equal on all four fields, so counting the array counts
distinct defects; a composition that rejects one position twice with
different detail still gives two entries. Each error `code` has a
documented `params` shape: the `BuiltInErrorParams` interface in
`@oaverify/core` is the reference, and `ErrorParamsFor<Code>` narrows it
at the read site.

A defect that both a document pass and a compile pass can see is
reported twice. A `description: null` is the common one, reported by
`conformance/type` and by `schema/annotation-value-type`. Both carry a
`target`, so a consumer recognises the pair by pointer.

Note that `anchor` here is unrelated to the JSON Schema `$anchor` /
`$dynamicRef` sense the `@oaverify/core` README uses.

## SARIF, for code scanning

`--format sarif` emits a SARIF 2.1.0 log, so findings reach GitHub code
scanning, GitLab, editors and security dashboards without adopting a new
workflow:

```yaml
- run: npx oaverify check openapi.yaml --format sarif -o oaverify.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: oaverify.sarif }
```

Three things worth knowing before you wire it up.

**Findings are attributed to a file, not to a line.** SARIF locates a
result with a file plus a line and column region, and oaverify has files
and JSON pointers but not lines. So a finding appears in the security
tab against the right file, and it is not annotated on the diff line.
Emitting line 1 to fill the field would put every finding at the top of
its file, which is worse than leaving it out.

**Run it from the repository root.** Local paths are emitted relative to
the working directory with `uriBaseId: "%SRCROOT%"`, which is how code
scanning matches a result to a file in the checkout. A spec fetched over
HTTP, or a path outside the working directory, gets an absolute URI and
no base, and will not annotate anything.

**`--severity` flows through.** SARIF `level` is taken from the severity
this run reported, so a team's own grading reaches code scanning rather
than the converter applying a policy of its own. SARIF has no `fatal`,
which maps to `error`; the original survives in
`properties."oaverify:severity"`.

Results also carry `partialFingerprints` keyed on the finding's code and
source address, so code scanning tracks a finding across commits and
file moves rather than using its default, which keys on line content and
churns whenever a file is reformatted. The reference chain that reached
a document, if any, is attached as `relatedLocations`.

## Using the library instead

To validate inside your application rather than from a shell:

```bash
npm install @oaverify/core
```

```ts
import { createValidator } from "@oaverify/core";

const validator = createValidator(document);
const result = validator.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});
```

Add [`@oaverify/syntax`](https://www.npmjs.com/package/@oaverify/syntax)
if your specs are YAML; `@oaverify/core` parses JSON only, which is what keeps
it free of runtime dependencies.

For framework wiring there are adapter packages
([`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md),
[`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md),
[`@oaverify/fastify`](https://github.com/oaverify/oaverify/blob/main/packages/oav-fastify/README.md)),
and for bodies too large to buffer there is
[`@oaverify/stream`](https://www.npmjs.com/package/@oaverify/stream).

## See also

- [Top-level `README.md`](https://github.com/oaverify/oaverify/blob/main/README.md): rationale, install matrix, comparison.
- [`docs/strictness.md`](https://github.com/oaverify/oaverify/blob/main/docs/strictness.md): what each `check` class grades, and how severity is decided.
- [`docs/modules.md`](https://github.com/oaverify/oaverify/blob/main/docs/modules.md): what each package and subpath exports.
- [`docs/migration-v7.md`](https://github.com/oaverify/oaverify/blob/main/docs/migration-v7.md): upgrading from 6.x. `--remote-refs` defaults to `same-origin`, and `@oaverify/yaml` is now `@oaverify/syntax`.
- [`docs/migration-v6.md`](https://github.com/oaverify/oaverify/blob/main/docs/migration-v6.md): upgrading from 5.x. Numeric formats now assert, and `check` replaces `--only` with `--findings`.
- [`docs/integration.md`](https://github.com/oaverify/oaverify/blob/main/docs/integration.md): adapter recipes and manual wiring for Next.js, Hono, Bun, Deno.
- [`packages/stream-validator/README.md`](https://github.com/oaverify/oaverify/blob/main/packages/stream-validator/README.md): streaming validation and the buffer-budget analyzer.
