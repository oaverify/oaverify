/**
 * Error-tree memory anatomy: where the bytes go when oaverify collects a full
 * error tree on a broadly-invalid large payload (default, non-`maxErrors`
 * mode). Companion to `large-payload.ts`, which showed that the default
 * collect-all mode retains ~60x the payload size and is ~2.8x heavier
 * than ajv's `allErrors` tree. This breaks that retention down by
 * component so an optimization targets the right thing.
 *
 * Method: build the tree once, then null out one component at a time
 * (messages -> params -> paths), forcing GC and reading `heapUsed` after
 * each, so each delta approximates that component's retained cost. Also
 * counts leaf vs branch nodes and empty vs non-empty params.
 *
 * Run with --expose-gc so the deltas are meaningful:
 *   node --expose-gc --import tsx error-tree-anatomy.ts
 *   pnpm bench:anatomy
 *
 * Headline finding (N=200000): paths and node objects are ~95% of the
 * retained tree; messages ~4%, params <1%. The gap vs ajv is structural
 * (a rich node per error + a materialised path array per node), not a
 * field that can be trimmed. `maxErrors` bounds node count and is the
 * real lever for large invalid payloads.
 */

import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import type { SchemaOrBoolean, ValidationError } from "../packages/core/src/index.ts";

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  items: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      tags: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
};

const N = Number.parseInt(process.env.LP_N ?? "200000", 10);

function buildInvalid(n: number): unknown[] {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = { id: `oops-${i}`, tags: [1, 2, 3], extra: true };
  return out;
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
function heapMB(): number {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function walk(e: ValidationError, fn: (x: ValidationError) => void): void {
  fn(e);
  for (const c of e.children) walk(c, fn);
}

function main(): void {
  if ((globalThis as { gc?: () => void }).gc === undefined) {
    console.warn("warning: run with --expose-gc for meaningful deltas\n");
  }

  const data = buildInvalid(N);
  const v = compileSchema(SCHEMA as SchemaOrBoolean, {
    dialect: jsonSchemaDialect,
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
  });
  const res = v.validate(data) as { valid: boolean; error?: ValidationError };
  const root = res.error;
  if (root === undefined) throw new Error("expected the payload to be invalid");

  let leaves = 0;
  let branches = 0;
  let msgChars = 0;
  let pathSegs = 0;
  let emptyParams = 0;
  let nonEmptyParams = 0;
  walk(root, (e) => {
    if (e.children.length === 0) leaves += 1;
    else branches += 1;
    msgChars += e.message.length;
    pathSegs += e.path.length;
    if (Object.keys(e.params).length === 0) emptyParams += 1;
    else nonEmptyParams += 1;
  });

  // Drop the parsed payload's grip is not possible (still referenced by
  // `data`); we measure the tree's marginal cost by component instead.
  const base = heapMB();
  walk(root, (e) => {
    (e as { message: string }).message = "";
  });
  const afterMsg = heapMB();
  walk(root, (e) => {
    (e as { params: unknown }).params = {};
  });
  const afterParams = heapMB();
  walk(root, (e) => {
    (e as { path: unknown }).path = [];
  });
  const afterPath = heapMB();

  console.log(`error-tree anatomy: N=${N} (broadly-invalid array)\n`);
  console.log(`nodes:   ${leaves} leaves, ${branches} branches`);
  console.log(`params:  ${emptyParams} empty, ${nonEmptyParams} non-empty`);
  console.log(
    `totals:  ${(msgChars / 1e6).toFixed(1)}M message chars, ${(pathSegs / 1e6).toFixed(1)}M path segments\n`,
  );
  console.log(`retained heap (tree live):    ${base.toFixed(0)}MB`);
  console.log(
    `  - messages: ${(base - afterMsg).toFixed(0)}MB   (heap now ${afterMsg.toFixed(0)}MB)`,
  );
  console.log(
    `  - params:   ${(afterMsg - afterParams).toFixed(0)}MB   (heap now ${afterParams.toFixed(0)}MB)`,
  );
  console.log(
    `  - paths:    ${(afterParams - afterPath).toFixed(0)}MB   (heap now ${afterPath.toFixed(0)}MB)`,
  );
  console.log(`  - node objects + children arrays: ~${afterPath.toFixed(0)}MB (remainder)`);

  // Keep the tree reachable until after measurement.
  if (root.children.length < 0) console.log("unreachable");
}

main();
