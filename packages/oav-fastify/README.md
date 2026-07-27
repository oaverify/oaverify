# oav-fastify

Fastify adapter for [`@oaverify/core`](https://www.npmjs.com/package/@oaverify/core): a `preValidation` hook factory plus standalone helpers (`httpRequestFromFastify`, `renderProblemDetails`) for callers composing their own hooks.

Same shape as the Express siblings ([`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md), [`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md)); only the framework-typed argument and Fastify's hook-vs-middleware distinction differ. Fastify is async-native, so thrown errors and rejected promises propagate to Fastify's error handler automatically, with no `try/catch` wrapper.

Sibling packages: [`@oaverify/express4`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express4/README.md), [`@oaverify/express5`](https://github.com/oaverify/oaverify/blob/main/packages/oav-express5/README.md). Identical option shapes and defaults; `validateRequests` and `renderProblemDetails` share names across the family, while the `httpRequestFrom*` extractor and `*Context` type carry framework-native names.

## Install

```bash
# JSON specs only
npm install @oaverify/core @oaverify/fastify fastify

# YAML specs + CLI (oav transitively provides oav-core)
npm install oaverify @oaverify/fastify fastify
```

`fastify` is a peer dep; your app's existing install satisfies it.

> **YAML specs.** `@oaverify/core` is JSON-only by design (zero runtime deps). If your spec is YAML, install [`@oaverify/yaml`](https://www.npmjs.com/package/@oaverify/yaml) alongside it and compose its readers, or parse the spec yourself and pass the parsed object to `createValidator`.

## Quick start

```ts
import Fastify from "fastify";
import { createValidator } from "@oaverify/core";
import { validateRequests } from "@oaverify/fastify";

const validator = createValidator(spec); // see "Hardening for untrusted input" below

const app = Fastify();
app.addHook("preValidation", validateRequests(validator));

app.post("/pets", async () => ({ ok: true }));
```

Invalid requests receive a `400 application/problem+json` response (status from `httpStatusFor`, body from `toProblemDetails`, `Allow` header on 405). Valid requests reach the route handlers.

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

A body-size limit (Fastify's `bodyLimit`) and a parse-boundary depth cap in an `onRequest` / `preValidation` hook, applied before the request reaches the validator, are backstops for nesting the validator never traverses (fields the schema doesn't descend into); see [Guarding against deeply nested payloads](https://github.com/oaverify/oaverify/blob/main/docs/configuration.md#guarding-against-deeply-nested-payloads).

## Mount point: `preValidation`

Fastify runs hooks in a fixed order:

1. `onRequest`: request parsing not yet done
2. `preParsing`: about to parse the body
3. `preValidation`: body parsed; **this is where oav runs**
4. `validation`: Fastify's per-route schema validation
5. `preHandler`: about to call the route handler
6. `handler`

Mount on `preValidation` so oav sees the parsed body. If you also have per-route Fastify schemas declared, Fastify's own validation runs in step 4 (after this hook). Both can coexist: if oav rejects, Fastify's own validation never runs; if oav passes, Fastify's runs as usual. Authoring the same constraints in both places isn't recommended, but mixing them (oav for spec-driven validation, Fastify schemas for app-internal types) works.

## API

### `validateRequests(validator, options?)`

Returns a Fastify `preValidationHookHandler`.

| option          | type                                                        | default                  |
| --------------- | ----------------------------------------------------------- | ------------------------ |
| `toHttpRequest` | `(request: FastifyRequest) => HttpRequest`                  | `httpRequestFromFastify` |
| `onError`       | `(errors: ValidationError[], ctx) => void \| Promise<void>` | `renderProblemDetails`   |

`onError` may be async; the hook awaits it. Fastify awaits the returned promise, so thrown extractor errors and rejected `onError` promises propagate to Fastify's `setErrorHandler` automatically, no `try/catch` needed. The hook does **not** call `reply.send()` after `onError` returns; your callback owns the response (write to `ctx.reply`, or throw to delegate to Fastify's error handler).

> **Validation failures don't traverse Fastify's `setErrorHandler` by default.** The default `onError` (`renderProblemDetails`) writes the response directly. If you want validation failures in your existing error pipeline, throw from `onError` (Fastify routes throws to `setErrorHandler`) or compose a logger before `renderProblemDetails`; see [Add observability without changing the response](#add-observability-without-changing-the-response).

### `validateResponses(validator, options?)`

Opt-in `onSend` hook that validates outgoing responses against the spec. No monkey-patching: Fastify's `onSend` receives the serialized payload natively. Register it where you want response checking, conventionally on in development and off in production:

```ts
import { validateResponses } from "@oaverify/fastify";

if (process.env.NODE_ENV !== "production") {
  app.addHook("onSend", validateResponses(validator));
}
```

| option          | type                                                        | default                         |
| --------------- | ----------------------------------------------------------- | ------------------------------- |
| `toHttpRequest` | `(request: FastifyRequest) => HttpRequest`                  | `httpRequestFromFastify`        |
| `statuses`      | `(status: number) => boolean`                               | validate every status           |
| `onError`       | `(errors: ValidationError[], ctx) => void \| Promise<void>` | throw `ResponseValidationError` |

The default `onError` throws a `ResponseValidationError` (routed to `setErrorHandler`, since a non-conforming response is a server bug). Return normally from a custom `onError` to log-and-continue: the original payload is sent unchanged. Every declared status is checked by default (4xx / 5xx too); an undeclared status is itself a finding.

Status and declared headers are checked for every reply, regardless of media type: a 204, a redirect, or a text error page still has a status the spec may not declare and headers it may require, and those checks don't depend on the body. The body is validated only when the payload is a parseable JSON string. Buffers, streams, non-JSON content types, and malformed JSON pass their bodies through untouched (status and headers still checked). A missing body is not itself a finding by default, since OpenAPI declares response content without a required flag; build the validator with `requireResponseBody: true` (see `ValidatorOptions`) to make it one (HEAD and 204 / 205 / 304 stay exempt). With that flag on, the pass-through cases above also count as absent, since the hook hands the validator a body only when the payload parsed as JSON.

### `httpRequestFromFastify(request)`

Convert a `FastifyRequest` to oav's framework-agnostic `HttpRequest` shape. Read what's already on the request; body parsing is Fastify's responsibility (handled by content-type parsers before `preValidation`).

Header keys passed through (Fastify already lowercases per HTTP spec), path stripped of query string from `request.url`, query taken from `request.query` (Fastify parses it into an object), cookies read from `request.cookies` if `@fastify/cookie` populated them.

**Returns a fresh `HttpRequest`.** Top-level fields can be reassigned freely without affecting the original `FastifyRequest`; safe to spread (`{ ...httpRequestFromFastify(req), body: {} }`) or mutate in place.

Use this when you want to compose your own hook (e.g. validate inside a custom plugin) without re-implementing the extraction.

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
    if (errors.some((e) => e.code === "security")) return ctx.reply.code(401).send();
    renderProblemDetails(errors, ctx);
  },
});
```

## Common patterns

### Enable shape-only security checks (no auth middleware yet)

`ValidatorOptions.validateSecurity` is off by default; real apps run auth middleware (or hooks) upstream of the validator. During early dev (no auth wired yet) or with decorator-only auth that just attaches `request.user`, opt in:

```ts
const validator = createValidator(spec, { validateSecurity: "shape" });
app.addHook("preValidation", validateRequests(validator));
```

The check is shape-only: it confirms the declared credential is _present_, not that it's _valid_. Don't treat it as a substitute for auth middleware.

### Custom error envelope

```ts
app.addHook(
  "preValidation",
  validateRequests(validator, {
    onError: (errors, ctx) => {
      ctx.reply.code(httpStatusFor(errors)).send({
        message: `${errors.length} validation error(s)`,
        errors: collectIssues(errors),
      });
    },
  }),
);
```

### Forward to Fastify's `setErrorHandler`

Throw from `onError`; Fastify routes thrown errors to `setErrorHandler`:

```ts
app.addHook(
  "preValidation",
  validateRequests(validator, {
    onError: (errors) => {
      throw new ValidationFailure(errors);
    },
  }),
);

app.setErrorHandler((err, _request, reply) => {
  if (err instanceof ValidationFailure) {
    reply.code(422).send({ ... });
    return;
  }
  // ... your existing error handler
});
```

### Add observability without changing the response

Validation failures don't reach your registered `setErrorHandler` by default (the hook terminates the request itself). To log every failure while keeping the default problem-details response, compose `renderProblemDetails` after your log call:

```ts
app.addHook(
  "preValidation",
  validateRequests(validator, {
    onError: (errors, ctx) => {
      log.warn("validation failed", { url: ctx.request.url, codes: errors.map((e) => e.code) });
      renderProblemDetails(errors, ctx);
    },
  }),
);
```

Use this whenever your existing error pipeline (Sentry, structured logger, request-id correlation) needs to see validation failures without changing the response shape.

### Async `onError` (remote logging, dynamic config)

```ts
app.addHook(
  "preValidation",
  validateRequests(validator, {
    onError: async (errors, ctx) => {
      await sentry.captureException(errors);
      renderProblemDetails(errors, ctx);
    },
  }),
);
```

The hook awaits the returned promise; rejections propagate to Fastify's `setErrorHandler`.

### Coexisting with Fastify per-route schemas

Fastify's idiomatic per-route-schema pattern is independent of oav. The two can coexist in the same app:

- Use **oav-fastify** when the OpenAPI spec is the source of truth, for endpoints whose contract is published / contract-tested / shared with other languages or services.
- Use **Fastify per-route schemas** for app-internal types where you'd rather author the schema inline.

If both fire on the same route, oav's `preValidation` hook runs first; if it passes, Fastify's `validation` step runs next. Don't author the same constraints in both places.

### Comparison with `fastify-openapi-glue`

[`fastify-openapi-glue`](https://www.npmjs.com/package/fastify-openapi-glue) reads an OpenAPI spec at startup and **generates routes + handler stubs from it**. oav-fastify is a different shape: it validates against the spec while leaving route declarations in your app. Use `fastify-openapi-glue` if you want spec-driven scaffolding; use oav-fastify if your routes already exist and you want OpenAPI as the validation source of truth.

## See also

- [`@oaverify/core`](https://www.npmjs.com/package/@oaverify/core): `createValidator`, `ValidatorOptions`, `formatSummary`, `collectIssues`, `httpStatusFor`, `toProblemDetails`.
- [`oaverify`](https://www.npmjs.com/package/oaverify): the CLI. The library is `@oaverify/core`.
- The repo-root [`docs/integration.md`](https://github.com/oaverify/oaverify/blob/main/docs/integration.md): broader recipes (security, file uploads, response validation, status mapping, type coercion, ignoring paths).
- The repo-root [`docs/migration-from-eov.md`](https://github.com/oaverify/oaverify/blob/main/docs/migration-from-eov.md): porting from `express-openapi-validator`.
- [`@oaverify/stream`](https://www.npmjs.com/package/@oaverify/stream): for JSON bodies past what `bodyLimit` should buffer, validates the bytes as they stream; `oaverify stream-check spec.yaml` reports which of a spec's bodies can stream.
