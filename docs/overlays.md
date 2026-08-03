# Overlays

Overlays patch an OpenAPI document in memory before the validator is
constructed. Use them to consume a spec you don't own (a vendor API, a
gateway's spec, an upstream framework's published document) and add,
augment, replace, or remove parts to match your deployment, without
forking the file.

## When you want one

- **Your deployment requires headers or query parameters the upstream
  spec doesn't declare.** `overrides` with `upsertParameters`.
- **The upstream schema is close but missing a field.**
  `extendSchemas`: adds constraints via `allOf`, preserving the
  original shape.
- **The upstream schema is wrong for your deployment.**
  `replaceSchemas`: swaps it out entirely, no merge.
- **You need a route the upstream doesn't expose.** `addPaths`.
- **Upstream declares something you want gone** (a parameter you don't
  accept, a response status you never return, a path you don't serve).
  One of the `remove*` verbs.
- **An operation needs a complete rewrite** rather than piecemeal
  patching. `overrides.operations.<method>.replace`.

## Verb matrix

The structured iterators (`modifyOperations`, `modifyParameters`) sit
alongside the table: they apply one override across every operation or
parameter matching a predicate.

| Target                  | add                | augment                              | replace                            | remove                      |
| ----------------------- | ------------------ | ------------------------------------ | ---------------------------------- | --------------------------- |
| `info`                  |                    | `info` (shallow merge)               |                                    |                             |
| `servers`               | `addServers`       |                                      | `servers`                          |                             |
| `tags`                  |                    | `extendTags`                         | `tags` / `replaceTags`             | `removeTags`                |
| `security`              | `addSecurity`      |                                      | `security`                         |                             |
| `webhooks`              | `addWebhooks`      |                                      |                                    | `removeWebhooks`            |
| Root extensions (`x-*`) |                    |                                      | `setExtensions`                    | `setExtensions` (undefined) |
| Paths                   | `addPaths`         | (via `overrides`)                    | (via `overrides.replace`)          | `removePaths`               |
| Operations              |                    | (via additive op fields / iterators) | `overrides.operations.<m>.replace` | (via `removePaths`)         |
| Parameters (per op)     | `upsertParameters` |                                      | `upsertParameters`                 | `removeParameters`          |
| Request body (per op)   |                    |                                      | `requestBody`                      |                             |
| Responses (per op)      | `responses`        | `patchResponses`                     | `responses`                        | `removeResponses`           |
| Component schemas       |                    | `extendSchemas`                      | `replaceSchemas`                   | `removeSchemas`             |
| Component buckets       |                    | `extend<Bucket>`                     | `replace<Bucket>`                  | `remove<Bucket>`            |

The component bucket trio fans out across `parameters`, `responses`,
`requestBodies`, `headers`, `securitySchemes`, `links`, `callbacks`,
and `examples`. The schemas variant wraps in `allOf`; the others
shallow-merge.

The full surface is the `SpecOverlay` type in `@oaverify/core/spec`,
with `PathOverride`, `OperationOverride`, `ResponseOverride`,
`ModifyOperationsEntry`, and `ModifyParametersEntry` under it. The
TSDoc on each field is the contract: exact verb names, merge
semantics, and conflict rules live there. Every field is independent;
use any subset.

## Applying an overlay

Two entry points, same result.

**`applyOverlays`** takes an already-resolved base document:

```ts
import { applyOverlays } from "@oaverify/core/spec";
import { createValidator } from "@oaverify/core";

const patched = applyOverlays(base, [overlay1, overlay2]);
const validator = createValidator(patched);
```

**`loadSpec`** resolves external `$ref`s and applies overlays in one
pass; use this for multi-file specs or remote documents:

```ts
import { loadSpec, composeReaders, createFileReader } from "@oaverify/core/spec";

const reader = composeReaders([createFileReader()]);
const { document } = await loadSpec({
  reader,
  entry: "openapi.yaml",
  overlays: [overlay1, overlay2],
});
const validator = createValidator(document);
```

Overlays apply in order. Later overlays win on conflict. The base
document is deep-cloned; the input is never mutated.

## Recipes

### Add a server entry

```ts
const overlay: SpecOverlay = {
  addServers: [{ url: "https://eu.api.example.com", description: "EU region" }],
};
```

`addServers` appends; `servers` replaces the whole list.

### Add an operation-level security requirement

```ts
const overlay: SpecOverlay = {
  overrides: {
    "/pets": {
      operations: {
        post: { addSecurity: [{ apiKey: [] }] },
      },
    },
  },
};
```

`addSecurity` appends to the operation's existing `security` array (OR
semantics across requirements); `security` replaces the list, and
cannot combine with the `add*` / `remove*` variants.

