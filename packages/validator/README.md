# oav (validator)

HTTP request/response validator for OpenAPI 3.0, 3.1, and 3.2. This is
the headline surface of the package; `createValidator` is re-exported
from the package root.

```ts
import { createValidator } from "@aahoughton/oav-core";

const validator = createValidator(resolvedSpec);

const requestResult = validator.validateRequest({
  method: "POST",
  path: "/pets",
  query: { limit: "10" },
  headers: { "x-tenant": "acme" },
  contentType: "application/json",
  body: { name: "Fido" },
});

const responseResult = validator.validateResponse(
  { method: "GET", path: "/pets" },
  { status: 200, contentType: "application/json", body: [{ name: "Fido" }] },
);
```

Both methods return `{ valid: true }` on success, or
`{ valid: false, errors, truncated }` on failure. The default is a flat
`errors` list that stops at the first problem (`maxErrors: 1`); pass
`output: "tree"` for a nested `error` tree, or
`maxErrors: Number.POSITIVE_INFINITY` to collect every error. Errors are
rooted at the HTTP frame (`["body", …]`, `["query", name, …]`,
`["header", name, …]`, etc.) so downstream code can group by location.

`validator.detectedVersion` reflects the `openapi` string that was
detected on construction (or `undefined` if the field was missing or
unsupported and a fallback was used; see `onUnknownVersion` below).

Companion adapter packages wrap the validator as middleware /
hooks: [`oav-express4`](../oav-express4/README.md),
[`oav-express5`](../oav-express5/README.md),
[`oav-fastify`](../oav-fastify/README.md). Each exports the same
`validateRequests` factory plus standalone helpers
(`httpRequestFrom<Framework>`, `renderProblemDetails`).

## Why this validator

Native OpenAPI 3.0 dialect alongside 3.1 / 3.2, so `nullable`,
boolean `exclusiveMaximum`, and `$ref`-suppresses-siblings work by
3.0 rules rather than via a 2020-12 translation shim. Pairs with
[`oav/spec`](../spec/README.md)'s `applyOverlays` for
patching externally-owned base specs at load time. Pass counts against
the upstream test suites live in
[`conformance/REPORT.md`](../../conformance/REPORT.md). The
[top-level README](../../README.md) has the full rationale.

## Features

- **Compile at construction**: every operation's schemas get compiled
  once on `createValidator`, keyed by schema identity. Repeated
  requests reuse the compiled functions.
- **Version-aware**: `openapi` is read once and mapped to one of three
  built-in dialects (OAS 3.0, OpenAPI 3.1, OpenAPI 3.2). No
  per-request branching.
- **`$ref` resolved lazily**: operation-level references (`requestBody`,
  `responses[code]`, `parameters[i]`, `response.headers[name]`) are
  resolved against the spec as needed, so `#/components/*` reuse works
  without preprocessing.
- **Parameter deserialisation**: `simple`, `form`, `label`, `matrix`,
  `deepObject`, `spaceDelimited`, `pipeDelimited` with `explode`.
- **Content-type negotiation**: against the request / response
  `Content-Type`, including wildcards (`application/*`, `*/*`).
- **Response status matching**: exact, then `NXX` class, then `default`.
- **Format validators**: the `oav/formats` built-ins merged
  with any extras passed via `options.formats`.

## Validator methods

