# @oaverify/core/spec

Multi-file OpenAPI loader, `$ref` resolver, and overlay merger. Use
this when you want to stitch a spec together before handing it to
`createValidator`.

This module is available from `@oaverify/core/spec`. The examples
below use that package.

> **`@oaverify/core` ships JSON readers only.** Calling
> `createFileReader()` or `createHttpReader()` on a `.yaml` / `.yml`
> path throws an install-hint error. For YAML support, install
> `@oaverify/syntax` or register your own YAML reader.

## Loading a spec

`loadSpec` is the recommended entrypoint. It reads the entry document,
resolves external `$ref`s, and applies any overlays (in the right
order) in a single call:

```ts
import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";

const reader = composeReaders([createFileReader()]);
const { document, sources } = await loadSpec({
  reader,
  entry: "openapi.yaml",
  overlays: [], // optional
});
```

`document` has every external `$ref` resolved, with schema targets
hoisted into `components.schemas` and referenced internally (see below);
`sources` lists every file that was loaded along the way.

For custom composition (e.g. validate between resolve and overlay, or
load overlays yourself), call the primitives directly:
`resolveSpec({ reader, entry })`, then `applyOverlays(document, [...])`.

### Synchronous loading

`loadSpecSync` is the blocking mirror of `loadSpec`: it runs the
identical pipeline (resolve external `$ref`s, apply overlays, optional
lint) and returns a `ResolvedSpec` directly instead of a `Promise`. It
exists for code that builds a validator in a synchronous bootstrap and
can't `await`: a server or CLI that loads its spec once at startup.

```ts
import { loadSpecSync } from "@oaverify/core/spec";

const { document } = loadSpecSync({ entry: "openapi.json" });
const validator = createValidator(document);
```

It differs from `loadSpec` in one deliberate way: `reader` is
**optional**, defaulting to a JSON filesystem reader, so the common case
needs no reader composition. To read from a custom synchronous source,
pass a `{ read, canRead }` object as `reader`.

`@oaverify/core`'s `loadSpecSync` is JSON-only. For YAML, use the
`loadSpecSync` from `@oaverify/syntax`, whose default reader covers
`.yaml` / `.yml` and `.json`.

`loadSpecSync` blocks on filesystem reads (`readFileSync`); use it at
boot or in a CLI, not on a per-request path. For non-blocking contexts,
`loadSpec` stays the right tool. An unreadable or malformed spec throws,
the same as `loadSpec`. To keep one bad spec from aborting startup,
catch it and decide locally:

```ts
function loadOrSkip(entry: string): Validator | null {
  try {
    return createValidator(loadSpecSync({ entry }).document);
  } catch (err) {
    log.warn(`spec ${entry} unreadable; skipping`, err);
    return null;
  }
}
```

## Readers

Readers implement `DocumentReader`:

```ts
interface DocumentReader {
  canRead(uri: string): boolean;
  read(uri: string): Promise<unknown>;
}
```

Built-ins (JSON only; YAML support lives in `@oaverify/syntax`):

- `createFileReader(cwd?)`: filesystem JSON. `.yaml` / `.yml` paths
  throw an install-hint error; compose with `createYamlFileReader` from
  `@oaverify/syntax` to cover YAML.
- `createHttpReader()`: HTTP / HTTPS JSON. Same YAML policy.
- `createMemoryReader(entries)`: in-memory JSON or pre-parsed objects.
- `composeReaders([...])`: layers readers, dispatching by `canRead`.

`@oaverify/syntax` additionally exports `createYamlFileReader`,
`createSmartHttpReader`, and `parseYamlString` for YAML-backed specs.
`createSmartHttpReader` supersedes the JSON-only `createHttpReader`
when composed: it claims every `http(s)` URI and dispatches by
response `Content-Type` (falling back to URL extension), so JSON and
YAML endpoints work through the same reader:

```ts
import { composeReaders, createFileReader } from "@oaverify/core/spec";
import { createSmartHttpReader, createYamlFileReader } from "@oaverify/syntax";

const reader = composeReaders([
  createYamlFileReader(),
  createSmartHttpReader(),
  createFileReader(),
]);
```

Write a custom reader (S3, blob store, bundled assets) by implementing
the two methods; plug it in via `composeReaders`.

