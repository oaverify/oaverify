# Migrating to v7

Seven breaking changes, and most callers meet one: `@oaverify/yaml` is
renamed to `@oaverify/syntax`, which is a specifier swap with no
imported name changing. The rest are scoped. Two apply only to the
Fetch adapter (bodies are capped at 1 MiB, and a rejected body now
reports its direction), two only to the CLI (cross-origin remote
`$ref`s are refused by default, and `--format flat` is gone), one only
to `style: matrix` parameters, and one removes three field aliases
deprecated in v6.

If you use the library with Express or Fastify and read no `check`
findings, the upgrade is the rename and nothing else.

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
`HttpReaderOptions` all keep their names and their behaviour.

There is no compatibility package. `@oaverify/yaml` stops at 6.x and is
deprecated on npm; installs of the old name keep working and stop
receiving updates.

`@oaverify/core` is unaffected and still parses JSON only. The source
address and span contracts (`SourceAddress`, `SourceSpan`, `SourceText`,
`SourceSyntax`, `createSourceSpanResolver`) stay there;
`@oaverify/syntax` implements them for a given syntax.

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
stream, and the adapter is what drains it. An off-by-default cap would
protect only the people who read the release notes.

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
upstream overran its own contract, and no status follows from that: a
gateway might answer 502, serve stale, or pass the response through
under report-only. The library cannot pick for you, so it keeps the
direction rather than discarding it. `httpStatusFor`'s TSDoc now says
it is request-side and why no response-side sibling is coming.

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

The flag shipped in v6 and already accepted this value, so nothing is
renamed, deprecated, or shimmed. If you set `--remote-refs` explicitly
today, nothing changes for you.

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

Two accept-invalid defects, reported in #758, both from one rule that
only ever reached one of the two code paths that needed it.

Practical exposure is nil: `matrix` is 0 of 61,396 parameter
declarations across 301 published documents, and 0 in the seven large
specs the conformance corpus carries. If you do not declare
`style: matrix`, nothing here reaches you.

## Breaking: three deprecated field aliases are removed

Each was renamed in v6, kept alongside its replacement carrying the
same value, and documented as "removed in the next major". This is that
major.

| Type                | Removed    | Read instead |
| ------------------- | ---------- | ------------ |
| `ConformanceIssue`  | `location` | `pointer`    |
| `SchemaLintIssue`   | `context`  | `location`   |
| `PrecompileFailure` | `context`  | `location`   |

```diff
 // oaverify check / checkDocumentConformance
-issue.location   // an RFC 6901 pointer, despite the name
+issue.pointer

 // validator.stats.schemaLintIssues
-issue.context
+issue.location

 // validator.precompile({ onMalformed: "collect" })
-failure.context
+failure.location
```

The values are unchanged, so every replacement is a rename at the read
site and nothing else.

### Why

This library reserves `pointer` for a machine-readable document address
and `location` for human-readable prose. `ConformanceIssue.location`
predated that rule and held a pointer, so it moved to `pointer`; the
`context` fields held prose, so they moved to `location`. Keeping the
aliases meant `location` naming a pointer on one type and prose on two
others, which is the ambiguity the rename existed to end.

## Breaking: `--format flat` is removed

`oaverify validate --format flat` is now a usage error (exit 3,
`unknown format: flat`). Use `--format summary`, which it has been an
alias of since 3.8.0:

```diff
-oaverify validate openapi.yaml --path "POST /pets" --body pet.json --format flat
+oaverify validate openapi.yaml --path "POST /pets" --body pet.json --format summary
```

Output is byte-identical, so this is a flag edit and nothing else. The
name has not appeared in `--format`'s help text since 3.8.0, so a run
that was written against the help is already using `summary`.

`OutputFormat` narrows to `"text" | "json" | "summary"` with it, and
`isOutputFormat("flat")` now returns `false`.

### Why

Same reason as the three above: one word naming two things. `"flat"`
named a rendering style (one line per leaf) with the word
`ValidatorOptions.output: "flat"` uses for an unrelated result shape
(an errors list rather than a tree). `"summary"` names the renderer
behind it, `formatSummary`.

The alias was documented as "kept for one major" when it shipped in
3.8.0, which made 4.0.0 its window. It outlasted three majors instead,
the same way the four aliases v5 swept did.

## Breaking: repeatable CLI flags take one value each

`--overlay`, `--severity` and `--only` were declared variadic, so each
consumed every following argument until the next `-`. Repeat the flag
instead of listing values after it:

```diff
-oaverify compile-spec petstore.yaml --only "POST /pets" "GET /pets/{id}"
+oaverify compile-spec petstore.yaml --only "POST /pets" --only "GET /pets/{id}"
```

`--severity` also takes a comma-separated list in one value, which is
unchanged and is what its help text has always shown:

```
oaverify check spec.yaml --severity 'unsatisfiable/*=error,redos=error'
```

All three are affected, `--overlay` included. It already carried a
repeat collector and the CLI README already described it as repeatable,
but the variadic marker also _accepted_ the space-separated form, and
that form now exits 3:

```
$ oaverify resolve spec.json --overlay base.yaml prod.yaml
error: too many arguments for 'resolve'. Expected 1 argument but got 2
```

The failure is loud rather than silent: commander rejects the excess
argument instead of dropping it, so a pipeline that passes values this
way stops rather than quietly applying one overlay.

### Why

A variadic option swallows the positional that follows it, so the
natural flag-first invocation was a usage error:

```
$ oaverify check --severity 'example-invalid=error' spec.yaml
error: missing required argument 'spec'
```

```
$ oaverify compile-spec --only "GET /pets" petstore.yaml
error: --only expects "METHOD PATH" (space-delimited), got "petstore.yaml"
```

Both exited 3. Nothing in-tree caught it because every doc and every
test happened to write the spec before the flag, which is the order that
still works. `--findings` was already non-variadic and worked in either
position; these three now match it.

## Checklist

- [ ] Replace `@oaverify/yaml` with `@oaverify/syntax` in every manifest
      and every import specifier. No imported name changes.
- [ ] If you use the Fetch adapter and accept bodies over 1 MiB, set
      `maxTotalBytes` to a bound that fits your endpoints.
- [ ] If you construct a complete `HttpStatusMap` literal, add
      `"body-too-large"`. Partial overrides are unaffected.
- [ ] If you read `result.error.code` in tree output for a rejected
      Fetch body, read the child of the `request` / `response` branch.
- [ ] If you read `pathPattern` off a `request` branch, handle its
      absence.
- [ ] If you pass a response-validation result to `httpStatusFor`,
      decide your own policy instead; it is request-side.
- [ ] If a spec you check `$ref`s another host, either add
      `--remote-refs allow` to that command or leave the ref refused.
- [ ] If you declare a `style: matrix` parameter, confirm your clients
      spell the group name (`/t/;p=1`, not `/t/;q=1`).
- [ ] Replace `ConformanceIssue.location` with `.pointer`, and
      `SchemaLintIssue.context` / `PrecompileFailure.context` with
      `.location`.
- [ ] Replace `--format flat` with `--format summary` wherever you
      invoke `oaverify validate`. Output is unchanged.
- [ ] If you pass more than one value to a single `--only`, `--overlay`
      or `--severity` flag, repeat the flag instead. All three exit 3 on
      the space-separated form now.