| Method                                        | Purpose                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateRequest(req)`                        | Check an `HttpRequest` against the spec. Returns `{ valid: true }` or `{ valid: false, errors, truncated }` (flat by default; `output: "tree"` for a nested `error`).     |
| `validateResponse(req, res)`                  | Check an `HttpResponse` against the spec (request is used only for method + path). Same result shape as `validateRequest`.                                                |
| `validateFetchRequest<T>(request, opts?)`     | Convenience for Web Standards `Request`: reads URL, headers, body; returns a discriminated union with a typed body. See [docs/integration.md](../../docs/integration.md). |
| `validateFetchResponse<T>(request, response)` | Symmetric Web Standards `Response` check. Useful for contract-testing an upstream.                                                                                        |
| `getOperation({ method, path })`              | Startup-time introspection: returns the resolved, overlay-applied `OperationObject` + matched template for a (method, path) pair.                                         |
| `routes`                                      | `readonly RouteInfo[]`: every declared `{ method, pathPattern }` pair (uppercased method), in route-specificity order. Frozen at construction.                            |
| `detectedVersion`                             | The `openapi` string detected on construction, or `undefined` for an unrecognised / missing version (see `onUnknownVersion`).                                             |
| `warnings`                                    | `readonly string[]`: warnings accumulated at construction time (`onUnknownVersion: "warn"` or `dialect`-suppressed category error). Empty when neither path fires.        |

## Options

| Option                  | Effect                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `dialect`               | Force a specific {@link Dialect}, bypassing version detection.                                                                   |
| `formats`               | Extra string format validators merged with `oav/formats`.                                                                        |
| `keywords`              | User-registered schema keywords (see below).                                                                                     |
| `output`                | Result shape: `"flat"` (default), `"tree"`, or `"predicate"`. Mirrors `compileSchema`.                                           |
| `maxErrors`             | Per-call total cap on leaf errors. Default `1` (fast-fail); `Number.POSITIVE_INFINITY` collects every error.                     |
| `strictQueryParameters` | Reject undeclared query parameters. Default `false`.                                                                             |
| `validateSecurity`      | `"off"` (default), `"shape"` (check recognized schemes; pass on oauth2/oidc/mTLS), or `"strict"` (fail on unrecognized schemes). |
| `ignoreUndocumented`    | Treat requests whose path the router can't match as valid (`{ valid: true }`). Default `false`.                                  |
| `ignorePaths`           | `(path: string) => boolean` predicate that short-circuits validation when it returns `true` (runs before routing).               |
| `onUnknownVersion`      | `"fallback31"` \| `"warn"` \| `"throw"` when `openapi` is missing or unsupported. Default `"fallback31"`.                        |

## Combining multiple specs

`combineValidators([v1, v2, ...])` stacks several validators into one
that dispatches each request to the member owning its route. The result
is a `Validator`, so the framework adapters consume it unchanged.

```ts
import { createValidator, combineValidators } from "@aahoughton/oav-core";

const validator = combineValidators(
  [createValidator(specV1), createValidator(specV2)],
  { onOverlap: "error" }, // assert the specs are route-disjoint at construction
);
```

Each member keeps its own dialect and components, so specs that reuse a
component name don't clobber each other (a literal document merge
would). Dispatch keys on route ownership and delegates to the owner, so
the owner's own `ignorePaths` still applies. `onOverlap` picks
first-match (default) vs error-on-clash; `ignoreUndocumented` governs
routes no member owns. All members must share an `output` mode. See
`CombineOptions` and [docs/integration.md](../../docs/integration.md#validating-multiple-specs-with-one-validator).

## Custom keywords

```ts
const validator = createValidator(spec, {
  keywords: {
    activeTenant: (data) =>
      typeof data !== "string" || tenantCache.isActive(data)
        ? true
        : { message: `tenant "${data}" is not active` },
  },
});
```

Flag schemas that should be checked:

```yaml
TenantId:
  type: string
  pattern: "^t_[a-z0-9]+$"
  activeTenant: true
```

Custom-keyword errors appear in the tree alongside regular schema
errors, prefixed with the HTTP location (`body.tenantId`, etc.). See
[`examples/custom-keywords.ts`](../../examples/custom-keywords.ts) for
an end-to-end.

## Fast-fail / bounded error collection

```ts
createValidator(spec); // default: stop after the first error
createValidator(spec, { maxErrors: 10 }); // cap while still getting useful feedback
createValidator(spec, { maxErrors: Number.POSITIVE_INFINITY }); // every error
```

`maxErrors` is a per-call total across all locations (body, query,
headers). Hot loops (array items, object properties, `allOf` / `anyOf`
branches) short-circuit once the budget is exhausted, so a 10 MB invalid
payload doesn't cost proportional CPU or memory. A failing result
carries `truncated: true` when the cap was reached.

## Handling unknown `openapi` versions

Two kinds of "unknown":

- **Category errors**: missing / non-string `openapi`, non-semver
  string, or a major version that isn't `3`. These **throw** at
  construction by default. Set `dialect` to force a specific
  compiler; that suppresses the throw and adds an entry to
  `validator.warnings` so the override is still visible.
- **Unknown minor within 3.x**: e.g. `"3.7.0"` if a future minor
  ships before oav is updated. Governed by `onUnknownVersion`:

  ```ts
  createValidator(spec); // fallback31 default (silent, uses 3.1 dialect)
  createValidator(spec, { onUnknownVersion: "throw" }); // refuse to build
  createValidator(spec, { onUnknownVersion: "warn" }); // populates validator.warnings, uses 3.1 dialect
  createValidator(spec, { onUnknownVersion: "warn", warn: (m) => log.info(m) }); // plus live callback
  ```

`validator.detectedVersion` is `undefined` in the fallback cases so
callers can introspect what dialect they got. Warnings from
any path land on `validator.warnings`; the library never writes to
`process.stderr` or `console` on its own.
