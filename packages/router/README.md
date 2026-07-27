# @oaverify/internal-router

> **Internal package, not published.** `@oaverify/internal-router` is a workspace-private
> dependency of `oav`; it does not appear on npm and has no
> published subpath. This README documents the internal surface for
> contributors navigating the monorepo. Third-party consumers get the
> router's functionality transparently via `createValidator`.

OpenAPI path matcher: a specificity-sorted route list, scanned
linearly per request. Resolves `method + path` to the matching
`OperationObject` in the spec.

```ts
// Internal usage inside the monorepo
import { createRouter } from "@oaverify/internal-router";

const router = createRouter({
  "/pets":          { get: {...}, post: {...} },
  "/pets/{id}":     { get: {...} },
  "/pets/mine":     { get: {...} },
});

router.match("GET", "/pets/mine");  // → operation for "/pets/mine"
router.match("GET", "/pets/42");    // → operation for "/pets/{id}", params: { id: "42" }
router.match("POST", "/vets");      // → undefined
```

Literal segments beat template segments at the same depth. Trailing
slashes and query strings are ignored. Method matching is
case-insensitive. Path segments are percent-decoded.

## Identity invariant

`RouteMatch.operation` is the same reference that was supplied to
`createRouter`. The validator keys per-operation caches on this
identity via `WeakMap`, so the router must not clone, merge, or
otherwise reconstruct operations. If you write a custom router,
preserve the spec-provided reference.
