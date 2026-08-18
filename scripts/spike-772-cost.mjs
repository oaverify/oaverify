// What a re-check costs per keystroke, and what `record` mode adds.
//
// Not a gate and not part of any suite. It answers the two questions
// #772 turns on: whether a design that re-resolves and re-checks on
// every edit is viable at all, and whether recording holes costs
// anything when nothing is broken.
//
// Run from the repo root, after `pnpm build` (which builds both
// `@oaverify/core` and `@oaverify/check`):
//   node scripts/spike-772-cost.mjs
//
// Numbers are from one machine and one document shape. Read the ratios.

import { performance } from "node:perf_hooks";
import { resolveSpec } from "../dist/spec.js";
import { checkSpec, selectionForClasses } from "../packages/check/dist/index.js";

const OPERATIONS = Number(process.argv[2] ?? 200);
const RUNS = 20;

/** A document of `n` operations, each with a body schema of its own. */
function document(n) {
  const paths = {};
  const schemas = {};
  for (let i = 0; i < n; i++) {
    schemas[`Model${i}`] = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" } },
        next: { $ref: `#/components/schemas/Model${(i + 1) % n}` },
      },
      required: ["id"],
    };
    paths[`/r${i}/{id}`] = {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "ok",
            content: { "application/json": { schema: { $ref: `#/components/schemas/Model${i}` } } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "bench", version: "1" },
    paths,
    components: { schemas },
  };
}

const whole = document(OPERATIONS);
// The same document with one external reference, which the reader will
// refuse: the mid-keystroke state.
const holed = structuredClone(whole);
holed.paths["/r0/{id}"].get.responses[200].content["application/json"].schema = {
  $ref: "half-typed.json#/Model0",
};

function reader(doc) {
  return {
    canRead: (uri) => uri === "main.json",
    read: async (uri) => {
      if (uri !== "main.json") throw new Error(`no entry for ${uri}`);
      return structuredClone(doc);
    },
  };
}

async function time(label, fn) {
  await fn();
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(46)} ${median.toFixed(1)} ms`);
  return median;
}

const HYGIENE = selectionForClasses(["hygiene"]);

console.log(`document: ${OPERATIONS} operations, ${OPERATIONS} schemas, median of ${RUNS} runs\n`);

const resolveOnly = await time("resolve, default", async () => {
  await resolveSpec({ reader: reader(whole), entry: "main.json", provenance: true });
});

const resolveRecord = await time("resolve, record mode, nothing broken", async () => {
  await resolveSpec({
    reader: reader(whole),
    entry: "main.json",
    provenance: true,
    onUnresolved: "record",
  });
});

await time("resolve, record mode, one hole", async () => {
  await resolveSpec({
    reader: reader(holed),
    entry: "main.json",
    provenance: true,
    onUnresolved: "record",
  });
});

const full = await time("resolve + check, every class", async () => {
  const resolved = await resolveSpec({
    reader: reader(whole),
    entry: "main.json",
    provenance: true,
  });
  checkSpec(resolved);
});

const noCompile = await time("resolve + check, hygiene only (no compile)", async () => {
  const resolved = await resolveSpec({
    reader: reader(whole),
    entry: "main.json",
    provenance: true,
  });
  checkSpec(resolved, { findings: HYGIENE });
});

console.log("");
console.log(
  `record mode overhead, nothing broken:  ${(resolveRecord - resolveOnly).toFixed(1)} ms`,
);
console.log(`compile share of a full check:         ${(full - noCompile).toFixed(1)} ms`);
console.log(`full check vs hygiene only:            ${(full / noCompile).toFixed(1)}x`);
