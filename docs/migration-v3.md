# Migrating to v3

v3 changes the zero-config defaults: a bare `compileSchema(schema)` (and
`createValidator(spec)`) now returns a **flat** list of errors, stopping
at the **first** one. The richer nested error tree
and full error collection are one option away. This guide lists every
breaking change and how to restore the v2 behaviour where you want it.

If you only use the framework adapters with the default renderer, the upgrade
is mostly transparent: keep passing the validator to `validateRequests`,
problem-details responses still work. The breaking surface is for code that
reads `validateRequest` results, calls `compileSchema` directly, or supplies a
custom `onError`.

## At a glance

| Area                                   | v2                               | v3                                        |
| -------------------------------------- | -------------------------------- | ----------------------------------------- |
| `compileSchema` default result         | nested tree `{ valid, error? }`  | flat `{ valid, errors?, truncated }`      |
| `compileSchema` default `maxErrors`    | uncapped                         | `1` (fast-fail)                           |
| Mode selection                         | `flat: true` / `predicate: true` | `output: "flat" \| "tree" \| "predicate"` |
| `validateRequest` / `validateResponse` | `ValidationError \| null`        | `{ valid, errors?, error?, truncated }`   |
| Validator `maxErrors` default          | uncapped                         | `1`, as a per-call total                  |
| Adapter `onError(err, ctx)`            | one `ValidationError`            | `onError(errors, ctx)`, a leaf list       |
| `{ key: undefined }` presence          | counted as present               | treated as absent                         |

## 1. The compiler's default result is flat

`compileSchema(schema, { dialect })` now returns a flat result.

```ts
// v2
const v = compileSchema(schema, { dialect });
const r = v.validate(data);
if (!r.valid) console.log(r.error); // nested ValidationError tree

// v3: same call, flat result
const v = compileSchema(schema, { dialect });
const r = v.validate(data);
if (!r.valid) console.log(r.errors); // flat ValidationError[]
```

The result is a discriminated union on `valid`. On success it is exactly
`{ valid: true }`; on failure it carries `errors` (a non-empty leaf list) and
`truncated`. Reading `r.error` on the flat result is now a compile-time error
in TypeScript, which catches the rename for you.

**Keep the tree:** pass `output: "tree"`.

```ts
const v = compileSchema(schema, { dialect, output: "tree" });
const r = v.validate(data);
if (!r.valid) console.log(r.error); // nested tree, as before
```

## 2. The compiler defaults to `maxErrors: 1`

The default validator stops at the first error. To collect every error, pass
`maxErrors: Number.POSITIVE_INFINITY`. `output` and `maxErrors` are
orthogonal: `output: "tree"` also defaults to `maxErrors: 1` (a nested tree
holding the first error).

```ts
// every error, flat:
compileSchema(schema, { dialect, maxErrors: Number.POSITIVE_INFINITY });
// every error, nested tree (the v2 default behaviour):
compileSchema(schema, { dialect, output: "tree", maxErrors: Number.POSITIVE_INFINITY });
```

`truncated` is `true` whenever the cap was reached (more problems may exist).
Under the default `maxErrors: 1`, every rejection reports `truncated: true`.

## 3. `output` replaces the `flat` / `predicate` booleans

`output: "flat" | "tree" | "predicate"` is the single knob for the result
shape. The `flat: true` and `predicate: true` booleans still work as
deprecated aliases (removed in v4) and throw if combined with a conflicting
`output`.

```ts
compileSchema(schema, { dialect, predicate: true }); // deprecated
compileSchema(schema, { dialect, output: "predicate" }); // v3
```

## 4. Result type renames

| v2                        | v3                                        |
| ------------------------- | ----------------------------------------- |
| `ValidationResult` (tree) | `TreeValidationResult`                    |
| `FlatValidationResult`    | `ValidationResult` (now the flat default) |
| `CompiledSchema` (tree)   | `CompiledTreeSchema`                      |
| `CompiledFlatSchema`      | `CompiledSchema` (now the flat default)   |

