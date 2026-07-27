/**
 * Bounding untrusted streamed input. A streaming validator keeps memory
 * bounded for forward-decidable schemas, but a schema can still leave
 * dimensions open (an array with no `maxItems`, a `uniqueItems` whose
 * seen-set grows with the input). For untrusted callers, close them:
 *
 *   - `enforceBounds: true` turns the classifier's unbounded-* warnings
 *     into a construction-time throw, so an open-ended schema is rejected
 *     before any byte streams.
 *   - `maxTotalBytes` refuses input past a byte ceiling regardless of
 *     validity (a policy lever, enforced mid-stream).
 *   - An over-limit count/length (`maxItems`, `maxProperties`,
 *     `maxLength`) fails fast at the offending element, before the rest
 *     of the body streams.
 *
 * These examples use inline schemas instead of a spec file, since the
 * subject is the raw schema and option surface. See docs/configuration.md
 * for the in-memory analogs (`maxDepth`, regex hardening) and
 * stream-validator's README for the full limit set.
 *
 * Translation to the published package: import from
 * `@oaverify/stream`. See ./README.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/stream-limits.ts
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SchemaOrBoolean } from "../packages/core/src/index.ts";
import {
  createStreamValidator,
  MaxTotalBytesError,
  ValidationFailedError,
} from "../packages/stream-validator/src/index.ts";

const drain = async (src: AsyncIterable<Buffer>): Promise<void> => {
  for await (const _ of src) {
    /* discard */
  }
};

// --- enforceBounds rejects an open-ended schema at construction -------------
// `uniqueItems` keeps an O(elements) seen-set; with no `maxItems` it is
// unbounded. enforceBounds refuses it before streaming a byte.
{
  const open: SchemaOrBoolean = { type: "array", uniqueItems: true };
  try {
    createStreamValidator(open, { enforceBounds: true });
    console.log("enforceBounds (no maxItems) -> constructed (unexpected!)");
  } catch (err) {
    console.log("enforceBounds (no maxItems) -> rejected: " + (err as Error).message);
  }

  // A structural bound clears the warning: now it constructs.
  const bounded: SchemaOrBoolean = { type: "array", uniqueItems: true, maxItems: 1000 };
  createStreamValidator(bounded, { enforceBounds: true });
  console.log("enforceBounds (maxItems: 1000) -> constructed");
}

// --- maxTotalBytes refuses oversize input mid-stream -----------------------
{
  const validator = createStreamValidator(true, { maxTotalBytes: 16 });
  try {
    await pipeline(Readable.from('{"data":"' + "x".repeat(64) + '"}'), validator, drain);
    console.log("\nmaxTotalBytes: 16 -> accepted (unexpected!)");
  } catch (err) {
    // A size-limit overflow is a fatal error (not a schema violation), so
    // `pipeline` rejects with a MaxTotalBytesError, not ValidationFailedError.
    // `instanceof` tells "too big" from "invalid" without matching the message.
    if (err instanceof MaxTotalBytesError) {
      console.log(`\nmaxTotalBytes: 16 -> rejected: over the ${err.limit}-byte cap`);
    } else {
      throw err;
    }
  }
}

// --- An over-count body fails fast at the offending element ----------------
// maxItems: 3, but the body has 5 elements. Under the default `terminate`
// policy the stream fails at element 3, before elements 4 and 5 stream.
{
  const schema: SchemaOrBoolean = { type: "array", items: { type: "integer" }, maxItems: 3 };
  const validator = createStreamValidator(schema);
  try {
    await pipeline(Readable.from("[1,2,3,4,5]"), validator, drain);
    console.log("\nmaxItems: 3 on [1..5] -> accepted (unexpected!)");
  } catch (err) {
    if (err instanceof ValidationFailedError) {
      const v = err.verdict.violations[0];
      console.log(`\nmaxItems: 3 on [1..5] -> rejected: ${v?.code} @byte ${v?.byteOffset}`);
    } else {
      throw err;
    }
  }
}
