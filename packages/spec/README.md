# @oaverify/core/spec

Multi-file OpenAPI loader, `$ref` resolver, and overlay merger. Use
this when you want to stitch a spec together before handing it to
`createValidator`.

This module is available from `@oaverify/core/spec`. The examples
below use that package.

> **`@oaverify/core` ships JSON readers only.** Calling
> `createFileReader()` or `createHttpReader()` on a `.yaml` / `.yml`
> path throws an install-hint error. For YAML support, install
> `@oaverify/yaml` or register your own YAML reader.

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

`document` has every external `$ref` inlined; `sources` lists every
file that was loaded along the way.

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
`loadSpecSync` from `@oaverify/yaml`, whose default reader covers
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

Built-ins (JSON only; YAML support lives in `@oaverify/yaml`):

- `createFileReader(cwd?)`: filesystem JSON. `.yaml` / `.yml` paths
  throw an install-hint error; compose with `createYamlFileReader` from
  `@oaverify/yaml` to cover YAML.
- `createHttpReader()`: HTTP / HTTPS JSON. Same YAML policy.
- `createMemoryReader(entries)`: in-memory JSON or pre-parsed objects.
- `composeReaders([...])`: layers readers, dispatching by `canRead`.

`@oaverify/yaml` additionally exports `createYamlFileReader`,
`createSmartHttpReader`, and `parseYamlString` for YAML-backed specs.
`createSmartHttpReader` supersedes the JSON-only `createHttpReader`
when composed: it claims every `http(s)` URI and dispatches by
response `Content-Type` (falling back to URL extension), so JSON and
YAML endpoints work through the same reader:

```ts
import { composeReaders, createFileReader } from "@oaverify/core/spec";
import { createSmartHttpReader, createYamlFileReader } from "@oaverify/yaml";

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

`resolveSpec` inlines external `$ref`s (references to separate files
or HTTP URIs). Internal references (`#/components/...`) are left alone;
the validator and schema compiler follow them at runtime via a
ref-resolution cache keyed on schema identity, so self-recursive
schemas compile to normal recursive calls.

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

```ts
const { document, specHygieneIssues } = await loadSpec({ reader, entry, lint: true });
for (const w of specHygieneIssues) {
  console.warn(`[${w.code}] ${w.pointer}: ${w.message}`);
}
```

The same engine is reachable directly via `lintResolvedSpec(document)`
for callers that already have a resolved document and just want the
findings. The validator surfaces it too: `createValidator(spec,
{ lint: true })` exposes `validator.specHygieneIssues`. Pick whichever
layer is natural for the flow; running `lint: true` in two places lints
twice.

`oaverify resolve --lint` exposes the same checks at the CLI; pair with
`--fail-on warning` for a CI gate.

See `SpecHygieneIssue` for the per-finding shape.
