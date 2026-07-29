# Migrating to v5

v5 is mostly a naming and reporting release. The compiler's semantics
are unchanged; what moved is what things are called, what the CLI
verbs are, and which malformed schemas are now caught instead of
silently accepted.

Two changes can alter validation outcomes on a spec you did not edit,
and both are listed first because they are the ones worth reading
before you upgrade: the well-formedness guard now follows `$ref`
(section 6), and `$ref` siblings are now applied at body roots
(section 5). Everything else is a rename, a removal, or a CLI change
that TypeScript or a failed command will point at directly.

If you use the framework adapters with the default renderer and never
pass `strict`, the upgrade is likely a version bump and nothing else.

## At a glance

| Area                                | v4                                            | v5                                                |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Compile-time lint option            | `strict: "off" \| "warn-partial" \| "strict"` | `schemaLint: "off" \| "warn" \| "strict"`         |
| Lint findings                       | `strictIssues`, `StrictIssue`                 | `schemaLintIssues`, `SchemaLintIssue`             |
| Deprecated output aliases           | `flat` / `predicate` booleans                 | removed; use `output`                             |
| Deprecated result types             | `FlatValidationResult`, `CompiledFlatSchema`  | removed; use `ValidationResult`, `CompiledSchema` |
| Spec quality on the CLI             | `oaverify resolve --lint`                     | `oaverify check`                                  |
| `stream-check` output shape flag    | `--envelope`                                  | `--format`                                        |
| `$ref` with siblings at a body root | siblings dropped                              | siblings applied (3.1)                            |
| Malformed schema behind a `$ref`    | compiled, constraint silently dropped         | throws, with the path                             |
| Overlay `extend*` argument          | the whole component object                    | `Partial` of it                                   |
| `CheckFinding.class`                | `"hygiene" \| "schema"`                       | adds `"malformed"`                                |

## 1. `strict` is now `schemaLint`

`strict` named an intensity without a domain, and the codebase had two
other options using the word for the unrelated request-side axis. At a
call site `strict: "strict"` gave no clue whether it tightened schema
checking, request validation, or both.

```ts
// v4
createValidator(spec, { strict: "strict" });
validator.stats.strictIssues;

// v5
createValidator(spec, { schemaLint: "strict" });
validator.stats.schemaLintIssues;
```

Renamed together:

| v4                       | v5                   |
| ------------------------ | -------------------- |
| `strict`                 | `schemaLint`         |
| `strict: "warn-partial"` | `schemaLint: "warn"` |
| `strictIssues`           | `schemaLintIssues`   |
| `StrictIssue`            | `SchemaLintIssue`    |

