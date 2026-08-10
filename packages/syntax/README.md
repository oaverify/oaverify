# @oaverify/syntax

Syntax support for [`@oaverify/core`](https://github.com/oaverify/oaverify).

`@oaverify/core` parses JSON only, so it can advertise zero runtime
dependencies. The parsers live here instead. For YAML: filesystem readers for
`.yaml` / `.yml`, an HTTP reader that dispatches on `Content-Type`, a
standalone string parser, and a synchronous loader whose default reader
handles both YAML and JSON.

```bash
npm install @oaverify/core @oaverify/syntax
```

If you use the CLI, you already have this: `oaverify` depends on
it.

## Loading a YAML spec

`loadSpecSync` is the short path. Its default reader covers YAML and
JSON from disk, so nothing needs composing:

```ts
import { createValidator } from "@oaverify/core";
import { loadSpecSync } from "@oaverify/syntax";

const { document } = loadSpecSync({ entry: "openapi.yaml" });
const validator = createValidator(document);
```

For the async path, compose the readers yourself. Order the YAML reader
ahead of the JSON-only one from `@oaverify/core`, so JSON acts as the
fallback:

```ts
import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/syntax";

const reader = composeReaders([createYamlFileReader(), createFileReader()]);
const { document } = await loadSpec({ reader, entry: "openapi.yaml" });
```

## Fetching a spec over HTTP

`createSmartHttpReader` claims any `http:` / `https:` URI and picks a
parser by response `Content-Type`, falling back to the URL extension
when the header is ambiguous. That covers the common case of a server
publishing YAML at an extensionless path:

```ts
import { composeReaders, createFileReader } from "@oaverify/core/spec";
import { createSmartHttpReader } from "@oaverify/syntax";

const reader = composeReaders([createSmartHttpReader(), createFileReader()]);
const { document } = await loadSpec({ reader, entry: "https://api.example.com/openapi" });
```

It handles JSON as well as YAML, so it replaces `@oaverify/core`'s
`createHttpReader` in the chain rather than sitting alongside it.

## Reader controls

The YAML readers mirror the file and HTTP reader options from
`@oaverify/core/spec`. Use `confine` on `createYamlFileReader` for
untrusted local specs, and apply the same `allowUri`, `redirects`,
`timeoutMs`, and `maxBytes` controls to `createSmartHttpReader` that you
would apply to `createHttpReader`. See the
[reader-controls recipe](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#resolving-untrusted-specs);
the option contracts are the TSDoc on `FileReaderOptions` and
`HttpReaderOptions`.

## Parsing a string

For sources that never touch a reader (an inlined spec, a database
column, a spec fetched by your own client):

```ts
import { createValidator, type OpenAPIDocument } from "@oaverify/core";
import { parseYamlString } from "@oaverify/syntax";

const document = parseYamlString(source) as OpenAPIDocument;
const validator = createValidator(document);
```

## Exports

| Export                       | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `createYamlFileReader(cwd?)` | async `DocumentReader` for `.yaml` / `.yml` on disk         |
| `createSmartHttpReader()`    | async `DocumentReader` for `http:` / `https:`, YAML or JSON |
| `parseYamlString(source)`    | parse a YAML string to `unknown`                            |
| `loadSpecSync(options)`      | synchronous loader defaulting to a YAML + JSON reader       |

The contract for each is the TSDoc on the export. See
[`DocumentReader`](https://github.com/oaverify/oaverify/blob/main/packages/spec/src/reader.ts)
for the reader interface if you are writing your own.

## License

MIT
