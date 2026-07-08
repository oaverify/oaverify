# @oav/overlay-spec

Translator from [OpenAPI Overlay 1.0](https://spec.openapis.org/overlay/1.0.0) spec-format documents to oav's typed `SpecOverlay`. Internal workspace package; the public surface ships at `@aahoughton/oav/overlay-spec` (and `@aahoughton/oav-core/overlay-spec`).

## Why

oav's first-party overlay surface is `SpecOverlay` from `@aahoughton/oav/spec`: typed verbs scoped to known OpenAPI shapes, hand-authored against the type. The OpenAPI Overlay 1.0 spec describes overlays as a list of JSONPath-targeted actions instead. This package consumes spec-format input and re-expresses it as typed `SpecOverlay` so callers can apply third-party overlay documents through the same code path.

The translator maps a closed set of `target` expression shapes onto the typed `SpecOverlay` verbs in `@oav/spec`, not arbitrary JSONPath. The recognized shapes describe typical OAS axes (paths, methods, parameters by name and `in`, component buckets by name); anything outside that set throws a translation error naming the offending expression (recursive descent `..`, array slices, filter functions, wildcards across non-OAS axes); no silent partial application. Against the OpenAPI Overlay 1.0 canonical test suite this covers the conventional-shape targets; the rest throw. See [`docs/configuration.md`](../../docs/configuration.md) and [`docs/overlays.md`](../../docs/overlays.md) for the typed-authoring path.

## API

```ts
import { translateOverlay, applySpecOverlay } from "@aahoughton/oav/overlay-spec";
import { applyOverlays } from "@aahoughton/oav/spec";

// Translate spec-format input into a typed SpecOverlay.
const overlay = translateOverlay(specFormatDocument);
const patched = applyOverlays(baseSpec, [overlay]);

// Or in one call:
const alsoPatched = applySpecOverlay(baseSpec, specFormatDocument);
```

Both functions throw on the first malformed or unrecognised action; no partial application.

## Recognised target shapes

| Target                                                                    | Typed verb                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `$.info`                                                                  | `info` (shallow merge)                                       |
| `$.servers` (update)                                                      | `addServers`                                                 |
| `$.servers` (remove)                                                      | `servers: []`                                                |
| `$.tags` (update array)                                                   | `extendTags`                                                 |
| `$.tags[?(@.name=='X')]` (update)                                         | `extendTags` (merge by name)                                 |
| `$.tags[?(@.name=='X')]` (remove)                                         | `removeTags`                                                 |
| `$.security` (update)                                                     | `addSecurity`                                                |
| `$.security` (remove)                                                     | `security: []`                                               |
| `$.webhooks['name']` (update)                                             | `addWebhooks`                                                |
| `$.webhooks['name']` (remove)                                             | `removeWebhooks`                                             |
| `$.components.<bucket>.<Name>` (update)                                   | `extend<Bucket>` (schemas use `allOf`; others shallow-merge) |
| `$.components.<bucket>.<Name>` (remove)                                   | `remove<Bucket>`                                             |
| `$.paths['/x']` / `$.paths.x` (update)                                    | `overrides[<path>].pathItem` merge                           |
| `$.paths['/x']` (remove)                                                  | `removePaths`                                                |
| `$.paths.*` (update)                                                      | `overrides['*'].pathItem` merge                              |
| `$.paths['/x'].<method>` (update)                                         | `overrides[<path>].operations[<method>]`                     |
| `$.paths['/x'].*` (update)                                                | `overrides[<path>].operations['*']`                          |
| `$.paths.*.<method>` (update)                                             | `overrides['*'].operations[<method>]`                        |
| `$.paths['/x'].<method>.parameters[?(@.name=='X' && @.in=='Y')]` (update) | `upsertParameters`                                           |
| `$.paths['/x'].<method>.parameters[?(@.name=='X' && @.in=='Y')]` (remove) | `removeParameters`                                           |
| `$.paths['/x'].<method>.responses['200']` (update)                        | `patchResponses` (in-place merge: existing fields survive)   |
| `$.paths['/x'].<method>.responses['200']` (remove)                        | `removeResponses`                                            |
| `$.paths.*.*[?(@.tags contains 'X')]` (update)                            | `modifyOperations` with `where.tags`                         |
| `$.paths['/x'].*[?(@.tags contains 'X')]` (update)                        | `modifyOperations` with `where.tags` and `where.pathPattern` |

The `update` payload at each target is a partial OpenAPI object (the OAS shape, not oav's `SpecOverlay`). The translator maps recognised OAS fields onto the typed verbs:

- Scalar operation fields (`operationId`, `summary`, `description`, `deprecated`) flow through `OperationOverride`'s matching scalar fields.
- `tags: ["x"]` becomes `addTags: ["x"]`.
- `security: [...]` becomes `addSecurity: [...]`.
- `responses: { "200": { ... } }` on an operation routes per-status through `patchResponses`, so existing `description` / `headers` / `content` on each status survive a partial update.
- `callbacks` shallow-merge by key.
- `x-*` extension fields become `setExtensions`.
- HTTP method fields on a `$.paths['/x']` payload (e.g. `update: { get: { ... } }`) are split out and routed through `operations[<method>]` instead of `pathItem`, so the existing operation isn't clobbered by `Object.assign`.

Fields that don't map (e.g. `parameters` directly on an operation update, where the typed surface wants `upsertParameters`) throw with a hint pointing at the leaf-path target.

For array-valued targets (`$.servers`, `$.tags`, `$.security`), the OpenAPI Overlay 1.0 canonical form is `update: { /* one entry */ }` (a single object to append). An `update: [{...}, ...]` array form is also accepted as a batched-append shorthand.

## Error policy

- **Unrecognised target.** `UnrecognisedTargetError` with the offending `target` string in both the message and the `.target` property.
- **Both `update` and `remove: true` on one action.** Plain `Error` naming the action index and target.
- **Neither `update` nor `remove: true`.** Same.
- **Payload shape mismatch** (object expected, array got, etc.). Plain `Error` naming the action index and target.

No partial application: any failing action aborts the whole translation.

## Out of scope

- General-purpose JSONPath.
- Authoring helpers for spec-format overlays. Prefer typed authoring via `SpecOverlay`; this package is for consuming external input.
- Mutating the document directly. Translation always goes through `applyOverlays` so behavior stays a single source of truth.
