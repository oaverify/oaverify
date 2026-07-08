# Configuring the validator

`createValidator(spec, options)` accepts the options below. The
canonical reference is the
[`ValidatorOptions`](../packages/validator/src/validator.ts) TSDoc;
this page is a recipe-oriented overview.

| Option                  | Effect                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dialect`               | Force a specific schema dialect, bypassing version detection.                                                                                                                |
| `formats`               | Extra string format validators merged on top of the built-ins.                                                                                                               |
| `keywords`              | Register user-defined schema keywords (see below).                                                                                                                           |
| `output`                | Result shape: `"flat"` (default; `{ valid, errors, truncated }`), `"tree"` (nested `{ valid, error, truncated }`), or `"predicate"` (bare boolean). Mirrors `compileSchema`. |
| `maxErrors`             | Per-call total cap on leaf errors. Default `1` (fast-fail); pass `Number.POSITIVE_INFINITY` to collect every error.                                                          |
| `maxDepth`              | Cap on recursive `$ref` validation depth; past the cap the payload fails with a `depth` error instead of exhausting the call stack. Unset by default; see below.             |
| `strict`                | Compile-time schema lint mode: `"off"`, `"warn-partial"` (default), or `"strict"`. Issues surface via `validator.stats.strictIssues`.                                        |
| `strictQueryParameters` | Reject undeclared query parameters. Default `false`.                                                                                                                         |
| `validateSecurity`      | `"off"` (default), `"shape"` (check recognized schemes; pass on oauth2/oidc/mTLS), or `"strict"` (fail on unrecognized schemes).                                             |
| `ignoreUndocumented`    | Treat requests whose path the router can't match as valid (`{ valid: true }`) instead of a `route` error. Default `false`.                                                   |
| `ignorePaths`           | Predicate `(path) => boolean`; returning `true` short-circuits validation to a valid result (`{ valid: true }`) before routing.                                              |
| `onUnknownVersion`      | Policy for specs with missing/unsupported `openapi`: `"fallback31"` (default), `"warn"`, or `"throw"`.                                                                       |
| `regexCompiler`         | Compiler for `pattern` keywords and `format: "regex"`. Defaults to `new RegExp(p, "u")` with a non-u fallback. Plug in `re2` or a safe-regex check for hardening; see below. |

## Custom keywords

```ts
const validator = createValidator(spec, {
  keywords: {
    activeTenant: (data) =>
      typeof data !== "string" || tenantCache.has(data)
        ? true
        : { message: `tenant "${data}" is not active` },
  },
});
```

Custom keywords plug into generated code alongside the built-ins. See
[`examples/custom-keywords.ts`](../examples/custom-keywords.ts) for an
end-to-end run, and `CustomKeywordValidator` in the TSDoc for the full
return-shape contract (boolean, error object, or array of errors).

## Error budget

The validator stops at the first error by default (`maxErrors: 1`).
The cap is a per-call total
across every location (body, query, headers).

```ts
createValidator(spec); // fast-fail: the first error
createValidator(spec, { maxErrors: 10 }); // bound CPU/memory on huge payloads
createValidator(spec, { maxErrors: Number.POSITIVE_INFINITY }); // every error
```

Hot loops (array items, object properties, `allOf` / `anyOf` branches)
short-circuit once the budget is exhausted. A failing result carries
`truncated: true` when the cap was reached, so callers know more
problems may exist.

`maxErrors` must be a positive integer (>= 1); `createValidator`
throws on `0`, negative values, or non-integers. For a yes/no answer
with no errors collected at all, build the validator with
`output: "predicate"`.

## Hardening against untrusted regex patterns

`pattern` keywords and `format: "regex"` compile to JavaScript's
built-in `RegExp`, which has no execution timeout. A catastrophic
pattern like `(a+)+$` is a denial-of-service vector against any
string the validator checks. The risk is real only when the spec is
attacker-controlled: multi-tenant SaaS accepting uploads,
spec-editing tools, mock-as-a-service. For first-party specs the
default is fine; vet your sources.

When the spec is untrusted, pass a `regexCompiler` that wraps a safe
engine. `re2` is the standard choice (linear-time matching, no
catastrophic backtracking) on platforms that allow a native dep:

```ts
import RE2 from "re2";
import { createValidator } from "@aahoughton/oav";

const validator = createValidator(spec, {
  regexCompiler: (pattern) => new RE2(pattern),
});
```

Invocation cadence is split: schema-authored `pattern` strings are
memoized for the validator's lifetime (bounded by spec size), so
the compiler runs once per unique pattern there. `format: "regex"`
runs the compiler per `validate()` call against the candidate
string; caching runtime values would retain user input indefinitely,
which is the opposite of what hardening callers want.

The runtime only reads `.test(s)` off the returned object, so
anything that satisfies `{ test(s: string): boolean }` works. A
typical complexity-check wrapper:

```ts
import safeRegex from "safe-regex";

