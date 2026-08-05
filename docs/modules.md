# Modules

`@oaverify/core` is the library. It publishes a root entry and
five public subpath entrypoints (plus the not-semver-covered
`*/internals` subpaths listed further down).

| Import                        | Surface                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `@oaverify/core`              | `createValidator`, `combineValidators`, error helpers, formatters, types        |
| `@oaverify/core/schema`       | `compileSchema`, dialects, vocabularies, custom keywords, keyword introspection |
| `@oaverify/core/spec`         | `loadSpec`, `loadSpecSync`, `resolveSpec`, `applyOverlays`, `sourceOf`, readers |
| `@oaverify/core/overlay-spec` | `translateOverlay`, `applySpecOverlay`: OpenAPI Overlay 1.0 → typed SpecOverlay |
| `@oaverify/core/formats`      | Built-in format validators, string and numeric                                  |
| `@oaverify/core/core`         | Error tree model, shared OpenAPI / HTTP types                                   |

`@oaverify/core` carries no runtime dependencies and parses JSON only.

## YAML

`@oaverify/yaml` adds the YAML side, in its own package because
it pulls in a parser:

| Export                       | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `createYamlFileReader(cwd?)` | Reader for `.yaml` / `.yml` on disk                               |
| `createSmartHttpReader()`    | HTTP reader handling JSON and YAML, dispatching on `Content-Type` |
| `createYamlStdinReader()`    | Reader for one document on stdin, JSON or YAML                    |
| `parseYamlString(source)`    | Parse a YAML string, for specs loaded out of band                 |
| `loadSpecSync(options)`      | Synchronous loader whose default reader covers YAML and JSON      |

Compose the readers ahead of the JSON-only ones from
`@oaverify/core/spec`, which act as the fallback. Calling
`@oaverify/core`'s `createFileReader()` on a `.yaml` path throws with an
install hint pointing here.

`loadSpecSync` exists in both packages: `@oaverify/core/spec`'s is JSON-only,
`@oaverify/yaml`'s default reader covers both, so a `.yaml` entry
loads with no composition.

## Spec checking

`@oaverify/check` is the composed document check behind `oaverify
check`, in its own package because the ReDoS pass depends on
`redos-detector` (~1MB unpacked) and npm installs a dependency whichever
entry imports it. Behind a `@oaverify/core` subpath that weight would
reach every `@oaverify/core` consumer.

| Export                                       | Purpose                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `checkSpec(resolved, options?)`              | Every selected pass over a `ResolvedSpec`, graded into `CheckFinding[]` |
| `CheckFinding`, `FindingTarget`              | What a finding is, and how it addresses the document                    |
| `CHECK_CLASSES`, `CHECK_SEVERITIES`          | The classes a run selects, and the severity ranking                     |
| `CheckCode`, `CHECK_CODES`                   | Every code a run can emit, as a type and as a set                       |
| `DEFAULT_SEVERITY`, `severityFor`            | oaverify's grading, and how a regrading is applied                      |
| `parseSeverityMap(entries)`                  | The `key=level` grammar the CLI spells `--severity`                     |
| `parseFindingKey(key)`                       | One key resolved to a code, family or class; shared by the two below    |
| `parseSkipKeys(entries)`, `applySkip`        | The key list the CLI spells `--skip`, and the filter plus its report    |
| `renderSarif(findings, options)`             | SARIF 2.1.0, for code scanning; `options.classes` is required           |
| `checkDocumentFormats`, `checkDocumentRedos` | The two passes that have no other home                                  |

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

`loadSpec` (async) requires an explicit `reader`; `loadSpecSync`
defaults to a JSON-only filesystem one. Compose in `@oaverify/yaml`'s
readers for a YAML entry.

Loading stays with the caller, which is why the package has no reader
and no second copy of `loadSpec`. See
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

Each public package also exposes lower-level primitives behind a
`/internals` path. They exist for advanced plugins, tooling, and
tests, and sit deliberately outside the semver contract: compare
against the public barrel before reaching for them.

| Import                               | Surface                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@oaverify/core/schema/internals`    | Codegen mechanics, runtime helpers, and resolve internals below the keyword-author API            |
| `@oaverify/core/spec/internals`      | Synchronous resolver primitives (`resolveSpecSync`, `createFileReaderSync`, `composeReadersSync`) |
| `@oaverify/core/validator/internals` | Parameter deserialization, query assembly, and the operation-level `$ref` resolver                |

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
