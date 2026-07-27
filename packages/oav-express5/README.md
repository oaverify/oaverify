# oav-express5

Express 5 adapter for [`oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core): a promise-native middleware factory plus standalone helpers (`httpRequestFromExpress`, `renderProblemDetails`) for callers composing their own middleware.

Same shape as the [`oav-express4`](https://github.com/aahoughton/oav/blob/main/packages/oav-express4/README.md) sibling; only the framework-typed argument and the async semantics differ. Express 5's promise-native middleware means thrown errors and rejected promises propagate to the host's error middleware automatically, with no `try/catch` wrapper.

Sibling packages: [`oav-express4`](https://github.com/aahoughton/oav/blob/main/packages/oav-express4/README.md), [`oav-fastify`](https://github.com/aahoughton/oav/blob/main/packages/oav-fastify/README.md). Identical option shapes and defaults; `validateRequests` and `renderProblemDetails` share names across the family, while the `httpRequestFrom*` extractor and `*Context` type carry framework-native names.

> **Migrating from `express-openapi-validator`?** See [docs/migration-from-eov.md](https://github.com/aahoughton/oav/blob/main/docs/migration-from-eov.md) for behavior differences (path-label `/params/` → `/path/`, `errorCode` namespacing, status mapping) and a worked porting walkthrough.

## Install

```bash
# JSON specs only
npm install @aahoughton/oav-core @aahoughton/oav-express5 express

# YAML specs + CLI (oav transitively provides oav-core)
npm install @aahoughton/oav @aahoughton/oav-express5 express
```

`express` is a peer dep; your app's existing install satisfies it.

> **YAML specs.** `oav-core` is JSON-only by design (zero runtime deps). If your spec is YAML, install [`@aahoughton/oav-yaml`](https://www.npmjs.com/package/@aahoughton/oav-yaml) alongside it and compose its readers, or parse the spec yourself and pass the parsed object to `createValidator`.

## Quick start

```ts
import express from "express";
import { createValidator } from "@aahoughton/oav-core";
import { validateRequests } from "@aahoughton/oav-express5";

const validator = createValidator(spec); // see "Hardening for untrusted input" below

const app = express();
app.use(express.json()); // ← MUST run before validateRequests
app.use(validateRequests(validator));

app.post("/pets", (req, res) => res.json({ ok: true }));
```

Invalid requests receive a `400 application/problem+json` response (status from `httpStatusFor`, body from `toProblemDetails`, `Allow` header on 405). Valid requests reach the route handlers.

> **Body parser ordering matters.** `express.json()` (or any equivalent that populates `req.body` with a parsed object) must run **before** `validateRequests(...)`. Same for `cookie-parser` if your spec validates cookies. Any middleware that populates `req.body` works: `express.json()`, `body-parser`, custom streaming parsers, app-specific middleware all work the same way.
>
> **Empty-body normalization.** Some parsers leave `req.body === undefined` for empty `{}`-equivalent payloads. When that happens, `required`-field checks short-circuit on the missing body. Normalize via `toHttpRequest`:
>
> ```ts
> import { httpRequestFromExpress, validateRequests } from "@aahoughton/oav-express5";
>
> app.use(
>   validateRequests(validator, {
>     toHttpRequest: (req) => ({ ...httpRequestFromExpress(req), body: req.body ?? {} }),
>   }),
> );
> ```

## Hardening for untrusted input

The quick start is the minimal wiring. Before exposing the validator to untrusted callers, cap two things so a small, cheap payload can't burn CPU or exhaust the stack. Both are `createValidator` options, and both default to uncapped, so the quick start above sets neither.

```ts
const validator = createValidator(spec, {
  maxDepth: 64, // recursion cap: a body nesting past 64 levels fails as 400
  maxErrors: 10, // stop after 10 errors instead of walking a huge invalid body
});
```

- **`maxDepth`** bounds recursion through self-referential (`$ref`) schemas. Without it, a few KB of deeply nested JSON can exhaust the call stack and surface as a 500. Past the cap, validation emits a `depth` error (mapped to 400) instead of descending. Legitimate payloads rarely recurse beyond ten or fifteen levels, so 32 to 64 is generous.
- **`maxErrors`** caps how many errors one request can produce, in compute and in response size: a large array whose every element fails the same way otherwise yields one error per element. Results carry `truncated: true` when the cap was hit. Leave it unset in development if you want every error at once.

A byte-size limit (`express.json({ limit })`) and a parse-boundary depth cap, applied before the request reaches the validator, are backstops for nesting the validator never traverses (fields the schema doesn't descend into); see [Guarding against deeply nested payloads](https://github.com/aahoughton/oav/blob/main/docs/configuration.md#guarding-against-deeply-nested-payloads).

## API

### `validateRequests(validator, options?)`

Returns an Express 5 promise-returning `RequestHandler`.

| option          | type                                                        | default                  |
| --------------- | ----------------------------------------------------------- | ------------------------ |
| `toHttpRequest` | `(req: Request) => HttpRequest`                             | `httpRequestFromExpress` |
| `onError`       | `(errors: ValidationError[], ctx) => void \| Promise<void>` | `renderProblemDetails`   |

`onError` may be async; the middleware awaits it. Express 5 awaits the returned promise, so thrown extractor errors and rejected `onError` promises propagate to the host's error middleware automatically, no `try/catch` needed. The middleware does **not** call `next()` after `onError` returns; your callback owns the response (write to `ctx.res`, or call `ctx.next(err)` to delegate).

> **Validation failures don't traverse Express's error chain by default.** The default `onError` (`renderProblemDetails`) writes the response directly. If you're migrating from `express-openapi-validator` (which emits validation failures as `HttpError` through `next(err)`), your existing error middleware won't see oav's failures unless you forward them; see [Forward to Express's error middleware](#forward-to-expresss-error-middleware) below. Same goes for observability: see [Add observability without changing the response](#add-observability-without-changing-the-response).

### `validateResponses(validator, options?)`

Opt-in middleware that validates outgoing responses (`res.json`, `res.send`) against the spec. Mount it where you want response checking, conventionally on in development and off in production:

```ts
import { validateResponses } from "@aahoughton/oav-express5";

if (process.env.NODE_ENV !== "production") {
  app.use(validateResponses(validator));
}
```

Mount it after `validateRequests`. Mounted before, it also validates the 400 problem-details bodies the request validator renders; unless the spec declares those responses, every request-validation 400 becomes a 500 finding.

| option          | type                                                        | default                         |
| --------------- | ----------------------------------------------------------- | ------------------------------- |
| `toHttpRequest` | `(req: Request) => HttpRequest`                             | `httpRequestFromExpress`        |
| `statuses`      | `(status: number) => boolean`                               | validate every status           |
| `onError`       | `(errors: ValidationError[], ctx) => void \| Promise<void>` | throw `ResponseValidationError` |

The default `onError` throws a `ResponseValidationError` (propagated to your error middleware, since a non-conforming response is a server bug). Return normally from a custom `onError` to log-and-continue: the original body is sent unchanged. Every declared status is checked by default (4xx / 5xx too); an undeclared status is itself a finding. Only the core `validateResponse` stays pure; this is the one place the adapter wraps `res`, and only where you mount it.

**Split-phase: status and headers always, body when it's JSON.** Status and declared headers are checked for every response that flows through `res.send`, regardless of media type, so an undeclared status or a missing required header on a 204, a text error page, or `res.sendStatus` is a finding. The body is validated only when it is a parseable JSON string: the middleware wraps `res.send`, the one point every JSON response passes through serialized (`res.json` stringifies and re-dispatches through it), parses that string, and validates the result. Serialization runs first, so `toJSON` methods (ORM documents, `Date` fields), the app's `json replacer` / `json spaces` settings, and dropped `undefined` keys are all reflected in what is checked: validation sees exactly what the client receives. Cost is one `JSON.parse` per JSON response while mounted; mount it dev-only and that cost never reaches production.

Body validated: `res.json(obj)`, `res.send(obj)`, `res.send(jsonString)` with a JSON content type, `res.jsonp` without a callback parameter, and the bodies Express computes for HEAD requests (a HEAD request validates against the GET operation when the spec declares no HEAD). Status and headers validated, body not: non-JSON string sends (text error pages, `res.sendStatus`, `res.jsonp` with a callback), malformed JSON strings, and an empty body (`res.json()` with no argument). A missing body is not itself a finding by default, since OpenAPI declares response content without a required flag; build the validator with `requireResponseBody: true` (see `ValidatorOptions`) to make it one, catching the empty-200 bug where `res.json(user)` ran with an `undefined` lookup result (HEAD and 204 / 205 / 304 stay exempt). With that flag on, every body-not-validated case in this list counts as absent, since the middleware hands the validator a body only when it parsed as JSON. Not covered at all (these bypass `res.send`): Buffers, streamed bodies (`res.write` / `res.end`), `res.sendFile`, redirects (`res.redirect` uses `res.end`), and apps that override `res.json` with a custom serializer that writes to the socket itself (stock `res.json` re-dispatches through `res.send`; an override that pipes directly never does). For a response path the middleware can't see, call `validator.validateResponse` directly at the layer you own; it stays a pure function for exactly this reason.

**Error-middleware responses are responses too.** A body your error middleware renders for an ordinary thrown error is validated like any other, so declare your error statuses in the spec or scope them out with `statuses`. The exception is the reply to a response-validation failure itself, which is never re-validated (no loop). Mounting the middleware twice on one chain fails every request with a clear error instead of validating twice.

### `httpRequestFromExpress(req)`

Convert an Express 5 `Request` to oav's framework-agnostic `HttpRequest` shape. Read what's already on `req`; body parsing is the host app's responsibility.

Header keys lowercased, path stripped of query string, cookies read from `req.cookies` if present.

**Returns a fresh `HttpRequest`.** Top-level fields can be reassigned freely without affecting the original Express `req`; safe to spread (`{ ...httpRequestFromExpress(req), body: {} }`) or mutate in place. The values it references (`req.body`, `req.headers`) are still the originals; deep mutation would still leak, but reassignment doesn't.

Use this when you want to compose your own middleware (e.g. validate inside an existing custom wrapper) without re-implementing the extraction.

### `renderProblemDetails(errors, ctx)`

The default `onError`. Takes the flat list of failing leaves and writes
an RFC 9457 `application/problem+json` body (via `toProblemDetails`),
status from `httpStatusFor`, `Allow` header from `allowHeaderFor` on 405.
`onError` receives the same leaf list whatever `output` the validator
uses (a tree validator's result is flattened first).

Exported standalone so a custom `onError` can call it as the fallback path:

```ts
validateRequests(validator, {
  onError: (errors, ctx) => {
    if (errors.some((e) => e.code === "security")) return ctx.res.status(401).end();
    renderProblemDetails(errors, ctx);
  },
});
```

## Common patterns

### Enable shape-only security checks (no auth middleware yet)

`ValidatorOptions.validateSecurity` is off by default; real apps run auth middleware upstream of the validator, so by the time `validateRequests` runs the credential has already been verified. During early dev (no auth wired yet) or with decorator-only auth that just attaches `req.user`, opt in:

```ts
const validator = createValidator(spec, { validateSecurity: "shape" });
app.use(validateRequests(validator));
```

The check is shape-only: it confirms the declared credential is _present_, not that it's _valid_. Don't treat it as a substitute for auth middleware.

### Skip validation for paths the spec doesn't declare

The validator owns this: pass it `ignorePaths` or `ignoreUndocumented` at construction. See `ValidatorOptions` in `oav-core` for the contract.

```ts
const validator = createValidator(spec, {
  ignorePaths: (p) => p.startsWith("/internal/"),
});
app.use(validateRequests(validator));
```

### Custom error envelope

```ts
app.use(
  validateRequests(validator, {
    onError: (errors, ctx) => {
      ctx.res.status(httpStatusFor(errors)).json({
        message: `${errors.length} validation error(s)`,
        errors: collectIssues(errors),
      });
    },
  }),
);
```

### Forward to Express's error middleware

```ts
app.use(
  validateRequests(validator, {
    onError: (errors, ctx) => ctx.next(new ValidationFailure(errors)),
  }),
);

app.use((err, _req, res, _next) => {
  if (err instanceof ValidationFailure) {
    res.status(422).json({ ... });
    return;
  }
  // ... your existing error handler
});
```

### Add observability without changing the response

Validation failures don't reach your registered Express error middleware by default (the middleware terminates the request itself). To log every failure while keeping the default problem-details response, compose `renderProblemDetails` after your log call:

```ts
app.use(
  validateRequests(validator, {
    onError: (errors, ctx) => {
      log.warn("validation failed", { path: ctx.req.path, codes: errors.map((e) => e.code) });
      renderProblemDetails(errors, ctx);
    },
  }),
);
```

Use this whenever your existing error pipeline (Sentry, structured logger, request-id correlation) needs to see validation failures without changing the response shape.

### Async `onError` (remote logging, dynamic config)

```ts
app.use(
  validateRequests(validator, {
    onError: async (errors, ctx) => {
      await sentry.captureException(errors);
      renderProblemDetails(errors, ctx);
    },
  }),
);
```

The middleware awaits the returned promise. Express 5 awaits the middleware itself, so rejections route through Express's native promise handling to the host's error middleware.

### Per-route mounting

`validateRequests(...)` is route-aware (it derives the operation from method+path). Mount it once at the app level; per-route mounting is redundant and may cause double-validation under nested routers.

### Global validator + per-route multer (file uploads)

When the validator is mounted globally and one or a few routes accept file uploads via multer, mount multer at the route prefix that needs it (upstream of the global validator) and use `toHttpRequest` to synthesize the spec-shaped body from `req.files`. See the [integration.md file uploads recipe](https://github.com/aahoughton/oav/blob/main/docs/integration.md#file-uploads-with-multer) for the full pattern; the only difference for Express 5 is the lack of `try/catch` (which neither the recipe nor the adapter needs).

## Express 4 vs Express 5

Same package shape, same exports, same defaults. The only differences:

- The middleware returned by `validateRequests` is `async` (Express 5 awaits returned promises).
- No `try/catch` wrapper around the extractor; Express 5 routes thrown errors and rejected promises to the error chain via the promise itself.
- `peerDependencies` requires `express ^5.0.0` (oav-express4 requires `^4.0.0`).

A migrating consumer's `import { validateRequests } from "@aahoughton/oav-express5"` is the only line that changes after upgrading from oav-express4.

## See also

- [`oav-core`](https://www.npmjs.com/package/@aahoughton/oav-core): `createValidator`, `ValidatorOptions`, `formatSummary`, `collectIssues`, `httpStatusFor`, `toProblemDetails`.
- [`oav`](https://www.npmjs.com/package/@aahoughton/oav): oav-core plus YAML readers and the `oav` CLI.
- The repo-root [`docs/integration.md`](https://github.com/aahoughton/oav/blob/main/docs/integration.md): broader recipes (security, file uploads, response validation, status mapping, type coercion, ignoring paths).
- The repo-root [`docs/migration-from-eov.md`](https://github.com/aahoughton/oav/blob/main/docs/migration-from-eov.md): porting from `express-openapi-validator`.
- [`oav-stream-validator`](https://www.npmjs.com/package/@aahoughton/oav-stream-validator): for JSON bodies too large to buffer through `express.json()`, validates the bytes as they stream; `oav stream-check spec.yaml` reports which of a spec's bodies can stream.