`strictQueryParameters` and `validateSecurity` keep their names. Their
option names scope what gets stricter, which is the rule that decides
when `strict` is acceptable; see
[docs/strictness.md](./strictness.md#for-contributors-naming).

**No alias was added.** v4 shipped with four symbols whose TSDoc had
promised removal in v4 (see section 2), which teaches users that a
deprecation notice is not load-bearing. Adding a fifth would have
repeated that. The rename is mechanical and TypeScript flags every
call site.

## 2. The v4-overdue deprecated aliases are gone

Four public symbols carried TSDoc promising removal in v4 and were
still present in 4.0.0. They are removed now.

| Removed                    | Use instead           |
| -------------------------- | --------------------- |
| `CompileOptions.flat`      | `output: "flat"`      |
| `CompileOptions.predicate` | `output: "predicate"` |
| `FlatValidationResult`     | `ValidationResult`    |
| `CompiledFlatSchema`       | `CompiledSchema`      |

`output` covers the capability fully; nothing sat behind the aliases.
Going with them: the `{ predicate: true }` overload, the
flat/predicate mutual-exclusion guard, and the guard that rejected
`output` combined with a legacy boolean.

```ts
// v4
compileSchema(schema, { flat: true });

// v5
compileSchema(schema, { output: "flat" });
```

## 3. Spec quality moved from `resolve --lint` to `check`

"Valid" meant four different things and only one of them was spelled
`validate`. There are two verbs now, one question each.

```bash
oaverify check <spec>       # is my SPEC good?
oaverify validate <spec>    # does this PAYLOAD conform to my spec?
```

```bash
# v4
oaverify resolve spec.yaml --lint --fail-on warning

# v5
oaverify check spec.yaml --fail-on warning
```

`resolve` goes back to stitching and printing. Removed from it:
`--lint`, `--fail-on`, `--envelope`.

`check` emits one findings array, each entry carrying a required
`class` so a consumer can re-split what the command ran together.
`--only` takes a comma-separated subset of `hygiene`, `schema`.

**`check` does not validate your document against the OpenAPI
meta-schema.** It reports schema-level and hygiene problems. For
document conformance, pair it with `redocly lint` or `vacuum`; see
[the integration guide](./integration.md).

### `stream-check --envelope` is now `--format`

Renamed for consistency with `check --format` and `validate --format`.
The window for that rename was open exactly once.

```bash
oaverify stream-check spec.yaml --format json   # was --envelope json
```

## 4. Overlay `extend*` verbs take a `Partial`

`extend<Bucket>` merges a patch into an existing component, but the
types demanded the whole object, so patching one field needed a cast
on every call. The runtime was always right; only the type was wrong.

```ts
// v4: did not compile without a cast (ParameterObject requires name + in)
applyOverlays(doc, [{ extendParameters: { TraceId: { description: "traces" } } }]);

// v5: compiles
applyOverlays(doc, [{ extendParameters: { TraceId: { description: "traces" } } }]);
```

This is a widening, so existing calls that passed whole objects keep
working. `extendSchemas` keeps its full `SchemaObject` (it composes
with `allOf` rather than merging) and `extendTags` keeps `TagObject`
(it appends).

## 5. `$ref` siblings are applied at request and response body roots

**This can change whether a payload validates.**

The body-schema transform followed a root `$ref` to its target and
replaced the node. Under OpenAPI 3.1 a `$ref` alongside other keywords
means the target _and_ those keywords, so replacing the node dropped
them:

```yaml
requestBody:
  content:
    application/json:
      schema:
        $ref: "#/components/schemas/Pet"
        required: [name] # v4: silently not enforced. v5: enforced.
```

In v4 a body of `{}` passed. The same shape one level down, under a
`properties` entry, was always enforced correctly, so root and nested
disagreed.

If your spec relies on the v4 behaviour, it was relying on a
constraint being ignored. Expect previously-passing payloads to fail;
that is the fix working.

OAS 3.0 semantics are unchanged: the specification itself drops those
siblings, and the compiler already did. What did change is that
removing the node early also hid it from the
`silent-rewrite/ref-siblings-oas30` lint, so under 3.0 you may now see
that warning at a body root, which is where the shape is most common.

## 6. The well-formedness guard follows `$ref`

**This can turn a spec that built into one that throws.**

A malformed schema (`items: [...]`, `if: null`, `type: "Strng"`,
`required: "id"`) has always been fatal. The guard ran only on the
schema handed to the compiler, which in the HTTP pipeline is one
operation's inline schema; components arrive through the resolver, so
every `$ref` target below the root was compiled unchecked.

The consequence was worse than a missing error message. An
array-valued `items` inside a component compiled to a keyword-free
schema, so the array's elements went entirely unvalidated while the
spec looked fine.

```yaml
components:
  schemas:
    Envelope:
      type: object
      properties:
        events: { $ref: "#/components/schemas/Events" }
    Events:
      type: array
      items: [{ type: string }] # draft-04 tuple form
```

```
v4: builds. The array's elements are never validated.
v5: throws
    GET /events 200 response body (application/json): "items" at
    "components.schemas.Events" must be an object or boolean; got an array.
    In JSON Schema 2020-12 the tuple form is "prefixItems"; an array-valued
    "items" is the draft-04 / Swagger 2.0 spelling.
```

The path names the component, so a schema shared by many operations is
reported at its definition rather than at whichever route reached it
first.

No option turns this off, including `schemaLint: "off"`.
Well-formedness is a precondition rather than a lint level: `schemaLint`
grades schemas that _are_ schemas.

To find these before upgrading a running service, run `oaverify check`
against your spec on v5. It reports every malformed schema in the
document rather than stopping at the first.

## 7. `required-not-in-properties` was rewritten

The rule asked whether _this object_ composes, which is the wrong
question, and it failed in both directions: over-firing on a `then` or
`oneOf[i]` branch whose property is declared on a sibling sharing the
same instance, and suppressing itself on schemas that legitimately
compose, which is exactly where the real cases live. Measured at 2.6%
signal across 13 published specs.

It now asks what property names are reachable at this _instance_
position, resolving through every schema that constrains it rather
than only the walk's own ancestors.

The code is unchanged (`silent-rewrite/required-not-in-properties`),
so a filter keyed on it keeps working. Expect a different set of
findings: fewer false positives, and true positives that v4 missed. If
you gate CI on `--fail-on warning`, run `check` once before upgrading
the gate.

## 8. `CheckFinding` reports malformed schemas under their own class

`CheckFinding.class` is now `"hygiene" | "schema" | "malformed"`. A
malformed schema was previously reported as `"schema"`, which meant
telling the two apart required matching on
`code === "malformed-schema"`.

```jsonc
// v5
{ "class": "malformed", "code": "malformed-schema", "location": "...", "message": "..." }
```

`--only` still takes `hygiene` / `schema`: those are the checks that
can be _run_, and a malformed schema is found by compiling, which is
what the `schema` check does. Exit code 2 for a malformed schema is
unchanged.

Two related reporting changes, neither breaking a type:

- `CheckFinding.occurrences` appears when one defect was reached from
  several operations. A shared component compiles per operation, so it
  would otherwise be printed once per operation; `location` names the
  first operation that reached it and the rest are counted.
- `PrecompileFailure.context` (and so `CheckFinding.location` for
  malformed findings) now names the individual schema, as
  `POST /things query parameter "q"` rather than `POST /things`.

## 9. `check` grades the whole document

Not a breaking change to any type, but it changes what a run prints.

`check` reports a malformed schema as a finding and carries on, so one
bad `items` no longer hides every other finding in the file. It still
exits 2, and that outranks `--fail-on`: a document that will not
compile is not a gate result.

The programmatic equivalent is `precompile({ onMalformed: "collect" })`.
The default still throws, which is what a server wants, since
continuing would leave that operation validating against nothing.

Because the schema lint now follows `$ref` as well, a spec that
reported a handful of findings in v4 may report many more in v5: it was
previously seeing one operation's inline schema plus at most the
component named directly as its body. On Asana that was 1 of 278
component schemas.
