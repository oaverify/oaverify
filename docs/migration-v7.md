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

`combineValidators` reads the body before it knows which member owns
the route, so a member's cap cannot apply and the composite carries its
own `CombineOptions.maxTotalBytes`, same default. Set it to the most
permissive of the members you combine.

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

## Breaking: a rejected Fetch body reports its direction

`validateFetchRequest` / `validateFetchResponse` returned a bare `body`
or `body-too-large` leaf when the reader refused a payload. They now
wrap it in the `request` / `response` branch every other error from
those entry points already carried:

```diff
 // output: "tree"
-{ code: "body-too-large", path: ["body"], params: { limit, reason, bytes } }
+{ code: "request", path: [], params: { method: "POST" }, children: [
+  { code: "body-too-large", path: ["body"], params: { limit, reason, bytes } },
+]}
```

**Flat output is unchanged.** Reshaping collects leaves and drops
branches, so the default result shape, and everything `httpStatusFor`
sees, is exactly what it was. Only `output: "tree"` consumers that read
`result.error.code` for these two verdicts need updating, and the fix
is to read the child.

`combineValidators` and `oaverify compile-spec` output do the same.

The `request` branch omits `pathPattern` here, so
`BuiltInErrorParams["request"]` widens:

```diff
-request: { method: string; pathPattern: string };
+request: { method: string; pathPattern?: string };
```

The body is read during extraction, before routing, so a failure at
that point has no matched template to name. Code reading `pathPattern`
off a `request` branch now has to handle its absence. It is absent
rather than filled with the concrete request path, because a consumer
reading that field expects a template.

### Why

`httpStatusFor` maps `body-too-large` to 413, which reads the failure
as a request. The identical leaf from `validateFetchResponse` means an
upstream overran its own contract, and no status follows from that on
its own: a gateway might answer 502, or 500, or serve stale, or pass
the response through under report-only. Since the library cannot pick
for you, the least it can do is not throw away which direction the
finding came from. `httpStatusFor`'s TSDoc now says it is request-side
and why no response-side sibling is coming.

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

## Breaking: a matrix parameter needs a group naming it

Every `style: matrix` shape now reads the group names in a path
segment. RFC 6570 spells a matrix segment as a run of `;name=value`
groups, where the name says which parameter the group supplies; only
the exploded-array case checked that name, so the other shapes took
whatever they found:

```diff
 // { name: "p", in: "path", style: "matrix", required: true, ... }
 GET /t/;q=1
-valid; the handler receives p = 1
+invalid; missing required path parameter "p"

 // schema: { type: "array", items: { type: "integer" } }, explode: true
 GET /t/;q=1;r=2
-valid; the handler receives p = []
+invalid; missing required path parameter "p"
```

A segment whose groups all name some other parameter now reports the
parameter **absent** rather than reaching your handler as `[]` or as
the foreign group's value. `[]` satisfied both `required: true` and an
unbounded `type: array`, and the unread segment satisfied
`type: string`, so neither of the previous answers rejected reliably.

Two narrower readings change with it, both of which had been handing
values to handlers:

```diff
 GET /t/;p          // {;p} against "", per RFC 6570
-p = "p"
+p = ""

 GET /t/;p=1;p=2    // repeated group against a scalar
-p = "1;p=2"
+p = "1"
```

**A segment carrying no `;` is unaffected.** `GET /t/7` still reads as
`p = 7`, the same tolerance `style: label` gives a missing `.`. Only
segments that use matrix framing are held to the name rule.

### Why

Two accept-invalid defects, both reported in #758 and both traced to
one rule living in two code paths. The exploded-array branch learned
"a group must name this parameter" and `stripStyle`, which every other
matrix shape went through, did not.

Practical exposure is nil: `matrix` is 0 of 61,396 parameter
declarations across 301 published documents, and 0 in the seven large
specs the conformance corpus carries. If you do not declare
`style: matrix`, nothing here reaches you.

## Checklist

- [ ] Replace `@oaverify/yaml` with `@oaverify/syntax` in every manifest.
- [ ] Replace it in every import specifier. No imported name changes.
- [ ] If you pin the CLI, `oaverify` depends on the new name for you.
- [ ] If you use the Fetch adapter and accept bodies over 1 MiB, set
      `maxTotalBytes` to a bound that fits your endpoints. Express and
      Fastify users need nothing.
- [ ] If you construct a complete `HttpStatusMap` literal, add
      `"body-too-large"`. Partial overrides are unaffected.
- [ ] If you read `result.error.code` in tree output for a rejected
      Fetch body, read the child of the `request` / `response` branch.
      Flat output needs nothing.
- [ ] If you read `pathPattern` off a `request` branch, handle its
      absence.
- [ ] If you pass a response-validation result to `httpStatusFor`,
      decide your own policy instead; it is request-side.
- [ ] If a spec you check `$ref`s another host, either add
      `--remote-refs allow` to that command or leave the ref refused.
      Runs that never saw v6's cross-origin notice need nothing.
- [ ] If you declare a `style: matrix` parameter, confirm your clients
      spell the group name (`/t/;p=1`, not `/t/;q=1`). Specs with no
      matrix parameter need nothing.
