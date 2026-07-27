# Migration from express-openapi-validator

A focused reference for porting an Express app off
`express-openapi-validator` (eov) onto `oav`. Reads as a punch list,
not a tutorial; for integration recipes, see
[integration.md](./integration.md). For Express 4 specifically, the
[`@oaverify/express4`](../packages/oav-express4/README.md)
companion package gets you most of eov's ergonomics back as a
one-liner; the recipes in this doc work whether you use the adapter
or write the middleware inline.

## What you give up; what you get

eov registers as a single middleware that wraps a lot of behavior:
file upload (multer), security check dispatch, response wrapping,
typed error classes. `oav` is a ~20-line middleware (or one
`validateRequests(...)` call via the adapter) plus your own multer /
auth wiring where needed. In exchange:

- **You own the error → HTTP mapping.** A small switch statement
  maps the validator's stable `code` field to whatever status codes
  your API contract requires; `httpStatusFor` covers the common
  case in one call.
- **Response wrapping is opt-in and explicit.** eov always wraps the
  response methods to auto-intercept. In `oav` the core stays a pure
  function: `validateResponse` reads its arguments and returns a
  result, never touching `req` / `res`. The Express adapters offer a
  `validateResponses` middleware that _does_ wrap `res.json` / `res.send`,
  but only where you mount it (off in production by convention); the
  Fastify adapter does the same via an `onSend` hook with no
  monkey-patching at all. So response checking is available as a
  one-liner without making it always-on-and-implicit. See
  [integration.md, Response validation](./integration.md#response-validation).
- **Structured error trees.** Every error is
  `{ code, path, message, params, children }`. Downstream code can
  narrow on fields (`err.code === "required"`,
  `err.params.missing`) instead of parsing message strings.
- **Built-in OpenAPI 3.0 dialect.** `nullable: true`, boolean
  `exclusiveMaximum`, and `$ref`-suppresses-siblings are in the
  compiler's dialect dispatch; no preprocessing step. See the
  [conformance report](../conformance/REPORT.md) for pass / fail
  counts by category.
- **Overlays.** Extend an externally-owned base spec (Supabase,
  Hasura, PocketBase, a gateway-published document) with
  `applyOverlays` at load time. See [overlays.md](./overlays.md).

## Behavior differences to watch for

The behavior deltas surfaced by real eov-to-oav migrations. Most are
defensible improvements; a few are cosmetic. Either way, expect
fixture / test churn.

| What                            | eov                                                                                         | oav                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Empty POST, no Content-Type** | 415 unsupported-media-type                                                                  | 400 body-required (no client signal to be "wrong about")                                                                                                                                                                  |
| **Path-parameter label**        | `/params/<name>` in error paths                                                             | `/path/<name>` (OpenAPI's actual location name)                                                                                                                                                                           |
| **404 message wording**         | `"not found"`                                                                               | `"no route matches POST /path/here"` (more actionable)                                                                                                                                                                    |
| **Top-level message**           | first leaf by default; every leaf `, `-joined under `validateRequests: { allErrors: true }` | configurable via `formatSummary`: `{ select: "first" }` (default; first leaf) or `{ select: "all" }` (every leaf, newline-joined). Per-leaf details always in `errors[]` / `issues[]`. Shape differs from eov; see below. |
| **Top-level `path` on 404s**    | offending URL                                                                               | `[]` (empty array, `""` pointer); same kind of error, different rendering                                                                                                                                                 |
| **`errorCode` names**           | `required.openapi.validation`                                                               | bare codes (`required`); the `.openapi.validation` suffix was always noise                                                                                                                                                |
| **`oneOf` with binary fields**  | silently accepted (looser inside binary fields)                                             | surfaces the genuine ambiguity with `matchCount: 2`; see [integration.md, File uploads](./integration.md#file-uploads-with-multer) for the spec-level fix                                                                 |
| **Response validation**         | always-on `res.json` / `res.send` wrapping                                                  | opt-in `validateResponses` middleware (Express wraps `res.json`/`res.send`; Fastify uses `onSend`), mounted where you want it; see [integration.md, Response validation](./integration.md#response-validation)            |
| **Optional `openapi` version**  | throws on missing / unsupported                                                             | silently uses 3.1 by default; see `onUnknownVersion`                                                                                                                                                                      |
| **`format` semantics**          | always assertive in OpenAPI context                                                         | assertive in OpenAPI context; annotation-only under raw `jsonSchemaDialect` (per 2020-12 default)                                                                                                                         |

For the `oneOf [array<binary>, binary]` pattern specifically: the
spec was already ambiguous before oav surfaced it (the `format:
binary` bypass means both branches match anything). eov's looser
acceptance masked the issue. Drop the `oneOf` and accept the array
form (multer always delivers arrays), or fix the spec however
makes sense for your API.

## Option map

### Spec loading

| eov option                              | oav equivalent                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apiSpec` (path/URL/object)             | `loadSpec({ reader, entry })` + `createValidator(doc)`                                                          |
| `$refParser: "bundle" \| "dereference"` | `loadSpec` inlines external refs; circulars become internal refs. Use `resolveSpec` directly for finer control. |
| `validateApiSpec`                       | Run `oaverify resolve spec.yaml` in CI; no runtime toggle.                                                      |

### Request validation

| eov option                          | oav equivalent                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `validateRequests: true`            | `validator.validateRequest(...)` in your middleware, or `validateRequests(validator)` from `oav-express4`.                  |
| `validateRequests.allErrors`        | `maxErrors: Number.POSITIVE_INFINITY`. oav defaults to `maxErrors: 1` (fast-fail); raise it to collect more leaves.         |
| `validateRequests.coerceTypes`      | Query scalars coerced by default; body coercion not supported (see recipe).                                                 |
| `validateRequests.removeAdditional` | Not supported. `additionalProperties: false` rejects; there is no silent-drop mode.                                         |
| `validateRequests.discriminator`    | Native, always on for OpenAPI specs.                                                                                        |
| `serDes`                            | Not supported. Pre- or post-transform the payload in your handler if you need `Date` / `ObjectId` / etc.                    |
| `ignorePaths` (regex/fn)            | `createValidator(spec, { ignorePaths: (p) => ... })`: predicate that short-circuits before routing.                         |
| `ignoreUndocumented`                | `createValidator(spec, { ignoreUndocumented: true })`: reports paths the router doesn't match as valid (`{ valid: true }`). |

### Response validation

| eov option                | oav equivalent                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateResponses: true` | `validateResponses(validator)` middleware (Express) / `onSend` hook (Fastify), mounted where you want it; or `validateResponse(...)` per-route. See [integration.md, Response validation](./integration.md#response-validation). |

### Formats and custom keywords

| eov option                          | oav equivalent                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `formats`                           | `createValidator(spec, { formats: { ... } })`; see [format-shape note](#format-shape-note) below.         |
| `validateFormats: "fast" \| "full"` | N/A: single-pass validation; the built-in formats are RFC-sourced.                                        |
| `ajvFormats`                        | Pass custom format functions via the `formats` option; see [format-shape note](#format-shape-note) below. |

### Security and file uploads

| eov option                  | oav equivalent                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateSecurity: true`    | Off by default in oav (real apps gate security upstream of validation). Opt in with `createValidator(spec, { validateSecurity: "shape" })` for shape-only checks on `bearer` / `basic` / `apiKey`, or `"strict"` to fail on schemes the validator can't shape-check (oauth2 / oidc / mTLS). |
| `validateSecurity.handlers` | Your own auth middleware, run before the validator. `oav` only checks credential **shape**, not validity. For declarative per-scheme dispatch, see the [integration.md security recipe](./integration.md#per-scheme-auth-dispatch).                                                         |
| `fileUploader: true`        | Your own multer middleware; see [integration.md file uploads](./integration.md#file-uploads-with-multer).                                                                                                                                                                                   |

### Handler wiring

| eov option          | oav equivalent                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `operationHandlers` | Your own Express routes. `oav` doesn't auto-load handlers from the filesystem. |

## Features not carried over

- **Auto-multer.** Replace with the [multer recipe](./integration.md#file-uploads-with-multer) (~15 lines per upload route, or one global setup).
- **Security handler dispatch.** Use your existing auth middleware, or the [per-scheme dispatch recipe](./integration.md#per-scheme-auth-dispatch).
- **`operationHandlers` filesystem routing.** Write Express routes
  manually or keep whatever routing you had.
- **`serDes` payload mutations.** Do these in your handler rather
  than the validator.
- **Typed error classes** (`BadRequest`, `Unauthorized`, etc.). Use
  the error's `code` field and `httpStatusFor` for the status map.

## Features added

- **Structured error tree.** Stable `code`s, segment paths, and
  per-code `params` typed via `BuiltInErrorParams`. Narrowing happens
  on fields rather than message strings.
- **Built-in 3.0 dialect.** No translation layer over 2020-12. See
  [conformance/REPORT.md](../conformance/REPORT.md) for pass / fail
  counts by category.
- **Overlays.** Extend externally-owned specs at load time;
  see [overlays.md](./overlays.md).
- **Smaller install footprint.** `oav` depends on `yaml`,
  `commander`, and `esbuild` (the latter two for CLI + AOT compile
  output); `@oaverify/core` is the lean alternative with zero
  runtime deps for programmatic-only consumers who don't need the
  CLI or YAML readers.
- **No mutation of `req`.** eov attaches `req.openapi`, coerces
  types, and replaces `req.body` after deserialise. `oav` reads its
  inputs and returns an error tree; the request object is unchanged.
- **Explicit control over where validation runs.** Skip it on
  specific routes without configuration, run it twice (per-request
  and per-response) with different `maxErrors` budgets, or run it at
  the edge of a queue processor outside any HTTP framework.
- **AOT compilation.** `oaverify compile-spec spec.yaml` emits a
  zero-runtime-deps validator for edge / serverless deployments.
  See the [CLI README](../packages/cli/README.md#compile-spec-output).
- **Streaming validation of large bodies.** The separate
  [`@oaverify/stream`](../packages/stream-validator/README.md)
  package validates a JSON body as it streams, with bounded memory,
  and `oaverify stream-check spec.yaml` reports which of a spec's bodies
  can stream and which must buffer. eov (like Ajv) validates a
  fully-parsed value only.

## Format-shape note

`ajv-formats` and custom formats registered with eov follow the ajv
shape:

```ts
formats: {
  duration: { type: "string", validate: (v) => isISODuration(v) },
}
```

`oav` expects a plain string predicate:

```ts
formats: {
  duration: (v) => isISODuration(v),
}
```

When migrating a map of ajv-shaped definitions without rewriting each
one, `@oaverify/core/formats` exports `fromAjvFormats` for the conversion:

```ts
import { fromAjvFormats } from "@oaverify/core/formats";

createValidator(spec, { formats: fromAjvFormats(myAjvFormats) });
```

`oav`'s `format` keyword only applies to string values (per JSON
Schema 2020-12 §6.3), so ajv's `type: "number"` format entries are
effectively no-ops; the function never runs on non-string data.
Keep them in the map if it's simpler; they cost nothing.

## All-issues output (eov's `allErrors`)

`eov`'s default puts the first failing leaf in the top-level
`message`. With `validateRequests: { allErrors: true }`, eov instead
`, `-joins every issue into one `message` string.

`oav` defaults to the same first-leaf summary. For an all-issues
string, use `formatSummary` with `{ select: "all" }`:

```ts
import { formatSummary } from "@oaverify/core";

// Default: first failing leaf, equivalent to eov's default `message`.
formatSummary(err);
// "body.users[0].email must match format \"email\""

// All leaves, one per line. oav's default all-issues shape.
formatSummary(err, { select: "all" });
// body.users[0].email must match format "email" [format]
// body.users[1].age must be >= 0 [minimum]

// eov-shaped: comma-joined, no [code] suffix.
formatSummary(err, { select: "all", separator: ", ", includeCode: false });
// body.users[0].email must match format "email", body.users[1].age must be >= 0
```

`separator` controls the joiner between leaves. `includeCode` toggles
the trailing ` [<code>]`. Both are ignored under single-leaf modes
(`first` / `deepest` / `byCode`). See
[`FormatSummaryOptions`](../packages/core/src/format.ts) for the type.

### Avoiding the path/message stutter on missing-parameter errors

The leaves `oav`'s validator emits for HTTP-level failures (missing
required parameter or body, unknown query key, content-type mismatch,
security) name their location in the message itself, so the default
`<path> <message>` rendering repeats the field name:

```
query.persona missing required query parameter "persona"
```

`eov`/ajv never stutter here because they point the path at the
parent. `oav` keeps the leaf path on the field (it's the
machine-stable handle; `params.name` carries the name too) and fixes
the rendering instead. `path: "auto"` drops the prefix for exactly
those self-locating leaves and keeps it for value errors, where the
path is load-bearing:

```ts
formatSummary(err, { path: "auto" });
// missing required query parameter "persona"     (was: query.persona missing ...)
// body.users[0].email must match format "email"  (unchanged)
```

The affected code set is published as `SELF_LOCATING_ERROR_CODES`;
its TSDoc states the contract (a leaf with one of these codes always
locates the error in its message; parameter value failures always
carry schema-keyword codes instead).

One delta from `eov` remains. `oav` uses dotted paths
(`body.users[0].email`) where `eov` uses slash-separated
(`request/body/users/0/email`). If your client pattern-matches on the
exact `eov` string, render your own with `collectLeaves(err)`.

The same `formatSummary` powers the `detail` field of
`toProblemDetails`. Pass
`{ detail: formatSummary(err, { select: "all", separator: ", ", includeCode: false }) }`
to emit an `eov`-shaped string in your RFC 9457 response body.
