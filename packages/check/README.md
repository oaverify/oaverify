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
import { createYamlFileReader } from "@oaverify/syntax";

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

Five classes, selected through `findings`:

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
import { checkSpec, selectionForClasses } from "@oaverify/check";

checkSpec(resolved, { findings: selectionForClasses(["hygiene", "conformance"]) });
```

`findings` takes a `FindingSelection`, which reaches an exact code or a
family as well as a class, so `selectionForClasses` is the shorthand for
the class-only case. The CLI's `--findings` resolves to the same type.

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
import { CHECK_CLASSES, renderSarif } from "@oaverify/check";

const sarif = renderSarif(findings, { version: "1.2.3", classes: CHECK_CLASSES });
await writeFile("check.sarif", sarif);
```

SARIF 2.1.0, for GitHub code scanning, GitLab, editors and security
dashboards. Locations come from `target.source`, so upload a run
produced from a spec loaded with `provenance: true`, and run from the
repository root so paths are relative to the checkout.

`classes` names the classes the run selected and has no default: the
log asserts it as `oaverify:classes` so a consumer can tell a partial
run from a clean document. Pass the same list you gave `checkSpec` as
`only`, or `CHECK_CLASSES` for a full run.

## Your own rules

There is no rule loader, and `oaverify check` runs its built-in passes
only. A rule of your own composes here instead:

```ts
import { CHECK_CLASSES, checkSpec, renderSarif, severityFor } from "@oaverify/check";

const findings = [...checkSpec(resolved), ...houseRules(resolved)];
const graded = findings.map((f) => ({ ...f, severity: severityFor(severity, f, "warning") }));
const sarif = renderSarif(graded, { version: "1.2.3", classes: CHECK_CLASSES });
```

One array, one grading, one SARIF document. `houseRules` is a plain
function over the `ResolvedSpec`: `resolveJsonPointer` and `sourceOf`
come from `@oaverify/core/spec`, `walkSubschemas` from
`@oaverify/core/schema`. `CheckFinding["code"]` accepts a code outside
the built-in set, and `severityFor` grades on `class` and `code`, so your
findings regrade with the same `--severity` grammar. Pick the closest of
the six classes above; the union is closed.

For house policy that does not need oaverify's view of the document,
such as naming, required descriptions or tag conventions,
[Spectral](https://github.com/stoplightio/spectral) is the better tool. A
rule that does need it, one that turns on how oaverify compiles a schema,
is a candidate for a built-in: open an issue.

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
