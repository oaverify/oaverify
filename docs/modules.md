# Modules

`@oaverify/core` is the library. It publishes a root entry and
five public subpath entrypoints (plus the not-semver-covered
`*/internals` subpaths listed further down).

| Import                        | Surface                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@oaverify/core`              | `createValidator`, `combineValidators`, error helpers, formatters, types                                    |
| `@oaverify/core/schema`       | `compileSchema`, dialects, vocabularies, custom keywords, keyword introspection                             |
| `@oaverify/core/spec`         | `loadSpec`, `loadSpecSync`, `resolveSpec`, `applyOverlays`, `sourceOf`, `createSourceSpanResolver`, readers |
| `@oaverify/core/overlay-spec` | `translateOverlay`, `applySpecOverlay`: OpenAPI Overlay 1.0 → typed SpecOverlay                             |
| `@oaverify/core/formats`      | Built-in format validators, string and numeric                                                              |
| `@oaverify/core/core`         | Error tree model, shared OpenAPI / HTTP types                                                               |

`@oaverify/core` carries no runtime dependencies and parses JSON only.

## Syntax

`@oaverify/syntax` carries the parsers, in its own package so
`@oaverify/core` stays dependency-free. The readers are YAML; the span
backends cover both syntaxes:

| Export                       | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `createYamlFileReader(cwd?)` | Reader for `.yaml` / `.yml` on disk                                       |
| `createSmartHttpReader()`    | HTTP reader handling JSON and YAML, dispatching on `Content-Type`         |
| `createYamlStdinReader()`    | Reader for one document on stdin, JSON or YAML                            |
| `parseYamlString(source)`    | Parse a YAML string, for specs loaded out of band                         |
| `loadSpecSync(options)`      | Synchronous loader whose default reader covers YAML and JSON              |
| `createYamlSpanBackend()`    | Line and column for a YAML source address, for `createSourceSpanResolver` |
| `createJsonSpanBackend()`    | The same for a JSON source address                                        |

Compose the readers ahead of the JSON-only ones from
`@oaverify/core/spec`, which act as the fallback. Calling
`@oaverify/core`'s `createFileReader()` on a `.yaml` path throws with an
install hint pointing here.

`loadSpecSync` exists in both packages: `@oaverify/core/spec`'s is JSON-only,
`@oaverify/syntax`'s default reader covers both, so a `.yaml` entry
loads with no composition.

## Source spans

`sourceOf` gives a finding's address: which document, and which node
within it. `createSourceSpanResolver` turns that address into a line
and column, and it is a separate call because the two absences differ:
no address means no source node corresponds, while no span means no
text was supplied or no backend handles that syntax.

The resolver carries no parser. It takes the document text from the
caller, through a `SourceTextProvider`, and the parsers from whichever
`SpanBackend` implementations the caller wires;
`@oaverify/syntax` exports `createYamlSpanBackend()` and
`createJsonSpanBackend()`. Requests are
resolved in a batch, grouped by URI, so a document is parsed once
however many findings name it. See the TSDoc on
`createSourceSpanResolver` for the contract, including what the caller
promises when it supplies text.

## Spec checking

`@oaverify/check` is the composed document check behind `oaverify
check`, in its own package because the ReDoS pass depends on
`redos-detector` (~1MB unpacked), weight a `@oaverify/core` subpath
would push onto every core consumer.

| Export                                                  | Purpose                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `checkSpec(resolved, options?)`                         | Every selected pass over a `ResolvedSpec`, graded into `CheckFinding[]`               |
| `CheckFinding`, `FindingTarget`                         | What a finding is, and how it addresses the document                                  |
| `CHECK_CLASSES`, `CHECK_SEVERITIES`                     | The classes a run selects, and the severity ranking                                   |
| `CheckCode`, `CHECK_CODES`                              | Every code a run can emit, as a type and as a set                                     |
| `DEFAULT_SEVERITY`, `severityFor`                       | oaverify's grading, and how a regrading is applied                                    |
| `parseSeverityMap(entries)`                             | The `key=level` grammar the CLI spells `--severity`                                   |
| `parseFindingKey(key)`                                  | One key resolved to a code, family or class; shared by the two below                  |
| `parseFindingTerms(value)`, `resolveFindingSelection`   | The term grammar the CLI spells `--findings`, resolved to what runs and what survives |
| `parseSkipKeys(entries)`, `applySkip`                   | A key list and the filter plus its report; what `--findings` exclusions resolve to    |
| `renderSarif(findings, options)`                        | SARIF 2.1.0, for code scanning; `options.classes` is required                         |
| `spanRequestsFor(findings)`, `spanFor(finding, spanOf)` | Every position a report needs, in one batch, and a finding's own span back out        |
| `locatedReasonsFor(finding, spanOf)`                    | One located item per sub-rejection of a finding, over that same batch                 |
| `reasonTargetFor(code)`                                 | Where a reason's ruling applies: its own path, or the value containing it             |
| `checkDocumentFormats`, `checkDocumentRedos`            | The two passes that have no other home                                                |

Positions come from the caller rather than from the findings. Pass
`spanRequestsFor(findings)` to a `SourceSpanResolver`, close over the
answers, and hand that lookup to `renderSarif` as `spanOf`; one batch
covers every position in the report (and, per the batching above, one
parse per document).

`locatedReasonsFor` is that path for a consumer other than SARIF. An
example that fails its schema in several places carries one
`RejectionReason` per place, and this resolves each to a source span, so
an editor can point at them one at a time instead of showing a joined
sentence. Which reasons get one, and why a `required` reason is located
at the value containing the member rather than at the member it names,
is on `reasonTargetFor`.

`checkSpec` takes a resolved spec rather than a document, because two of
its inputs are byproducts of resolution: the regions each finding's
`target.source` comes from, and the `inlinedComponents` list the hygiene
pass needs. Load with `provenance: true` for source attribution and
SARIF locations; without it, `target.source` is absent on every finding.

```ts
import { loadSpecSync } from "@oaverify/core/spec";
import { checkSpec } from "@oaverify/check";