### Modify every operation matching a tag

```ts
const overlay: SpecOverlay = {
  modifyOperations: [
    {
      where: { tags: ["internal"] },
      apply: {
        addSecurity: [{ internalKey: [] }],
        setExtensions: { "x-internal-only": true },
      },
    },
  ],
};
```

`modifyOperations` walks every operation under `paths` and `webhooks`.
`where` fields combine with AND; omit `where` to match everything.

### Extend a component schema

```ts
const overlay: SpecOverlay = {
  extendSchemas: {
    Pet: { required: ["id"] },
  },
};
```

The upstream `Pet` becomes `allOf: [<upstream>, { required: ["id"] }]`:
original constraints plus yours. For non-schema buckets, the parallel
`extend<Bucket>` verb shallow-merges a partial patch instead:

```ts
const overlay: SpecOverlay = {
  extendParameters: {
    TraceId: { description: "request trace id", required: true },
  },
};
```

Fields the patch doesn't name (`name`, `in` above) stay as the base
declared them.

### Replace an operation wholesale

```ts
const overlay: SpecOverlay = {
  overrides: {
    "/pets": {
      operations: {
        post: { replace: { responses: { "201": { description: "created" } } } },
        // other methods on /pets untouched
      },
    },
  },
};
```

`replace` cannot combine with the other fields in the same operation
override; setting both throws at apply time.

## Things to know

- **Overlays target the resolved document.** `loadSpec` inlines
  external `$ref`s before applying overlays; if you call
  `applyOverlays` directly, pass a document that has been through
  `resolveSpec`.
- **Internal `$ref`s stay internal.** `#/components/...` refs aren't
  inlined, so editing one operation's response entry in place doesn't
  affect other operations referencing the same component: a way to
  augment one endpoint's response shape via `allOf` + the shared
  `$ref` without mutating the component for everyone else.
- **Wildcards.** `"*"` as an operation key applies the override to
  every method on the path; `"*"` as a path key applies it to every
  path.
- **Fail fast vs silent no-op.** `addPaths` throws on an existing
  path; `removePaths` and the component `remove*` verbs throw on a
  missing target, so the overlay notices when upstream moves something
  instead of silently no-oping. Per-operation `removeParameters` /
  `removeResponses` silently no-op instead: wildcard overrides fan out
  to operations with different surfaces.
- **`$ref` parameters can't be matched.** `upsertParameters` and
  `removeParameters` match concrete entries by (`name`, `in`); a
  `{ $ref: … }` in the base is left alone, and a new parameter with
  the same key appends alongside it rather than replacing.
- **`extendSchemas` stacks.** Each overlay extending the same schema
  adds another `allOf` branch; the compiled validator runs them all.
- **Contradictions in one overlay throw.** `addPaths` + `removePaths`
  naming the same path, or `replaceSchemas` + `removeSchemas` naming
  the same schema, fail at apply time.
- **`extend<Bucket>` patches on a missing key** create the component
  from the patch as written, partial or not. Use `replace<Bucket>` to
  add a complete one.

## Related

- [`examples/overlay-petstore-schema.ts`](../examples/overlay-petstore-schema.ts)
  and
  [`examples/overlay-petstore-endpoint.ts`](../examples/overlay-petstore-endpoint.ts):
  runnable end-to-end demos.
- Handed a standard [OpenAPI Overlay 1.0](https://spec.openapis.org/overlay/1.0.0)
  document (JSONPath-targeted actions) rather than a typed
  `SpecOverlay`? `@oaverify/core/overlay-spec` translates it onto
  the verbs in this doc; see
  ["Consuming spec-format overlays"](./integration.md#consuming-spec-format-overlays)
  and [`packages/overlay-spec/README.md`](../packages/overlay-spec/README.md).
  The CLI's `--overlay` flag accepts both formats directly.