`FlatValidationResult` and `CompiledFlatSchema` remain as deprecated aliases
of the new flat types for one major. If you imported `ValidationResult`
expecting the tree shape, switch to `TreeValidationResult`.

## 5. The validator returns a result object

`createValidator` mirrors the compiler: same `output` / `maxErrors` options,
same result types. `validateRequest` / `validateResponse` no longer return
`ValidationError | null`.

```ts
// v2
const err = validator.validateRequest(req);
if (err !== null) renderProblemDetails(err, ctx);

// v3 (flat default)
const r = validator.validateRequest(req);
if (!r.valid) renderProblemDetails(r.errors, ctx);
```

`createValidator` is overloaded on `output`, returning a `Validator` (flat),
`TreeValidator`, or `PredicateValidator`. The validator's `maxErrors` is a
**per-call total** across all locations (body, query, headers): the default
`maxErrors: 1` yields a single error for the whole request.

To keep the v2 nested-tree-or-null behaviour:

```ts
const validator = createValidator(spec, {
  output: "tree",
  maxErrors: Number.POSITIVE_INFINITY,
});
const r = validator.validateRequest(req);
const err = r.valid ? null : r.error; // ValidationError | null, as before
```

## 6. Adapter `onError` receives a leaf list

The framework adapters (`oav-express4`, `oav-express5`, `oav-fastify`) pass a
flat `ValidationError[]` to `onError`, regardless of the validator's `output`
(a tree validator's result is flattened first).

```ts
// v2
validateRequests(validator, {
  onError: (err, ctx) => {
    /* err is one node */
  },
});

// v3
validateRequests(validator, {
  onError: (errors, ctx) => {
    /* errors is a list */
  },
});
```

A predicate-mode validator (`output: "predicate"`) can't render a
problem-details body, so the adapters throw at construction if you pass one.
Use `output: "flat"` (default) or `"tree"`.

## 7. Problem-details and formatters accept a leaf list

`httpStatusFor`, `allowHeaderFor`, `toProblemDetails`, `collectIssues`,
`formatText`, `formatSummary`, `countErrors`, and `toJsonObject` accept
either a single `ValidationError` (tree) or a `ValidationError[]` (flat).
Existing tree calls are unchanged; the flat form lets the same wiring serve
either `output`.

`formatError` is the one exception: it renders a single tree. It backs the
CLI `--format` flag and a custom `ErrorRenderer`, which is typed
`(err: ValidationError) => string`; widening that parameter would break
existing renderers, so the function stays tree-only. For the default flat
output, call `formatText`, `formatSummary`, or `toJsonObject` on the list
directly. If you specifically need `formatError` (a named built-in format or
a custom renderer), wrap the list in a root first:

```ts
import { createBranchError, formatError } from "@aahoughton/oav";

const result = validator.validateRequest(httpRequest);
if (!result.valid) {
  const root = createBranchError("request", [], "request validation failed", result.errors);
  console.error(formatError(root, "text"));
}
```

## 8. `undefined`-valued properties count as absent

A property whose value is `undefined` is now treated as **absent** for
`required`, `properties`, and the `dependent*` keywords, consistently. For
parsed JSON this is a no-op (JSON has no `undefined`). For in-memory objects
it matches `JSON.stringify`, which drops `undefined`-valued keys, so it is the
wire-accurate answer; a validity verdict can change for such inputs.

```ts
// v2: `a` present -> passes `required: ["a"]`
// v3: `a` absent  -> fails `required: ["a"]`
validate({ a: undefined });
```

## A note on `maxErrors` and verdicts

A finite `maxErrors` never changes a valid/invalid verdict. For schemas that
use `unevaluatedProperties` / `unevaluatedItems`, the short-circuit is
disabled and every error is collected (the cap is not enforced there),
because capping mid-evaluation could otherwise suppress a real
`unevaluated*` error. These keywords don't appear in OpenAPI specs, so the
HTTP fast path is unaffected.
