/**
 * Recover a few small scalar fields while validating a large body,
 * without a second parser or materializing the whole document.
 *
 * A streaming body often carries a handful of small top-level
 * scalars you need eagerly: an id to route on, a schema version, a
 * timestamp to log. `valueEvents` emits a `value` event when a scalar
 * object member completes; with `capture: true` the decoded value rides
 * along (bounded by `maxCaptureBytes`). The `at` filter matches a
 * member's *full path*, so `path.length === 1` selects top-level
 * members. Container members (objects, arrays) never fire, so the large
 * `items` array below streams past without buffering.
 *
 * Because object members complete in document order, `id` and `version`
 * are captured before the big `items` array streams: a caller can route
 * or log on them while the rest of the body is still in flight.
 *
 * Translation to the published package: import from
 * `@aahoughton/oav-stream-validator`. See ./README.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/stream-recover-fields.ts
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SchemaOrBoolean } from "../packages/core/src/index.ts";
import { createStreamValidator, type ValueEvent } from "../packages/stream-validator/src/index.ts";

const schema: SchemaOrBoolean = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    version: { type: "integer" },
    items: {
      type: "array",
      items: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } },
    },
  },
};

// Lazily emit a body with two small top-level scalars followed by a large
// `items` array. The array is generated chunk-by-chunk, never assembled.
function* docBody(itemCount: number): Generator<string> {
  yield '{"id":"doc-42","version":3,"items":[';
  for (let i = 0; i < itemCount; i++) {
    yield (i === 0 ? "" : ",") + `{"sku":"sku-${i}"}`;
  }
  yield "]}";
}

const captured = new Map<string, unknown>();

const validator = createStreamValidator(schema, {
  // Capture only top-level scalar members (id, version). `items` is a
  // container and does not fire.
  valueEvents: { at: (path) => path.length === 1, capture: true },
});
validator.on("value", (e: ValueEvent) => captured.set(e.key, e.value));

const drain = async (src: AsyncIterable<Buffer>): Promise<void> => {
  for await (const _ of src) {
    /* discard the echoed bytes */
  }
};

await pipeline(Readable.from(docBody(50_000)), validator, drain);
const verdict = await validator.result;

console.log(`validated 50k items -> ${verdict.valid ? "ok" : "FAIL"}`);
console.log("recovered scalars   ->", Object.fromEntries(captured));