## Overlays

```ts
import { applyOverlays, type SpecOverlay } from "@oaverify/core/spec";

const overlay: SpecOverlay = {
  addPaths: {
    "/v2/pets": { get: { responses: { "200": { description: "ok" } } } },
  },
  overrides: {
    "/pets": {
      operations: {
        get: {
          upsertParameters: [{ name: "X-Tenant", in: "header", schema: { type: "string" } }],
        },
      },
    },
    "*": {
      // wildcard applies to every path
      operations: {
        post: {
          upsertParameters: [{ name: "trace", in: "header", schema: { type: "string" } }],
        },
      },
    },
  },
  extendSchemas: { Pet: { required: ["name"] } },
  replaceSchemas: { LegacyPet: { type: "null" } },
};

const patched = applyOverlays(document, [overlay]);
```

Overlays apply in order; later overlays win on conflict. `addPaths`
errors on duplicates. `extendSchemas` wraps in `allOf`.
`replaceSchemas` does a full swap.

## `$ref` semantics

`resolveSpec` produces one self-contained document. External `$ref`s in
schema positions are **hoisted**: the target lands in
`components.schemas` under a readable name and every use site becomes an
internal `$ref` to it, so the schema keeps an address rather than being
copied at each reference. A component whose value was nothing but an
external `$ref` receives the content under the name its author chose.
External refs in non-schema positions (Response, Parameter, Path Item
Objects) are inlined. Resolving an already-resolved document is a no-op.

A cycle among **non-schema** objects has no components section to be
hoisted into, so it is materialised under the root extension field
`x-oaverify-externals`, keyed by encoded source URI. OpenAPI allows `x-`
fields on the root object and allows nothing else there, so resolved
output stays conformant. Schema cycles, which is what a recursive schema
in its own file produces and by far the common case, get an ordinary
`components.schemas` address instead.

Circular external references are rewritten to internal anchors
during resolution, so the final document is always self-contained.

## Spec hygiene lint

`loadSpec` and `resolveSpec` accept `lint: true`. When set, the
returned `ResolvedSpec.specHygieneIssues` carries findings about
authoring mistakes the structural validation can't catch:

- `unused-component`: a `components.{schemas,parameters,...}` entry
  with no `$ref` reaching it.
- `unused-tag`: a `tags[]` entry no operation references.
- `unreachable-defs`: a per-schema `$defs/<name>` no sibling `$ref`
  points at.
- `path-param-undeclared` / `path-param-unused`: mismatch between the
  `{name}` placeholders in a path template and the path-parameter
  declarations on the operation or its path-item.
- `path-template-malformed`: a path template whose literal text carries
  a percent escape that does not decode (`/bad%zz`, a trailing `%`, or
  `/a%zz-{id}`, where the run beside the placeholder is literal text
  too). The router keeps such a run raw, so the route only matches a
  request repeating the same broken escape.

```ts
const { document, specHygieneIssues } = await loadSpec({ reader, entry, lint: true });
for (const w of specHygieneIssues) {
  console.warn(`[${w.code}] ${w.pointer}: ${w.message}`);
}
```

The same engine is reachable directly via `lintResolvedSpec(document)`
for callers that already have a resolved document and just want the
findings. One thing the document cannot say for itself: a non-schema
component referenced from another file is inlined at the use site, so
nothing in the resolved document reaches the component and
`unused-component` would report it. `resolveSpec` returns those in
`inlinedComponents`; pass them on to keep the rule quiet about them:

```ts
const { document, inlinedComponents } = await resolveSpec({ reader, entry });
const issues = lintResolvedSpec(document, { inlinedComponents });
```

`loadSpec` and `resolveSpec` do this for you under `lint: true`. See
`LintOptions`.

The validator surfaces the findings too: `createValidator(spec,
{ lint: true })` exposes `validator.specHygieneIssues`. It is handed a
document and nothing else, so it has no `inlinedComponents` to go on
and still reports a component that was inlined across documents. Lint
at the load layer for a multi-file spec; the validator layer is the
natural one when the spec arrives as a single document. Running
`lint: true` in two places lints twice.

`oaverify check` exposes the same checks at the CLI; pair with
`--fail-on warning` for a CI gate.

See `SpecHygieneIssue` for the per-finding shape.
