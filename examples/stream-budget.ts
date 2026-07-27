/**
 * Pre-deploy buffer budget: which bodies can stream, which must buffer,
 * and how large a buffer can get, from the spec alone.
 *
 * `analyzeSpec` runs the same classifier the streaming engine uses, so
 * the budget matches what `createStreamValidator` would do at runtime,
 * without reading a byte of traffic. It is engine-free: importing only
 * the analyzer does not pull the engine in.
 *
 * The spec here has three body shapes on purpose:
 *   - `POST /events`: an array of bounded objects; streams, nothing
 *     buffers.
 *   - `POST /batches` `checksums`: `uniqueItems` forces a buffer island,
 *     but `maxItems` + `maxLength` bound it, so the peak is a number.
 *   - `POST /batches` `tags`: `uniqueItems` with no bounds, so the peak
 *     is `"unbounded"` and the report names the missing keyword. This is
 *     the punch list a deployer tightens.
 *
 * The CLI prints the same budget as a table:
 *   pnpm oaverify stream-check examples/specs/ingest.yaml --verbose
 * and `--fail-on-unbounded` turns it into a CI gate.
 *
 * Translation to the published packages: `analyzeSpec` from
 * `@oaverify/stream`, `resolveSpec` from
 * `@oaverify/core/spec`. See ./README.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/stream-budget.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { resolveSpec } from "../packages/spec/src/index.ts";
import { analyzeSpec, type ByteSize } from "../packages/stream-validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/ingest.yaml", import.meta.url));
const { document } = await resolveSpec({ reader: createYamlFileReader(), entry: specPath });

const fmt = (b: ByteSize): string => (b === "unbounded" ? "unbounded" : `${b} bytes`);

for (const op of analyzeSpec(document).operations) {
  for (const body of op.bodies) {
    const label = `${op.method} ${op.path} ${body.role}${body.status ?? ""}`;
    if (body.error !== undefined) {
      // An unclassifiable schema reports per body instead of aborting the
      // sweep, so one bad body doesn't hide the rest of the spec.
      console.log(`${label} -> error: ${body.error}`);
      continue;
    }
    const { classification, peakBytes, positions } = body.report;
    console.log(`${label} -> ${classification}, peak ${fmt(peakBytes)}`);
    // The positions are the punch list: where buffering happens and what
    // structural keyword is missing when a position has no bound.
    for (const p of positions) {
      const bound =
        p.maxBytes === "unbounded" ? `unbounded (missing ${p.unboundedBy})` : fmt(p.maxBytes);
      console.log(`  ${p.path === "" ? "<root>" : p.path}: ${p.keyword} -> ${bound}`);
    }
  }
}

// A runtime cap changes the question from "how much could this buffer?"
// to "how much can a *passing* stream buffer?": an island over the cap
// fails instead of growing, so the effective peak clamps to the cap.
const capped = analyzeSpec(document, { maxBufferedBytes: 1024 });
const batches = capped.operations.find((op) => op.path === "/batches");
const report = batches?.bodies[0]?.report;
if (report !== undefined) {
  console.log(
    `\nPOST /batches under maxBufferedBytes 1024: intrinsic peak ${fmt(report.peakBytes)}, ` +
      `effective peak ${fmt(report.effectivePeakBytes)}`,
  );
}