const resolved = loadSpecSync({ entry: "openapi.json", provenance: true });
for (const finding of checkSpec(resolved)) {
  console.log(finding.severity, finding.code, finding.location);
}
```

Loading stays with the caller, which is why the package ships no reader
and no second copy of `loadSpec`. `loadSpec` (async) requires an
explicit `reader`; `loadSpecSync` defaults to a JSON-only filesystem
one, so compose in `@oaverify/syntax`'s readers for a YAML entry. See
[`packages/check/README.md`](../packages/check/README.md).

## Streaming

`@oaverify/stream` is the push-based streaming engine
(`createStreamValidator`, `streamValidatorForOperation`) plus the
streamability analyzer (`analyzeStreamability`, `analyzeSpec`),
published standalone. See
[`packages/stream-validator/README.md`](../packages/stream-validator/README.md).

## The CLI

`oaverify` ships the `oaverify` binary and no library exports. Its
`check` command is a renderer over `@oaverify/check`: text output, exit
codes and flag parsing are the CLI's, everything it reports is
`checkSpec`'s. See
[`packages/cli/README.md`](../packages/cli/README.md) for commands and
flags.

## Internal subpaths (not covered by semver)

`@oaverify/core` exposes lower-level primitives behind three
`/internals` paths (`./schema/internals`, `./spec/internals`,
`./validator/internals`); no other published package has one. They exist for advanced plugins, tooling, and
tests, and sit deliberately outside the semver contract: compare
against the public barrel before reaching for them.

| Import                               | Surface                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@oaverify/core/schema/internals`    | Codegen mechanics, runtime helpers, and resolve internals below the keyword-author API            |
| `@oaverify/core/spec/internals`      | Synchronous resolver primitives (`resolveSpecSync`, `createFileReaderSync`, `composeReadersSync`) |
| `@oaverify/core/validator/internals` | Parameter deserialization primitives, query assembly, and the shared document traversal           |

## The emitted-output runtime (semver-covered)

`@oaverify/core/codegen-runtime` is the one lower-level subpath that IS
semver-covered: `oaverify compile-spec` writes the specifier into the
consumer's generated module, so its members are load-bearing in files
this repo does not control, and a member leaves only across a major,
together with the emitter. Membership is mechanical (exactly what
emitted output imports); the module header in
`packages/validator/src/codegen-runtime.ts` has the contract.

## Companion adapter packages

Per-framework adapter packages share the same export names and option
shapes as each other; only the framework-typed argument differs. Each
has its own README:

- [`@oaverify/express4`](../packages/oav-express4/README.md): Express 4 (peer: `express ^4`).
- [`@oaverify/express5`](../packages/oav-express5/README.md): Express 5 (peer: `express ^5`); promise-native middleware shape.
- [`@oaverify/fastify`](../packages/oav-fastify/README.md): Fastify (peer: `fastify ^5`); ships a `preValidation` hook instead of middleware.

For Next.js, Hono, Bun, and Deno, use the Web Standards adapter
(`httpRequestFromFetch`, `validateFetchRequest`) directly; no
framework-specific package. See
[`docs/integration.md`](./integration.md).

The `httpRequestFrom*` family is not shape-uniform across the
boundary: the Fetch variant is async and returns
`{ httpRequest, body }` (it reads the body stream), while the
framework variants (`httpRequestFromExpress`,
`httpRequestFromFastify`) are sync and return a bare `HttpRequest`.
`httpResponseFromFetch` has no framework sibling by design: the
Express and Fastify adapters intercept responses inside
`validateResponses` (a `res.send` wrap / `onSend` hook), so a
standalone response extractor exists only for the Fetch world,
where responses are first-class values.