createValidator(spec, {
  regexCompiler: (pattern) => {
    if (!safeRegex(pattern)) {
      throw new Error(`unsafe regex: ${pattern}`);
    }
    return new RegExp(pattern, "u");
  },
});
```

`oav` does not bundle `re2` or any other engine: edge runtimes
(Cloudflare Workers, Vercel Edge) don't support native modules, and
the right answer for those environments is a different tradeoff
(pattern-length cap, allowlist of permitted patterns, etc.) which
your `regexCompiler` can encode.

Throws inside the compiler:

- For `pattern` keywords, a throw surfaces at validator-construction
  time (`compileSchema` calls the compiler eagerly).
- For `format: "regex"`, a throw is caught and translated into a
  `format` validation error against the value.

`pattern` and `format: "regex"` use the same compiler policy: one
`regexCompiler` covers both, and there's no second hook to keep in
sync. `format: "regex"` is auto-registered by `@oav/schema` and no
longer ships from `@oav/formats`'s `builtInFormats`; a user-supplied
entry in `formats` still overrides it if you want a different policy
for the format than for `pattern`.

## Guarding against deeply nested payloads

Recursive schemas (a `$ref` that points back at an ancestor, common
for tree and comment structures) compile to validation functions that
call themselves once per level of nested data. Validation depth tracks
the payload's nesting depth, and the JavaScript call stack has no
built-in limit you can rely on. A small but deeply nested payload (an
array nested a few thousand levels, only a few KB on the wire) can
exhaust the stack and throw `RangeError: Maximum call stack size
exceeded`.

The first line of defense is the `maxDepth` option, on both
`createValidator` (`ValidatorOptions`) and `compileSchema`
(`CompileOptions`). It bounds recursion inside the validator: once the
data nests deeper than the cap through a recursive `$ref`, validation
stops descending and emits a `depth` error (mapped to HTTP 400) instead
of growing the stack. The counter tracks only recursive (`$ref`
back-edge) calls, so it measures how deep the recursive structure
nests, independent of how the schema was decomposed; non-recursive
schemas are never instrumented, and an unset `maxDepth` compiles to the
same code as before (zero overhead). Legitimate payloads rarely recurse
beyond ten or fifteen levels, so a cap of 32 to 64 is generous.

```ts
const validator = createValidator(spec, { maxDepth: 64 });
// A request body that recurses past 64 levels now fails as a 400
// `depth` error rather than throwing RangeError.
```

`maxDepth` covers the validator's own recursion. For untrusted callers
who also want to reject deep payloads before they reach any parsing or
business logic, a depth cap at the parse boundary is a complementary
backstop (it bounds nesting the validator never sees, e.g. fields the
schema doesn't traverse). Without `maxDepth`, the framework adapters
catch the `RangeError` and turn it into a 500, so the process survives;
a cheap-to-send payload that reliably produces 500s is still a
denial-of-service vector, which is what `maxDepth` and the
parse-boundary guard close.

The parse-boundary guard is a depth cap before the parsed
body reaches the validator. A byte-size limit alone is not enough: a
payload nested thousands of levels deep is tiny, so `express.json({
limit })` (or its equivalent) bounds width, not depth. Walk the parsed
value iteratively (a recursive walker would overflow on the same input
you are trying to reject) and reject anything past a sane ceiling.
Legitimate request bodies rarely nest beyond ten or fifteen levels; a
cap of 32 to 64 is generous for real traffic and well clear of the
danger zone. Set it low and raise it only if a legitimate payload
trips it.

```ts
// Returns true if `value` nests deeper than `limit`. Iterative on
// purpose: a recursive walker would overflow on the input it rejects.
function tooDeep(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > limit) return true;
    if (Array.isArray(node)) {
      for (const el of node) stack.push([el, depth + 1]);
    } else {
      for (const k of Object.keys(node)) {
        stack.push([(node as Record<string, unknown>)[k], depth + 1]);
      }
    }
  }
  return false;
}

app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  if (req.body && tooDeep(req.body, 64)) {
    return res.status(400).json({ error: "request body nesting too deep" });
  }
  next();
});
// the validateRequests middleware comes after this guard
```

Fastify is the same shape in an `onRequest` or `preValidation` hook
that inspects `request.body`.

For standalone callers (the Fetch adapter, a handler that calls
`validateRequest` directly), wrap the call so a stack overflow becomes
a controlled error instead of an unhandled rejection:

```ts
try {
  result = validator.validateRequest(req);
} catch (err) {
  if (err instanceof RangeError) {
    return new Response("payload too complex", { status: 400 });
  }
  throw err;
}
```

`maxDepth` is the primary control; the parse-boundary guard, the
byte-size limit, and the `try/catch` are backstops.
