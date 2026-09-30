# Streaming Validation

`@oaverify/stream` validates JSON bytes while they stream, echoing input
to a downstream sink and reporting validation on a side channel. The
package README covers the adoption question: when streaming helps, what
schemas can stream, and how to read the buffer-budget analyzer. This file
carries usage recipes and the stream hook reference.

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

## Input Encoding

Malformed UTF-8 in a string or key fails the stream and rejects
`validator.result` with a `JsonParseError` identifying the malformed
sequence's first byte. For a closed ecosystem that needs the previous
replacement behavior, set `utf8: "replace"`. See `StreamValidatorOptions.utf8`.

```ts
const validator = createStreamValidator(schema, { utf8: "replace" });
```

Under `"replace"`, schema validation sees U+FFFD replacement characters.
A printable-ASCII pattern rejects that text; a permissive pattern accepts
it. A sender's own encoded U+FFFD is valid UTF-8 under either setting.

Already echoed bytes remain downstream, including malformed bytes in the
chunk that failed. When storing output, use a staging location and promote
it only after the pipeline completes and `validator.result` resolves valid.
Abort or discard stored output when validation fails.

## Stripping Whitespace

The validator echoes input verbatim. To store a compact body, pipe its
output through a transform that drops insignificant whitespace:

```ts
await pipeline(request, validator, new StripJsonWhitespace(), sink);
```

Keep it after the validator. Violation offsets and `value` spans are input
offsets (see `SchemaViolation.byteOffset`), so they still point into the
original body.

The transform below drops space, tab, LF and CR outside strings and
passes every other byte through unchanged. It assumes well-formed JSON:
the validator fails the pipeline on anything else, but `editClose`
appends are not validated, so keep them well-formed. It adds one pass
over the bytes and forwards a chunk with nothing to drop without copying.

```ts
import { Transform, type TransformCallback } from "node:stream";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * Drops insignificant whitespace from well-formed JSON. String and escape
 * state carry across chunk boundaries. UTF-8 multi-byte sequences are all
 * >= 0x80, so they never match a quote, backslash or whitespace byte.
 */
export class StripJsonWhitespace extends Transform {
  private isInString = false;
  private isEscaped = false;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const length = chunk.length;
    let output: Buffer | undefined;
    let written = 0;
    let runStart = 0;
    let index = 0;
    // Positions of the next backslash and quote at or after `index`, found
    // with Buffer.indexOf; -1 = none left in this chunk, -2 = not searched
    // yet. Both are cached so a string dense with escapes scans the chunk
    // once rather than once per escape.
    let nextBackslash = -2;
    let nextQuote = -2;
    while (index < length) {
      if (this.isInString) {
        if (this.isEscaped) {
          this.isEscaped = false;
          index++;
          continue;
        }
        if (nextBackslash !== -1 && nextBackslash < index) {
          nextBackslash = chunk.indexOf(BACKSLASH, index);
        }
        if (nextQuote !== -1 && nextQuote < index) nextQuote = chunk.indexOf(QUOTE, index);
        if (nextBackslash !== -1 && (nextQuote === -1 || nextBackslash < nextQuote)) {
          this.isEscaped = true;
          index = nextBackslash + 1;
          continue;
        }
        if (nextQuote === -1) break;
        this.isInString = false;
        index = nextQuote + 1;
        continue;
      }
      const byte = chunk[index] as number;
      if (isWhitespace(byte)) {
        output ??= Buffer.allocUnsafe(length);
        written += chunk.copy(output, written, runStart, index);
        index++;
        while (index < length && isWhitespace(chunk[index] as number)) index++;
        runStart = index;
        continue;
      }
      if (byte === QUOTE) this.isInString = true;
      index++;
    }
    if (output === undefined) {
      callback(null, chunk);
      return;
    }
    written += chunk.copy(output, written, runStart);
    callback(null, output.subarray(0, written));
  }
}
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
array never buffers the array. A `drop` removes the member with the
whitespace around it and keeps one comma between the members that
remain, so formatting next to a dropped member is not preserved; see
`MemberEdit` for the rule. A dropped value is discarded as it streams.

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
Both actions work for any value type, and `editMember` hooks do not fire
for members inside a dropped one. Collisions, conflicting hooks and
`maxMemberPrefixBytes`, the cap on a member's held prefix, are fatal
where they apply. A dropped member is discarded as it streams whatever
its size; set `maxMemberDropBytes` to refuse one past a size instead.
See `StreamValidatorOptions` for both limits.

While any `editMember` hook is registered, each member's leading comma,
key and surrounding whitespace are held until the hook decides it, in
every object. Pass `{ scope }` to name the objects a hook edits; when
every hook names one, nothing is held in other objects:

```ts
// Edit only the root object's members.
validator.editMember((path) => path.length === 1, dropUnknown, { scope: [] });
```

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
