# Streaming Validation

`@oaverify/stream` validates JSON bytes while they stream, echoing input
to a downstream sink and reporting validation on a side channel. The
package README covers the adoption question: when streaming helps, what
schemas can stream, and how to read the buffer-budget analyzer. This file
carries the operation-helper recipe and the stream hook reference.

## OpenAPI Operation Helper

For the common OpenAPI case, reach for `streamValidatorForOperation`: it
extracts the request-body schema for a `{ method, path }`, carries the
document's ref containers so internal `$ref`s resolve, and reads the
OpenAPI version off `doc.openapi`. Your router still picks the operation;
the locator is an exact path-template key, not a match.

```ts
import { pipeline } from "node:stream/promises";
import { createFileReader, resolveSpec } from "@oaverify/core/spec";
import { streamValidatorForOperation } from "@oaverify/stream";

const { document } = await resolveSpec({ reader: createFileReader(), entry: "openapi.json" });
const validator = streamValidatorForOperation(document, { method: "post", path: "/pets" });
await pipeline(request, validator, sink);
```

If you already hold a bare body schema rather than a whole document,
construct the engine directly and carry the ref container yourself:

```ts
import { createStreamValidator } from "@oaverify/stream";

const validator = createStreamValidator(
  { ...bodySchema, components: doc.components }, // carry the ref container
  { openApiVersion: "3.1" },
);
```

## Hooks

`StreamValidatorOptions` is the source contract for the hook options,
their caps, and the event shapes. This section is the usage guide.

Observability and edit hooks: `keyEvents` emits a `key` event per object
key, optionally path-filtered. `onScopeClose(at, cb)` observes a
forward-decidable scope at its close, and `editClose(at, cb)` appends
bytes before a scope's closing delimiter. Appended bytes are not
validated. A `ScopeContext` carries the scope path, verdict, member
count, and a `field(name, value)` helper.

### Reshaping Members

`editMember(at, cb)` renames or drops an object member as it streams,
which the in-place edit `editClose` cannot do. The hook fires at the
member's value start, so it knows the value type, and returns
`{ action: "rename", key }`, `{ action: "drop" }`, or
`{ action: "keep" }` (or `null`). A `rename` rewrites the key token only
and streams the value verbatim, so renaming a key in front of a multi-GB
array never buffers the array. A `drop` suppresses the member and absorbs
one delimiter, leaving valid JSON.

```ts
const validator = createStreamValidator(bodySchema);
validator.editMember(["message_ids"], () => ({ action: "rename", key: "records" }));
validator.editMember(["legacy_field"], () => ({ action: "drop" }));
// {"message_ids":[...big...],"legacy_field":1,"keep":2}
//   -> {"records":[...big...],"keep":2}
```

`at` matches the member's full path (the enclosing scope plus the key),
the same coordinate `valueEvents.at` uses. Validation is pre-edit: a
dropped member is still validated, and the edit only changes the output.
Dropping a container-valued member is not supported on the stream path;
rename works for any value type. Collisions, conflicting hooks and the
two buffering caps (`maxMemberPrefixBytes`, `maxMemberDropBytes`) are
fatal where they apply; see `StreamValidatorOptions` for the limits.

### Recovering Scalars

`valueEvents` emits a `value` event when a scalar object-member value
completes, carrying the member's absolute input-byte span. Code that
needs a few small top-level scalars (an id, a version, a timestamp)
recovers them without materializing the body or running a second parser:
slice `[valueStart, valueEnd)` from its own copy of the input. A string
span includes its quotes, so the slice is valid JSON. Slice the input
rather than the echoed output, whose offsets shift under `editClose`.

```ts
const captured = new Map<string, unknown>();
const validator = createStreamValidator(bodySchema, {
  // Decode the matched scalars under a byte cap.
  valueEvents: { at: (path) => path.length === 1, capture: true },
});
validator.on("value", (e) => captured.set(e.key, e.value));
// `e.value` is the decoded scalar (present when within `maxCaptureBytes`);
// `e.truncated` flags an over-cap value (span still reported). Omit
// `capture` for span-only events and slice the bytes yourself.
```

A `value` event's `path` is the full path to the value, the same
coordinate `valueEvents.at` matches, so a top-level member `{version}` is
`["version"]`. `keyEvents` differs: its `at` and `path` are both the
enclosing scope. `StreamValidatorOptions.valueEvents` carries the rest:
which members fire, and how `capture` and `maxCaptureBytes` interact.

### Hook Coverage

`onScopeClose` / `editClose` / `editMember` fire for STREAM structure
only. A member whose enclosing object the classifier routes to a BUFFER
island (`uniqueItems`, `contains`, an object-valued `const`) or a TEE
composition branch (`oneOf`/`anyOf`/`allOf`) does not emit a hook, so
which scopes and members a hook sees depends on the schema's
classification.

A streamed-object member whose own value is a scalar BUFFER island, e.g.
a `format`-bearing scalar, is still editable: the enclosing object
streams and the edit is decided at the value start. Use the hooks for
observing or editing forward-decidable structure. Use a full parser for
general JSON visitation over an arbitrary schema.
