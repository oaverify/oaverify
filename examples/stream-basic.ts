/**
 * Streaming validation: validate a JSON body against a schema as the
 * bytes flow through, without ever holding the whole document in memory.
 *
 * `createStreamValidator` returns a Node `Transform`. Drop it into a
 * `pipeline` between a byte source and a sink: the input bytes echo
 * through unchanged, violations report on a side channel, and a clean
 * finish means the body validated. The default policy is `terminate`
 * with `maxErrors: 1`: the first violation destroys the stream and
 * rejects the `pipeline`.
 *
 * A second engine alongside `createValidator`: push-based over a token
 * stream rather than pull-based over a parsed value. It suits large
 * bodies (multi-GB uploads, bulk arrays) you don't want to buffer. For
 * the in-memory validator that takes an already-parsed body, see
 * basic-validation.ts.
 *
 * Translation to the published packages: import `createStreamValidator`
 * from `@aahoughton/oav-stream-validator`. See ./README.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/stream-basic.ts
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatText, type SchemaOrBoolean } from "../packages/core/src/index.ts";
import {
  createStreamValidator,
  type SchemaViolation,
  toValidationError,
  ValidationFailedError,
} from "../packages/stream-validator/src/index.ts";

// A bulk-create array: each element must be `{ id: integer }`. Plain
// STREAM keywords (`type`, `properties`, `required`, `items`), so the
// whole body validates on the forward spine in one pass.
const schema: SchemaOrBoolean = {
  type: "array",
  items: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "integer" } },
  },
};

// Generate the body lazily: each yield is one chunk, so the full array
// is never materialized in this process either. `badAt >= 0` makes one
// element invalid (missing `id`).
function* itemsBody(count: number, badAt = -1): Generator<string> {
  yield "[";
  for (let i = 0; i < count; i++) {
    const item = i === badAt ? '{"oops":true}' : `{"id":${i}}`;
    yield (i === 0 ? "" : ",") + item;
  }
  yield "]";
}

// A sink that discards the echoed bytes but tallies them, so we can show
// the input streamed through unchanged. A real caller would write to a
// file, an upstream service, or `/dev/null`.
function countingSink(): { sink: Writable; bytes: () => number } {
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      cb();
    },
  });
  return { sink, bytes: () => total };
}

// --- A valid 100k-element body streams clean ------------------------------
{
  const validator = createStreamValidator(schema);
  const { sink, bytes } = countingSink();
  await pipeline(Readable.from(itemsBody(100_000)), validator, sink);
  const verdict = await validator.result;
  console.log(`valid 100k items  -> ${verdict.valid ? "ok" : "FAIL"}, echoed ${bytes()} bytes`);
}

// --- One bad element fails fast, before the tail streams ------------------
{
  const validator = createStreamValidator(schema);
  const seen: SchemaViolation[] = [];
  validator.on("violation", (v: SchemaViolation) => seen.push(v));

  try {
    await pipeline(Readable.from(itemsBody(100_000, 7)), validator, countingSink().sink);
    console.log("\nbad element       -> ok (should have failed!)");
  } catch (err) {
    if (err instanceof ValidationFailedError) {
      console.log("\nbad element       -> rejected (as expected)");
      // Bridge the stream violations to @oav/core's error model, then reuse
      // its formatter instead of hand-rolling one. The stream-specific
      // byteOffset rides in params; append it for the "failed early" point.
      for (const v of seen) {
        console.log("  " + formatText(toValidationError(v)) + `  @byte ${v.byteOffset}`);
      }
    } else {
      throw err;
    }
  }
}
