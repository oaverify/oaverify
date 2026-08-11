# Migrating to v7

## Breaking: `@oaverify/yaml` is now `@oaverify/syntax`

The package that carries the parsers is named for what it does rather
than for the first syntax it carried. Nothing it exports changed, so the
migration is the specifier and nothing else:

```bash
npm uninstall @oaverify/yaml
npm install @oaverify/syntax
```

```diff
-import { createYamlFileReader, loadSpecSync } from "@oaverify/yaml";
+import { createYamlFileReader, loadSpecSync } from "@oaverify/syntax";
```

`createYamlFileReader`, `createYamlStdinReader`, `createSmartHttpReader`,
`parseYamlString`, `loadSpecSync`, `FileReaderOptions` and
`HttpReaderOptions` all keep their names and their behaviour. The
YAML-specific ones stay YAML-specific; a reader for another syntax would
be a new export beside them.

There is no compatibility package. `@oaverify/yaml` stops at 6.x and is
deprecated on npm; installs of the old name keep working and stop
receiving updates.

`@oaverify/core` is unaffected and still parses JSON only. The source
address and span contracts (`SourceAddress`, `SourceSpan`, `SourceText`,
`SourceSyntax`, `createSourceSpanResolver`) live there, and
`@oaverify/syntax` implements them for a given syntax. That split is why
the package is not called `@oaverify/source`.

## Breaking: the Fetch adapter caps body reads at 1 MiB

`validateFetchRequest`, `validateFetchResponse`, `httpRequestFromFetch`,
`httpResponseFromFetch` and `readBodyFromFetch` now refuse a body over
`maxTotalBytes`, which defaults to 1 MiB. Before this they read until
the stream ended.

Only the Fetch adapter changes. The Express and Fastify adapters read a
body their framework's parser already bounded, and are unaffected.

```diff
-const validator = createValidator(spec);
+// Restore the previous unbounded read:
+const validator = createValidator(spec, { maxTotalBytes: Number.POSITIVE_INFINITY });
+
+// Or, more usefully, pick a bound that fits your endpoints:
+const validator = createValidator(spec, { maxTotalBytes: 10 * 1024 * 1024 });
```

An over-cap body is a verdict rather than a throw, so a caller that
already handles invalid requests needs no new code path. It surfaces as
a `body-too-large` leaf at `["body"]`, which `httpStatusFor` maps to
413:

```ts
{ code: "body-too-large", path: ["body"],
  params: { limit: 1048576, reason: "read", bytes: 1048577 } }
```

`reason` distinguishes the two enforcement points: `"declared"` means
`bytes` came from the request's `Content-Length`, and `"read"` means it
is a count taken while draining the stream. The extraction helpers throw
`FetchBodyTooLargeError` instead, alongside the existing
`FetchBodyParseError`.

Two smaller consequences:

- `HttpStatusMap` gained a `"body-too-large"` field. Overrides are
  `Partial`, so only code constructing a complete `HttpStatusMap`
  literal needs updating.
- A custom `readBody` callback still receives the original `Request` and
  is not bounded by this. Delegate to `readBodyFromFetch` with the same
  option to inherit the cap.

### Why

Express and Fastify users bound bodies at the parser
(`express.json({ limit })`) before the validator sees them. A Fetch
handler has no such layer: Next.js App Router, Hono, `Bun.serve` and
`Deno.serve` hand the handler a `Request` whose body is an unread
stream, and the adapter is what drains it. Defaulting the cap off would
have left that read unbounded for everyone who did not read the release
notes, which is the population the change is for.

## Breaking: the CLI refuses cross-origin remote `$ref`s by default

`--remote-refs` defaults to `same-origin` instead of `allow`.

| Entry                                  | What resolves               |
| -------------------------------------- | --------------------------- |
| local, or piped on stdin               | nothing over the network    |
| `https://api.example.com/openapi.json` | that origin's own documents |

Pointing the tool at a remote spec is consent to that origin rather than
to one URI, so `https://api.example.com/schemas/pet.json` still
resolves: whoever served the entry already controls it. What the consent
does not cover is the entry hopping to another host.

### Why

The CLI composes an http reader for every command, so before this a
local spec carrying

```yaml
$ref: "http://169.254.169.254/latest/meta-data/"
```

fetched that URL and hoisted the response into the resolved document.
The tool exists to check documents you did not write, which is exactly
the case where a document should not be able to choose what your machine
requests.

### Restoring the old behaviour

```bash
oaverify check vendor.yaml --remote-refs allow
```

That is the whole migration. The flag shipped in v6 and already accepted
this value, so nothing is renamed, deprecated, or shimmed. If you set
`--remote-refs` explicitly today, nothing changes for you.

### How to tell whether this affects you

v6 printed a notice on stderr after any run that resolved a cross-origin
`$ref` under the default posture:

```
check: resolved 3 cross-origin $refs over the network. A future major
refuses cross-origin refs by default; ...
```

If you never saw it, this release changes nothing about your runs. v7
drops the notice, since the behaviour it announced is now the default.

A refusal names the posture and what was opted into, so a run that does
break says why:

```
https://elsewhere.example/x.json: refused by --remote-refs same-origin
(the entry's origin is https://api.example.com)
```

### Unaffected

The library composes no reader you did not ask for, so `loadSpec`,
`loadSpecSync` and `createValidator` are unchanged. This is a CLI
default, and `--untrusted` already implied `same-origin`.

## Checklist

- [ ] Replace `@oaverify/yaml` with `@oaverify/syntax` in every manifest.
- [ ] Replace it in every import specifier. No imported name changes.
- [ ] If you pin the CLI, `oaverify` depends on the new name for you.
- [ ] If you use the Fetch adapter and accept bodies over 1 MiB, set
      `maxTotalBytes` to a bound that fits your endpoints. Express and
      Fastify users need nothing.
- [ ] If you construct a complete `HttpStatusMap` literal, add
      `"body-too-large"`. Partial overrides are unaffected.
- [ ] If a spec you check `$ref`s another host, either add
      `--remote-refs allow` to that command or leave the ref refused.
      Runs that never saw v6's cross-origin notice need nothing.
