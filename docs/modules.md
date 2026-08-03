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
| `@oaverify/core/formats`      | Built-in string format validators                                               |
| `@oaverify/core/core`         | Error tree model, shared OpenAPI / HTTP types                                   |

`@oaverify/core` carries no runtime dependencies and parses JSON only.

## YAML

`@oaverify/yaml` adds the YAML side, in its own package because
it pulls in a parser:

| Export                       | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `createYamlFileReader(cwd?)` | Reader for `.yaml` / `.yml` on disk                               |
| `createSmartHttpReader()`    | HTTP reader handling JSON and YAML, dispatching on `Content-Type` |
| `parseYamlString(source)`    | Parse a YAML string, for specs loaded out of band                 |
| `loadSpecSync(options)`      | Synchronous loader whose default reader covers YAML and JSON      |

Compose the readers ahead of the JSON-only ones from
`@oaverify/core/spec`, which act as the fallback. Calling
`@oaverify/core`'s `createFileReader()` on a `.yaml` path throws with an
install hint pointing here.

`loadSpecSync` exists in both packages: `@oaverify/core/spec`'s is JSON-only,
`@oaverify/yaml`'s default reader covers both, so a `.yaml` entry
loads with no composition.

## The CLI

`oaverify` ships the `oaverify` binary and no library exports. See
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
