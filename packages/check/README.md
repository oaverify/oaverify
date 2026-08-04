# @oaverify/check

The composed OpenAPI document check behind `oaverify check`, as a
library.

Five passes run over a resolved spec, their findings are normalised into
one list, and each is graded by consequence. The CLI is a renderer over
this package: anything `oaverify check` prints, a caller here can
compute.

Reach for it when you want spec checks inside something that is already
a program: a build script, a test, a CI step that wants findings rather
than an exit code, a service that lints uploaded specs.

```bash
npm install @oaverify/check @oaverify/core
```

## Usage

```ts
import { loadSpecSync } from "@oaverify/core/spec";
import { checkSpec } from "@oaverify/check";

const resolved = loadSpecSync({ entry: "openapi.json", provenance: true });
const findings = checkSpec(resolved);

for (const finding of findings) {
  console.log(`${finding.severity}\t${finding.code}\t${finding.location}`);
}
```

`checkSpec` is synchronous, so with `loadSpecSync` the whole check is.
Loading stays with you either way, which is why this package ships no
reader and no second copy of the loaders.

For a spec that is fetched over HTTP, or written in YAML, load it
asynchronously and compose the readers you need. `loadSpec` requires an
explicit reader; `loadSpecSync` defaults to a JSON-only filesystem one:

```ts
import { loadSpec, composeReaders, createFileReader } from "@oaverify/core/spec";
import { createYamlFileReader } from "@oaverify/yaml";

const resolved = await loadSpec({
  reader: composeReaders([createYamlFileReader(), createFileReader()]),
  entry: "openapi.yaml",
  provenance: true,
});
const findings = checkSpec(resolved);
```

### Load with `provenance: true`

`checkSpec` takes a `ResolvedSpec` rather than a bare document, because
two of its inputs are byproducts of resolution and cannot be recovered
from the document alone: the regions each finding's `target.source` is
derived from, and the `inlinedComponents` list that stops the hygiene
pass reporting a component an external `$ref` inlined.

Without `provenance: true` the check still runs and finds exactly the
same defects, but every finding's `target.source` is absent and SARIF
output carries no `locations`. See the TSDoc on `FindingTarget.source`
for how to tell that case from a finding whose node genuinely has no
source.

## What it finds

Five classes, selected with `only`:

| Class         | What it asks                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `hygiene`     | Unused components, tags and `$defs`; path-parameter mismatches                                     |
| `schema`      | Did oaverify understand your schemas? Unknown keywords, silent rewrites, unsatisfiable constraints |
| `conformance` | Is the document legal OpenAPI for the version it declares?                                         |
| `examples`    | Does each `example` validate against the schema it sits beside?                                    |
| `redos`       | Can a `pattern` be made to backtrack catastrophically?                                             |

Findings are additionally reported under a sixth class, `malformed`, for
a schema that will not compile at all. It cannot be selected, because it
is found by compiling, which is what the `schema` class does.

```ts
checkSpec(resolved, { only: ["hygiene", "conformance"] });
```

## Grading, and disagreeing with it

Every finding carries a `severity` of `"warning"`, `"error"` or
`"fatal"`, from `DEFAULT_SEVERITY`. That grading is oaverify's judgement
about consequence, and you may reasonably disagree:

```ts
import { checkSpec, parseSeverityMap } from "@oaverify/check";

// A class, a code family, and one exact code. Most specific wins.
const severity = parseSeverityMap(["redos=error,unsatisfiable/*=error,unused-tag=warning"]);
const findings = checkSpec(resolved, { severity });
```

`parseSeverityMap` is the string grammar the CLI spells `--severity`,
useful when the regrading comes out of a config file. `SeverityMap` is
the semantics; build one directly if you have no string to parse.

`malformed` findings are always `fatal` and cannot be remapped.

## SARIF

```ts
import { renderSarif } from "@oaverify/check";

await writeFile("check.sarif", renderSarif(findings, { version: "1.2.3" }));
```

SARIF 2.1.0, for GitHub code scanning, GitLab, editors and security
dashboards. Locations come from `target.source`, so upload a run
produced from a spec loaded with `provenance: true`, and run from the
repository root so paths are relative to the checkout.

## Node only

This package formats file addresses, so it uses `node:path` and
`node:url` and does not run in a browser. `@oaverify/core` itself has no
such constraint.

## Why a package rather than a `@oaverify/core` subpath

Two reasons, and the second is the binding one.

The existing `@oaverify/core` subpaths (`/schema`, `/spec`, `/formats`,
`/core`, `/overlay-spec`) are all parts of core, so a `/check` subpath
would read as one and is not.

More concretely, the ReDoS pass uses `redos-detector`, which is about
1MB unpacked. npm installs a dependency whichever entry imports it, so a
`@oaverify/core/check` subpath would land that on every
`@oaverify/core` consumer and break core's zero-runtime-dependency
claim. The weight goes here instead.

## License

MIT
