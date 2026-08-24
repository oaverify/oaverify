# Integration guide

Use this guide when you have an OpenAPI document and want request or
response validation inside an HTTP framework. The common integrations
have adapter packages; other runtimes use the framework-agnostic
validator surface, or the Fetch helpers when the framework exposes
Web Standards `Request` / `Response`.

| Your app uses                        | Start here                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Express 4                            | [`@oaverify/express4`](../packages/oav-express4/README.md), then [Express 4](#express-4)      |
| Express 5                            | [`@oaverify/express5`](../packages/oav-express5/README.md), then [Express 5](#express-5)      |
| Fastify                              | [`@oaverify/fastify`](../packages/oav-fastify/README.md), then [Fastify](#fastify)            |
| Next.js, Hono, Bun, Deno, Fetch APIs | [`validateFetchRequest`](#nextjs-app-router-hono-bun-deno)                                    |
| Another framework                    | [What the validator expects](#what-the-validator-expects)                                     |
| A custom error response shape        | [Preserving an existing client error envelope](#preserving-an-existing-client-error-envelope) |
| File uploads, auth, response checks  | [Cross-cutting recipes](#cross-cutting-recipes)                                               |

Adapters handle request validation and default
`application/problem+json` responses. Response validation, upload
parsing, authentication, and application-specific error envelopes stay
explicit so they fit the service you already have; the
[cross-cutting recipes](#cross-cutting-recipes) cover those.

## What the validator expects

`validateRequest` / `validateResponse` take a framework-agnostic
shape. The adapter's job is extracting these fields from your
framework's own request object:

```ts
interface HttpRequest {
  method: string; // uppercase verb
  path: string; // pathname only, no query
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>; // adapters lowercase; matching is case-insensitive
  contentType?: string; // the only media-type source; NOT read from headers
  body?: unknown; // already-parsed
  cookies?: Record<string, string | string[]>; // an array is a repeated name
}

interface HttpResponse {
  status: number;
  contentType?: string; // same rule as HttpRequest.contentType
  headers?: Record<string, string | string[]>; // matched case-insensitively
  body?: unknown;
}
```

`contentType` is the only place the validator looks for the media type,
and it is deliberately **not** derived from `headers`, even though
`Content-Type` is a header and header _parameters_ are matched there
case-insensitively. One explicit field beats two sources that can
disagree. Every adapter sets it, and a hand-built request has to:
filling in `headers["content-type"]` and leaving the field unset
produces a `content-type` error that says as much. The contract lives on
`HttpRequest.contentType`'s TSDoc.

Both methods return a result object: `{ valid: true }` on success, or
`{ valid: false, errors, truncated }` on failure. By default `errors`
is a flat `ValidationError[]` (one entry per failing leaf), and
`truncated` indicates whether the error budget cut the list short. Each
error's `code`, dotted path, and pointer locate the failure under
`body`, `query.<name>`, `headers.<name>`, etc.

## Supporting helpers

All shipped from `oaverify` (or `@oaverify/core` for the lean
install); the recipes below assume they are in scope. All but
`formatSummary` accept either a single `ValidationError` tree or a
flat `ValidationError[]`, so `result.errors` passes straight through.

| Helper                              | Gives you                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `httpStatusFor(errors, overrides?)` | The HTTP status for the failure; table and overrides under [Status-code mapping](#status-code-mapping)                                                                                           |
| `allowHeaderFor(errors)`            | The `Allow` header value for a 405 (RFC 9110 §15.5.6 requires it), else `undefined`                                                                                                              |
| `toProblemDetails(errors, opts?)`   | An [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) `application/problem+json` body, failing leaves in `issues`; pass `status` to match the response and `detail` to override the summary |
| `formatSummary(err, opts?)`         | One tree as a string, for log lines and monitoring titles; `FormatSummaryOptions.select` picks which leaves (`{ select: "all" }` enumerates every one)                                           |
| `collectIssues(errors)`             | The flat leaf list for custom envelopes, each with a raw `path: PathSegment[]` and an RFC 6901 `pointer`                                                                                         |

## Per-framework integration

The three adapter packages share export names, options and defaults:
`validateRequests(validator, options?)`, with status from
`httpStatusFor`, `Allow` from `allowHeaderFor` on 405, and an RFC 9457
`application/problem+json` body from `toProblemDetails` carrying that
same status. Each also
exports its extractor (`httpRequestFromExpress` /
`httpRequestFromFastify`) and `renderProblemDetails` standalone, for
callers composing their own middleware. The adapter READMEs
([express4](../packages/oav-express4/README.md),
[express5](../packages/oav-express5/README.md),
[fastify](../packages/oav-fastify/README.md)) carry the options
(`toHttpRequest`, `onError`), async `onError` semantics, and
adapter-specific patterns; the sections below cover what differs per
framework. Cross-cutting recipes (body parsers, file uploads,
security, response validation) are below.

### Express 4

```ts
import { validateRequests } from "@oaverify/express4";

app.use(express.json()); // any middleware that populates req.body satisfies oaverify
app.use(validateRequests(validator));
```

**Manual middleware (when you need full control).** Use the
[Express 5 snippet below](#express-5) with one change: Express 4
doesn't await returned promises, so async errors don't propagate.
Wrap the body in `try { ... } catch (e) { next(e) }`.

**Building the validator at boot.** If your Express 4 setup is
synchronous (say a middleware factory that returns the handler array
directly), awaiting `loadSpec` means making the whole bootstrap async
and threading a Promise through just to build one validator.
`loadSpecSync` resolves the spec (cross-file `$ref`s included) without
one, so the validator is ready inline:

```ts
import { createValidator } from "@oaverify/core";
import { loadSpecSync } from "@oaverify/syntax";
import { validateRequests } from "@oaverify/express4";

const { document } = loadSpecSync({ entry: "openapi.yaml" });
app.use(express.json());
app.use(validateRequests(createValidator(document)));
```

Blocking filesystem reads, so it's for boot, not per-request; it throws
on an unreadable spec, so wrap it in `try/catch` if a missing spec
should disable validation instead of aborting startup. See the
[synchronous loading](https://github.com/oaverify/oaverify/blob/main/packages/spec/README.md#synchronous-loading)
docs.

### Express 5

Same shape as `@oaverify/express4` but promise-native, so the manual
form needs no `try/catch` wrapper:

```ts
import { validateRequests } from "@oaverify/express5";

app.use(express.json());
app.use(validateRequests(validator));
```

**Manual middleware (when you need full control).** Express 5 is
promise-native: async middleware that throws routes to the error
handler automatically.

```ts
app.use(async (req, res, next) => {
  const result = validator.validateRequest({
    method: req.method,
    path: req.path,
    query: req.query as Record<string, string | string[]>,
    headers: req.headers as Record<string, string | string[]>,
    contentType: req.get("content-type") ?? undefined,
    body: req.body,
    cookies: req.cookies,
  });
  if (result.valid) return next();
  const allow = allowHeaderFor(result.errors);
  if (allow !== undefined) res.setHeader("Allow", allow);
  const status = httpStatusFor(result.errors);
  res
    .status(status)
    .type("application/problem+json")
    .json(toProblemDetails(result.errors, { status, instance: req.originalUrl }));
});
```

Requires `express.json()` (or any equivalent middleware that populates
`req.body` with a parsed object) registered before this middleware, and
`cookie-parser` if you use the `cookies` field. oaverify doesn't care
_how_ `req.body` got populated, only that it's there. See
[body-parser caveats](#body-parser-caveats) for the sharp edges.

### Fastify

Same shape as the Express adapters but Fastify-native: a
`preValidation` hook, not middleware. The
[adapter README](../packages/oav-fastify/README.md) also covers the
relationship to Fastify's own per-route schema validation.

```ts
import { validateRequests } from "@oaverify/fastify";

app.addHook("preValidation", validateRequests(validator));
```

**Manual hook (when you need full control).** Register as a
`preValidation` hook so it runs after Fastify's own body parsing
but before the route handler.

```ts
fastify.addHook("preValidation", async (request, reply) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  const result = validator.validateRequest({
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: request.headers as Record<string, string | string[]>,
    contentType: request.headers["content-type"],
    body: request.body,
  });
  if (!result.valid) {
    const allow = allowHeaderFor(result.errors);
    if (allow !== undefined) reply.header("Allow", allow);
    const status = httpStatusFor(result.errors);
    return reply
      .code(status)
      .type("application/problem+json")
      .send(toProblemDetails(result.errors, { status, instance: request.url }));
  }
});
```

Fastify parses JSON bodies automatically; for other formats register
the appropriate content-type parser (`@fastify/formbody`, etc.)
ahead of the hook. Fastify's own JSON-parse-error response (shape:
`{ statusCode, code: "FST_ERR_CTP_INVALID_JSON_BODY", ... }`) fires
before `preValidation` runs; register `fastify.setErrorHandler` if
you want `application/problem+json` for those too.

Note: Fastify's idiomatic per-route-schema pattern (`route({ schema:
{ body, response } })`) is independent of oaverify. Use `@oaverify/fastify` when
the OpenAPI spec is the source of truth; use Fastify's built-in
schema validation when you author schemas inline.

### Next.js (App Router), Hono, Bun, Deno

These frameworks dispatch to Web Standards `Request` handlers per
route. Each also has a cross-cutting hook (Next.js's `proxy.ts`,
renamed from `middleware.ts` in Next 16, with both still working;
Hono's `app.use('*', ...)`; Bun / Deno framework-specific hooks),
so you can pick. Use per-route when you want the `<Body>` generic to flow
into the typed success branch; use the cross-cutting hook when you'd
rather register the adapter once.

Per-route form with `validator.validateFetchRequest<T>`. It reads
`request.url`, `request.headers`, and the body (dispatching on
`Content-Type`: JSON, `*+json`, URL-encoded, multipart, text, or raw
bytes) and returns a discriminated union.

```ts
// app/pets/route.ts
import { allowHeaderFor, httpStatusFor, toProblemDetails } from "@oaverify/core";
import { validator } from "@/lib/validator";

type CreatePet = { name: string; tag?: string };

export async function POST(request: Request) {
  const result = await validator.validateFetchRequest<CreatePet>(request);
  if (!result.ok) {
    const allow = allowHeaderFor(result.errors);
    const headers: Record<string, string> = { "Content-Type": "application/problem+json" };
    if (allow !== undefined) headers["Allow"] = allow;
    const status = httpStatusFor(result.errors);
    return Response.json(toProblemDetails(result.errors, { status, instance: request.url }), {
      status,
      headers,
    });
  }
  const { body } = result; // typed as CreatePet
  // ...handler logic
  return Response.json({ id: createPet(body) }, { status: 201 });
}
```

Four things to know:

- **Body is consumed.** `Request.body` is a one-shot stream;
  `validateFetchRequest` reads it. If you need the original bytes,
  `request.clone()` first.
- **The read is capped at 1 MiB.** No body-parser layer runs under a
  Fetch handler, so the adapter drains the stream itself and bounds it
  as it goes. An over-cap body returns a `body-too-large` error (HTTP
  413 via `httpStatusFor`) instead of being read. Raise or remove it
  with `createValidator(spec, { maxTotalBytes })`; see
  [configuration](./configuration.md#bounding-how-much-of-a-body-is-read).
- **Typed body narrows via the generic, not runtime inference.** The
  validator has just confirmed the body matches the spec's schema, so
  the cast is safe for a handler using the same schema. If you change
  the spec, update the generic.
- **Repeated query keys.** `validateFetchRequest` collapses
  `?ids=1&ids=2` into `query.ids = ["1", "2"]`. Single values stay
  strings.

**Next.js, cross-cutting alternative.** `proxy.ts` (or
`middleware.ts` on Next 15) runs on every request. Since Next 15
middleware supports the Node runtime and Next buffers the body,
you can put the adapter there instead:

```ts
// proxy.ts (Next 16+) / middleware.ts (Next 15)
import { allowHeaderFor, httpStatusFor, toProblemDetails } from "@oaverify/core";
import { NextResponse, type NextRequest } from "next/server";
import { validator } from "@/lib/validator";

export const config = {
  runtime: "nodejs",
  matcher: "/:path*",
};

export async function middleware(request: NextRequest) {
  const result = await validator.validateFetchRequest(request);
  if (result.ok) return NextResponse.next();
  const allow = allowHeaderFor(result.errors);
  const headers: Record<string, string> = { "Content-Type": "application/problem+json" };
  if (allow !== undefined) headers["Allow"] = allow;
  const status = httpStatusFor(result.errors);
  return new NextResponse(
    JSON.stringify(toProblemDetails(result.errors, { status, instance: request.url })),
    { status, headers },
  );
}
```

Pick one: per-route gives you `<T>`-typed bodies; the cross-cutting
hook gives you one-and-done registration but the handler doesn't see
a typed body (middleware and handler both read the request, and Next
clones between them, but the per-route handler can't know what the
middleware validated).

**Fully bespoke body handling.** If the built-in body parsing doesn't
fit (e.g. an unusual content type, or a decode step of your own), use
the lower-level primitive below. To validate a large JSON body
without buffering it, reach for
[`@oaverify/stream`](../packages/stream-validator/README.md)
instead; it checks the bytes as they stream.

```ts
import { httpRequestFromFetch } from "@oaverify/core";

const { httpRequest } = await httpRequestFromFetch(request);
// Mutate httpRequest.body however you need, then:
const result = validator.validateRequest(httpRequest);
```

This extractor fills `cookies` from the `Cookie` header itself, so a
declared cookie parameter is read with no cookie middleware to install.
It is also the one that carries a repeated cookie name, which an
exploded array under 3.2's `style: cookie` needs
(`Cookie: color=blue; color=black`); the Express and Fastify adapters
pass through whatever their cookie plugin built.

Values are percent-decoded and a DQUOTE-wrapped value is unwrapped, so
cookies and query values in one request follow the same rule. That is
right for the default `style: form` and deviates from `style: cookie`,
which says no escaping is applied; see `HttpRequest.cookies`.

**Hono, cross-cutting alternative.** `app.use('*', mw)` can host
the adapter. Hono parallels the per-route Standard-Schema validator
pattern (`@hono/zod-validator` etc.), so per-route with a typed
`<T>` is the native idiom and `c.req.valid('json')` is the
community muscle memory; oaverify's `validateFetchRequest<T>` slots into
the same shape via `c.req.raw`.

**Hono gotcha**: `c.req.raw.body` is a one-shot stream. Don't run
`validateFetchRequest` in BOTH global middleware AND a per-route
handler on the same request; the handler's call sees a consumed
body and fails. Pick one. If using global middleware, stash the
validated body for handlers:

```ts
const app = new Hono<{ Variables: { validatedBody: unknown } }>();
app.use("*", async (c, next) => {
  const result = await validator.validateFetchRequest(c.req.raw);
  if (result.ok) {
    c.set("validatedBody", result.body);
    return next();
  }
  // ...problem+json response
});
app.post("/pets", (c) => {
  const body = c.get("validatedBody") as CreatePet;
  return c.json({ id: "pet_1", name: body.name }, 201);
});
```

**Bun / Deno.** Pick a framework (Hono, Elysia on Bun; Hono, Oak on
Deno) and use its hook idiom; same guidance as above, just under a
different name. For a raw `Bun.serve` / `Deno.serve` handler,
`validateFetchRequest` is the natural fit; there's no hook layer to
register against.

**Validating upstream responses.** The symmetric method
`validateFetchResponse(request, response)` runs the response side of
validation against a Web Standards `Response`. The `request` is used
only to match the operation (method + path); its body is not read.

```ts
const request = new Request(upstreamUrl);
const response = await fetch(request);
const result = await validator.validateFetchResponse<PetList>(request, response);
if (!result.ok) {
  log.warn("upstream returned a response the spec doesn't declare", result.errors);
}
// result.body is the parsed response body, typed as PetList on success.
```

Useful for contract-testing a service integration, or for catching
spec drift when an upstream changes its response shape without
updating the document.

## Cross-cutting recipes

### Patching a spec with overlays

When you consume a spec you don't own (a vendor API, a gateway's
published document), overlays rewrite the document in memory so
application code validates against the shape you actually ship: add
servers, require parameters or security, extend or replace component
schemas, add or remove paths. [docs/overlays.md](./overlays.md) has
the verb surface and recipes; `loadSpec`'s `overlays` option and the
CLI's `--overlay` flag apply them at load time.

### Consuming spec-format overlays

OpenAPI's own [Overlay 1.0](https://spec.openapis.org/overlay/1.0.0)
spec describes overlays as a list of JSONPath-targeted actions
(`{ target, update? | remove? }`). When a third-party tool hands you
an overlay in that format, `@oaverify/core/overlay-spec` translates
it into a typed `SpecOverlay` so it flows through the same
`applyOverlays` path:

```ts
import { applySpecOverlay, type OverlayDocument } from "@oaverify/core/overlay-spec";

// Annotated, not inferred: the actions array is heterogeneous, so an
// inferred literal widens to a union whose members carry `?: undefined`
// properties, and those do not satisfy `JsonValue`'s index signature.
const overlayDoc: OverlayDocument = {
  overlay: "1.0.0",
  info: { title: "tenant overlay", version: "1.0.0" },
  actions: [{ target: "$.info", update: { description: "tenant-A view" } }],
};

const patched = applySpecOverlay(base, overlayDoc);
```

The translator does not ship a JSONPath engine. It recognises a
closed set of `target` shapes (full list in the
[`@oaverify/core/overlay-spec` README](../packages/overlay-spec/README.md))
and throws `UnrecognisedTargetError` on anything outside the set,
with the offending target string in the message. No partial
application: a single malformed action aborts the translation.

For overlays you author yourself, prefer the typed `SpecOverlay`
surface in `@oaverify/core/spec`. The translator is the import path
when you have to consume external spec-format input.

### Status-code mapping

Default mapping:

| `err` shape                       | Status |
| --------------------------------- | ------ |
| top-level `code: "route"`         | 404    |
| top-level `code: "method"`        | 405    |
| any leaf `code: "security"`       | 401    |
| any leaf `code: "content-type"`   | 415    |
| any leaf `code: "status"`         | 500    |
| any leaf `code: "body-too-large"` | 413    |
| otherwise                         | 400    |

This table is request-side: every row reads the failure as "what do I
tell this client about the request they sent", 413 included.

Whatever code you send, pass it to `toProblemDetails` as well. RFC 9457
3.1.2 requires the body's `status` member to carry the same code as the
response, and the default is a constant `400`: a problem-details body
has no direction, so it cannot ask this request-side table on your
behalf. The recipes above all bind it once and use it twice. See
`ProblemDetailsOptions.status` for the contract.

`httpStatusFor` is not the helper for a response-validation result, and
there is no sibling that is. Nothing in the leaf determines the answer:
a gateway holding a response that violates its own contract might
answer 502, serve stale, or pass it through under report-only. Read the
leaves and apply your own policy; `output: "tree"` keeps the enclosing
`response` branch if you want to key on the direction.

Override any slot with the second argument, e.g. APIs that use 422
for schema errors:

```ts
httpStatusFor(err, { default: 422 });
```

Why not write the switch by hand? The obvious `switch (err.code)`
misses `content-type`, `security`, and `status`; those codes are
leaves under a top-level `"request"` / `"response"` wrapper, not the
top-level code itself. `httpStatusFor` handles the tree shape
correctly.

RFC 9110 requires the `Allow` response header on 405s. Use
`allowHeaderFor` to get the comma-joined value:

```ts
const allow = allowHeaderFor(err);
if (allow !== undefined) res.setHeader("Allow", allow);
```

### Redacting field values from problem-details responses

`toProblemDetails` echoes input values and schema metadata into the
response by design: the default `detail` interpolates the offending
value for codes such as `enum`, `format`, and `pattern`, and each
`issues[*].params` carries the machine-readable detail per code (see
`BuiltInErrorParams` for the full set). Right for trusted clients and
developer-facing APIs.

For endpoints whose bodies carry PII (emails, account numbers, free
text), or specs whose internals (mapping keys, allowed enums) shouldn't
be enumerable by an unauthenticated client, that echo is a
data-exposure surface. Two override points: pass `detail` to
`toProblemDetails` for a structural summary, and post-process
`issues[*].params` before sending.

```ts
import {
  allowHeaderFor,
  httpStatusFor,
  toProblemDetails,
  type ValidationError,
} from "@oaverify/core";

function safeProblemDetails(errors: ValidationError[], status: number, instance: string) {
  const pd = toProblemDetails(errors, { status, instance });
  return {
    ...pd,
    // Structural summary; nothing about the offending value reaches detail.
    detail: `${pd.issues.length} validation error(s)`,
    // Clear per-leaf params; clients still get code, path, pointer, message.
    issues: pd.issues.map((issue) => ({ ...issue, params: {} })),
  };
}

app.use(
  validateRequests(validator, {
    onError: (errors, ctx) => {
      // A custom renderer owns the whole response, including the header
      // RFC 9110 15.5.6 requires on a 405.
      const allow = allowHeaderFor(errors);
      if (allow !== undefined) ctx.res.setHeader("Allow", allow);
      const status = httpStatusFor(errors);
      ctx.res
        .status(status)
        .type("application/problem+json")
        .json(safeProblemDetails(errors, status, ctx.req.originalUrl));
    },
  }),
);
```

Clients lose machine-readable detail in exchange for not leaking field
values or schema internals; each issue still carries `code` and
`pointer`. Narrower policies (clear `params` only on specific codes,
keep `enum.allowed` but drop `enum.actual`) compose from the same hook.

### Preserving an existing client error envelope

When a documented client contract can't change without breaking
callers, keep your envelope and fill it from `collectIssues` (per-issue
path, message, code) and `httpStatusFor` (status). Don't walk the tree
by hand; the helpers already handle nested branches, route/method
top-levels, and security/content-type leaves under `request` /
`response` wrappers.

```ts
import { allowHeaderFor, collectIssues, httpStatusFor, type ValidationError } from "@oaverify/core";

// .. or whatever your clients already parse.
type ClientError = {
  message: string;
  errors: Array<{ path: string; message: string; errorCode: string }>;
};

function toClientError(errors: ValidationError[]): ClientError {
  return {
    message: `${errors.length} validation error(s)`,
    errors: collectIssues(errors).map((issue) => ({
      path: issue.pointer, // RFC 6901, e.g. "/body/email"
      message: issue.message,
      errorCode: issue.code, // bare code, e.g. "required"
    })),
  };
}

app.use(
  validateRequests(validator, {
    onError: (errors, ctx) => {
      // Your envelope still owes a 405 its `Allow` header.
      const allow = allowHeaderFor(errors);
      if (allow !== undefined) ctx.res.setHeader("Allow", allow);
      ctx.res.status(httpStatusFor(errors)).json(toClientError(errors));
    },
  }),
);
```

For a `POST /contacts` whose body has `age: 42` (over a `maximum: 30`)
and `email: "not-an-email"` (fails `format: email`), the response would be:

```json
{
  "message": "2 validation error(s)",
  "errors": [
    {
      "path": "/body/age",
      "message": "must be <= 30",
      "errorCode": "maximum"
    },
    {
      "path": "/body/email",
      "message": "must match format email",
      "errorCode": "format"
    }
  ]
}
```

`pointer` prefixes are `/body`, `/query`, `/header`, `/path`,
`/cookie` (not `/params`, which is an `express-openapi-validator`
quirk; see [migration-from-eov.md](./migration-from-eov.md) for the
full diff). Each `issue.params` carries machine-readable detail
(e.g. `{ maximum: 30, actual: 42 }` for `maximum`,
`{ format: "email", actual: "not-an-email" }` for `format`) if you
want to surface structured details too. `BuiltInErrorParams` in
`@oaverify/core` documents the shape per code.

### Report-only: observe before you enforce

Turning a validator on against live traffic usually wants an
observation period: log every violation, reject nothing, enforce once
the spec has caught up with what clients actually send. No option
turns this on; `onError` already decides what happens to a failing
request, so a handler that logs and passes the request through is
report-only. What "pass through" means differs by framework, and it
is the one thing to get right.

**Express 4 and Express 5.** The middleware does not call `next()` after
`onError` returns; the handler owns the response. So a report-only
handler calls `next()` itself, bare:

```ts
import { validateRequests } from "@oaverify/express5";

app.use(
  validateRequests(validator, {
    onError: (errors, { req, next }) => {
      logger.warn({ path: req.path, errors }, "spec violation");
      next(); // no argument: next(err) would reject the request
    },
  }),
);
```

**Fastify.** The mirror image. The `preValidation` hook resolves on its
own once `onError` returns, so passing traffic through means _not_
touching `reply`:

```ts
import { validateRequests } from "@oaverify/fastify";

app.addHook(
  "preValidation",
  validateRequests(validator, {
    onError: (errors, { request }) => {
      request.log.warn({ errors }, "spec violation");
      // No reply.send(): returning is what lets the request continue.
    },
  }),
);
```

Two things worth setting for the observation period itself:

- **Raise `maxErrors`.** The fast-fail default of `1` logs one problem
  per request; `Number.POSITIVE_INFINITY` gives the whole list, which
  is what makes the logs worth reading. Enforcement can go back to the
  default.
- **Log something you can aggregate.** `errors[].code` plus
  `errors[].path` groups cleanly; the rendered message does not.

Response validation has the same shape. `validateResponses` takes an
`onError` too, and returning from it without sending lets the original
payload go out unchanged, so the logging handler above is report-only
there as well. The default is different from the request side: it throws
`ResponseValidationError` rather than rendering a problem-details body.

`ValidateRequestsOptions` in each adapter carries the contract. The
`report-only onError` cases in `framework-tests/` wire all three adapters
up and assert this end to end.

### Body parser caveats

oaverify doesn't parse bodies; it validates already-parsed bodies. Two
sharp edges that bite both inline middleware and the `@oaverify/express4`
adapter:

1. **Malformed JSON throws before oaverify runs.** `express.json()` throws
   a `SyntaxError` on bad JSON, and Express's default error handler
   emits an HTML page. Install an Express error middleware to convert
   it to `application/problem+json` upstream of the validator.

2. **Empty-body normalization.** Some body parsers (streaming
   variants, custom multi-format setups) leave `req.body === undefined`
   for empty `{}`-equivalent payloads instead of an empty object. When
   that happens, oaverify's `required`-field checks short-circuit on the
   missing body, so validation passes for what the client thinks is an
   empty submission, even when the spec marks fields as `required`.
   If your parser does this, normalize before calling `validateRequest`:

   ```ts
   body: req.body ?? {},
   ```

   Stock `express.json()` populates `req.body` to `{}` for an empty
   JSON body, so the default Express stack doesn't hit this, but
   alternative parsers (`body-parser`'s streaming mode, fastify's
   bridge, custom multipart middleware) often do. Under an adapter,
   normalize in a `toHttpRequest` override; each adapter README's
   quick start shows the exact snippet.

Unmatched `Content-Type` needs no extra wiring: even when
`express.json()` leaves `req.body` empty for a non-JSON request,
oaverify reads the declared header, finds no matching media type in the
spec, and returns a `content-type` leaf that maps to 415.

The sibling case (**no Content-Type and no body**) is decided by
whether the parser left a body behind, so it splits by Express major.
Express 4's `express.json()` sets `req.body` to `{}` before it declines
to parse, so a body is present and the missing header is answered:
`content-type` / 415. Express 5's leaves `req.body` undefined, as does
either major with no parser mounted, so the body is absent and the
answer is `body` / 400. Both are pinned in `framework-tests`; see the
empty-POST row in
[migration-from-eov.md](./migration-from-eov.md#behavior-differences-to-watch-for).

### File uploads with multer

Install `multer` and its types yourself, run multer before the
validator, and reconstruct the body for the validator call.

```sh
pnpm add multer
pnpm add -D @types/multer    # else every Express.Multer.File reference goes red
```

```ts
import multer from "multer";
import { createValidator, httpStatusFor, toProblemDetails } from "@oaverify/core";

const upload = multer({ storage: multer.memoryStorage() });

app.post("/avatar", upload.any(), async (req, res, next) => {
  // multer populates req.body with text fields and req.files with the files.
  // Reassemble into the spec's body shape.
  const files = Object.fromEntries(
    ((req.files as Express.Multer.File[]) ?? []).map((f) => [f.fieldname, f.buffer]),
  );
  const result = validator.validateRequest({
    method: req.method,
    path: req.path,
    contentType: req.get("content-type"),
    headers: req.headers as Record<string, string | string[]>,
    body: { ...req.body, ...files },
  });
  if (!result.valid) {
    const status = httpStatusFor(result.errors);
    return res
      .status(status)
      .type("application/problem+json")
      .json(toProblemDetails(result.errors, { status, instance: req.originalUrl }));
  }
  // handler uses req.body + req.files as normal
});
```

The validator already handles the body-type mismatch you'd otherwise
hit: a `{ type: "string", format: "binary" }` field in the spec is
rewritten to an "accept anything" schema before compile, so a Buffer
or Uint8Array passes without a string-type error. `format: "byte"`
(base64) still validates as a string.

#### Global validator + per-route multer

The recipe above is per-route inline: multer and the validator both
live inside the route handler, which suits a single upload route. For
an app with many routes and a few upload endpoints, mount **multer at
the route prefix and the validator globally**, with `toHttpRequest`
synthesizing the spec-shaped body from `req.files`:

```ts
import multer from "multer";
import { httpRequestFromExpress, validateRequests } from "@oaverify/express4";

const upload = multer({ storage: multer.memoryStorage() });

// Mount multer at the route prefix that needs it, before the global validator.
app.use("/uploads", upload.any());

// Global validator with toHttpRequest synthesizing body from req.files.
app.use(
  validateRequests(validator, {
    toHttpRequest: (req) => {
      const httpReq = httpRequestFromExpress(req);
      const files = req.files as Express.Multer.File[] | undefined;
      if (files && files.length > 0) {
        // Match the spec's binary-field shape: array if many, single buffer if one.
        // Adjust to your spec's actual field shape (named-files object, single-file
        // property, etc.).
        httpReq.body = files.length === 1 ? files[0]?.buffer : files.map((f) => f.buffer);
      }
      return httpReq;
    },
  }),
);
```

The `toHttpRequest` extension point is a general seam for **any
"reshape what oaverify sees"** use case: synthesizing a body from
`req.files`, normalizing an empty body to `{}` (see
[body-parser caveats](#body-parser-caveats)), merging headers from
an upstream proxy.

**Watch out for `oneOf` / `anyOf` with binary fields.** The "accept
anything" rewrite means every binary branch matches every input. A
common spec pattern for "one file or many"
(`oneOf [array<binary>, binary]`) is silently ambiguous: both
branches match the same payload, so `oneOf` fails with
`matchCount: 2`. The fix is usually to drop the `oneOf` and accept
the array form (parsers like multer always deliver arrays anyway);
the original spec was already ambiguous before oaverify surfaced it.

### Deriving middleware config from the spec

Multer's `limits.fileSize` and the spec's `maxLength` on a
`format: binary` field are two copies of the same number. To keep
them from drifting, derive the middleware limit from the spec at
startup. `getOperation` returns the resolved, overlay-applied
`OperationObject` for a (method, path) pair, using the same
route-match, `$ref` resolution and overlay application that
validation does; read whatever declaration you need at startup and
the spec stays the single source of truth for middleware config.

`digestOperation` in
[`examples/spec-digest.ts`](../examples/spec-digest.ts) builds on it,
pulling the common facts into a flat shape: content types, body
limits, required headers, security. Copy it and adjust the
interpretation choices (`maxLength` as bytes vs code points, which
`x-*` extensions to recognize) to fit your domain.

### Streaming bodies, large uploads, and the `readBody` override

The built-in `validateFetchRequest` reads the entire request body into
memory to parse it. That suits typical JSON / form payloads but not
large uploads or streams you want to process incrementally. Two
options depending on how much of the fetch helper you want to keep:

**Option 1: `readBody` callback.** Pass a callback that consumes the
`Request` stream however you want and returns the body shape your
schema declares:

```ts
import { readBodyFromFetch } from "@oaverify/core";
import { parseMultipart } from "@mjackson/multipart-parser"; // or busboy, formidable, etc.

export async function POST(request: Request) {
  const result = await validator.validateFetchRequest<UploadBody>(request, {
    readBody: async (req) => {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.startsWith("multipart/form-data")) {
        // Stream the multipart body field-by-field; write file fields
        // to disk without buffering; return placeholders (paths) that
        // the spec's `format: binary` bypass accepts.
        const fields = await streamMultipartToDisk(req);
        return { caption: fields.caption, file: fields.file.tempPath };
      }
      // For every other content type, fall through to the default parser.
      return readBodyFromFetch(req);
    },
  });
  // ...
}
```

The callback owns the stream. The validator does not read
`request.body` when `readBody` is provided, so there is no
double-consumption.

It owns the byte budget with it: the callback receives the original
`Request`, so `maxTotalBytes` does not apply to what your own reader
consumes. The `readBodyFromFetch` fall-through above is bounded, since
that helper applies the cap itself. Pass it explicitly
(`readBodyFromFetch(req, { maxTotalBytes })`) when you want a different
budget for the delegated content types than for your own.

**Option 2: assemble the `HttpRequest` yourself.** For routes where
`validateFetchRequest`'s convenience isn't worth even passing through
the helper, call `validator.validateRequest` directly with whatever
body shape you've already built:

```ts
const body = await myCustomStreamingPipeline(request);
const result = validator.validateRequest({
  method: request.method,
  path: new URL(request.url).pathname,
  contentType: request.headers.get("content-type") ?? undefined,
  body,
});
```

**Structural constraints need the whole value here.** A schema that
declares object shape, required fields, array bounds, or `oneOf`
needs the full payload before `validateRequest` can check it.
`validateRequest` accepts an already-buffered 10 GB document; the
memory cost is the caller's. For a body too large to buffer, the
separate [`@oaverify/stream`](../packages/stream-validator/README.md)
package validates it as it streams, with bounded memory, and
`oaverify stream-check spec.yaml` reports which of a spec's bodies can
stream at all. For spec-level opt-out, declare the body as
`format: binary` and let the opaque-body bypass accept whatever the
HTTP layer decoded.

**No bundled multipart parser.** `busboy`, `formidable`, and
`@mjackson/multipart-parser` each make different tradeoffs, and
picking one forces every user onto that pick. `readBody` is the plug
point; bring whichever parser fits your stack.

### Response validation

The adapters ship a `validateResponses` middleware (sibling to
`validateRequests`). Mount it where you want response checking,
conventionally on in development and off in production:

```ts
import { validateRequests, validateResponses } from "@oaverify/express5";

app.use(validateRequests(validator));
if (process.env.NODE_ENV !== "production") {
  app.use(validateResponses(validator));
}
```

Keep that order. Mounted above `validateRequests`, response checking
also sees the 400 problem-details bodies the request validator
renders, and unless the spec declares those responses every
request-validation 400 becomes a 500 finding.

It checks the status and declared headers of every response against
the response declared for its method and status, regardless of media
type, so an undeclared status or a missing required header (on a 204,
a redirect, a text error page) is a finding. The body is validated
when it is a parseable JSON response (`res.json(obj)`, `res.send(obj)`,
a JSON `res.send(string)`); body validation runs on the serialized
wire body, after `toJSON` methods, the `json replacer` setting, and
`Date` serialization have been applied, so what is checked is exactly
what the client receives. The per-adapter coverage list is in each
package README. On failure the default throws a
`ResponseValidationError`, which the adapter forwards to your error
middleware (a response that doesn't match the contract is a server
bug, so it surfaces as a 500).

Fastify is the same shape with no monkey-patching: it registers an
`onSend` hook instead of wrapping response methods.

```ts
if (process.env.NODE_ENV !== "production") {
  app.addHook("onSend", validateResponses(validator));
}
```

By default every declared status is checked (4xx / 5xx response shapes
too, not just 2xx), and a status the spec doesn't declare is itself a
finding. Scope it with `statuses`:

```ts
validateResponses(validator, { statuses: (s) => s < 300 }); // success responses only
```

See `ValidateResponsesOptions` for the full contract.

#### Why dev-only

Validation runs on _every_ response that passes the status predicate,
including the 4xx bodies your handlers emit. If a handler sends
`{ error: "...", code: "..." }` for a 400 but the spec's error schema
requires `title` (or sets `additionalProperties: false`), the throwing
default rewrites that 400 into a 500 in production. The client sees a
server error for a request that was their fault, which is worse than
the gap it closes.

If you want response validation always on, pass a log-and-continue
`onError`. Returning normally (rather than throwing) lets the original
body go out unchanged:

```ts
app.use(
  validateResponses(validator, {
    onError: (errors, ctx) => {
      log.warn("response validation failed", { path: ctx.req.path, errors });
      // returning without throwing sends the original body anyway
    },
  }),
);
```

The recommended progression: ship log-only, read the logs (real handler
bugs to the tracker, spec-vs-error-shape mismatches to the spec), then
flip to the throwing default once the log is quiet, gated on
`NODE_ENV !== "production"`.

#### Per-route, without the middleware

For a single route or bespoke interception, call `validateResponse`
directly. The core never wraps `res`, so this stays explicit:

```ts
app.get("/pets/:id", async (req, res) => {
  const pet = await db.pets.find(req.params.id);
  const body = pet ?? { error: "not found" };
  const status = pet ? 200 : 404;

  const result = validator.validateResponse(
    { method: req.method, path: req.path },
    { status, contentType: "application/json", body },
  );
  if (!result.valid) {
    log.warn("response validation failed", { path: req.path, errors: result.errors });
  }
  res.status(status).json(body);
});
```

### Security / authentication

`oaverify` performs **shape-only** security validation (when opted in
via `validateSecurity: "shape"` or `"strict"`): it confirms the
request carries the credential location declared by the spec (a
`Bearer` token in `Authorization`, the declared apiKey header /
query / cookie, a base64 `Basic user:pass` pair), but it does
**not** verify the credential itself. That's your auth middleware's
job; keep it upstream of the validator.

```ts
app.use(authenticateJwt); // verifies tokens, populates req.user
app.use(oavMiddleware); // shape + schema checks
```

The shape check (when enabled) runs against each operation's
`security:` (or document-level `security:` when the operation doesn't
override). Supported:

- `http` with `scheme: "bearer"`: requires `Authorization: Bearer <non-empty>`.
- `http` with `scheme: "basic"`: requires `Authorization: Basic <base64>`; the base64 must decode to a `user:pass` shape (no credential verification).
- `apiKey` in `header`, `query`, or `cookie`: declared name must be present and non-empty.

`oauth2`, `openIdConnect`, and `mutualTLS` schemes (and HTTP schemes
other than bearer / basic) aren't shape-checkable at the validator
layer. In `"shape"` mode they silently pass; in `"strict"` mode they
fail with a `security` leaf error so the gap surfaces rather than
slipping through. Failures (recognized or strict-mode unrecognized)
surface as a single leaf error with `code: "security"` and
`path: ["security"]`, mapping to HTTP 401 in the default status
recipe.

**Off by default**, because real apps run auth middleware upstream and
the credential is already verified by the time `validateRequest` runs.
Enable `validateSecurity: "shape"` when there's no auth middleware
(early dev, prototyping) or when the auth layer decorates `req` without
rejecting unauthenticated traffic; `"strict"` when you want every
declared scheme to either be shape-checkable or fail loudly. No mode
substitutes for credential verification. See
`ValidatorOptions.validateSecurity` for the option contract.

#### Per-scheme auth dispatch

When you want the declarative shape (per-scheme handlers keyed off
the spec's `security:` declaration), write a small dispatcher that
walks the matched operation via `validator.getOperation` and fans out
per scheme.
[`examples/security-dispatch.ts`](../examples/security-dispatch.ts)
is a runnable one to copy and adapt. The OpenAPI semantics it
implements: each requirement object is AND across its scheme keys,
the outer array is OR across requirements, and the first requirement
that fully passes wins.

Mount the dispatcher as middleware _before_ `validateRequests` (or
your inline validator middleware) and reject (`401` / `403` per your
policy) on failure before validation runs. The validator's own
`validateSecurity` shape check is then redundant; leave it at its
default `"off"`. The same dispatcher works under every adapter; only
the request-shape extraction changes (`httpRequestFromExpress`,
`httpRequestFromFastify`).

### Type coercion on body fields

oaverify doesn't coerce `{"age": "42"}` to `{"age": 42}` on request
bodies by default.

Serialized parameters are different. `oaverify` auto-coerces scalar
path, query, header, and cookie params per their declared type
(`type: integer` → `Number(raw)`, `type: boolean` → `true`/`false`),
and does the same one level down for containers: an array's elements
are coerced with its `items` schema, a `deepObject`'s values with the
matching entry in `properties`.

A value whose governing schema declares no scalar type stays a string.
That covers a `$ref`-valued subschema, and an array with `prefixItems`,
where `items` governs only part of the array. Only bodies are strict.

If you need loose body coercion, coerce in your handler after
parsing but before calling downstream logic, or in an
`express.json({ reviver })` callback wired per route. Both keep the
coercion decision out of the validator and in the code that
understands your wire format.

### Ignoring paths not in the spec

Two `createValidator` options cover the common cases directly:

```ts
createValidator(spec, { ignoreUndocumented: true });

createValidator(spec, {
  ignorePaths: (p) => p.startsWith("/internal/") || /^\/_debug\//.test(p),
});
```

`ignorePaths` runs before the router; `ignoreUndocumented` only
applies to paths the router couldn't match. Both leave `method`
errors (405; path exists, verb doesn't) alone. See
`ValidatorOptions.ignorePaths` / `ValidatorOptions.ignoreUndocumented`
for the option contracts.

If you need branching based on the error rather than the path, fall
back to the manual pattern:

```ts
app.use(async (req, res, next) => {
  const result = validator.validateRequest(httpRequestFromExpress(req));
  if (result.valid) return next();
  if (result.errors.some((e) => e.code === "route")) return next(); // unvalidated path, let routing continue
  // ... 4xx response as usual
});
```

### Validating multiple specs with one validator

When an app serves several OpenAPI documents (a versioned split, or
separately-owned surfaces mounted under one server), build a validator
per spec and stack them with `combineValidators`. The result is a
single `Validator`, so the framework adapters consume it unchanged: one
`validateRequests` mount instead of one per spec.

```ts
import { createValidator, combineValidators } from "@oaverify/core";

const validator = combineValidators([createValidator(specV1), createValidator(specV2)], {
  onOverlap: "error",
});

app.use(validateRequests(validator));
```

Each member keeps its own dialect, components, and compiled plans, so
two specs that reuse a component name (`Error`, `Journey`) never clobber
each other; a literal document merge would. The composite dispatches
each request to the member that owns its route, then delegates to that
member's `validateRequest` / `validateResponse` in full, so the owning
member's own `ignorePaths` and content-type handling still apply.

Two policies to know:

- **`onOverlap`** (`"first-match"` default, or `"error"`). With
  `"first-match"`, the earliest member in the array that owns a route
  wins. With `"error"`, `combineValidators` asserts the members are
  route-disjoint at construction and throws on any clash (structural, so
  `/x/{id}` and `/x/{slug}` count as the same route). Use `"error"` when
  the specs are supposed to be disjoint and a collision would be a bug.
- **`ignoreUndocumented`** governs routes that _no_ member owns,
  mirroring the single-validator option: `false` (default) yields a
  `route` error, `true` passes. A member's own `ignoreUndocumented`
  governs only the routes that member owns, reached through delegation.
  So a path declared in no spec (an upload route bypassed entirely)
  passes only when the composite is built with
  `ignoreUndocumented: true`.

All members must share an `output` mode; mixing flat and tree throws at
construction. See `CombineOptions` for the option contracts.

## Migrating from express-openapi-validator

[migration-from-eov.md](./migration-from-eov.md) has the
behaviour-difference reference, the option map, and what is and isn't
carried over.
