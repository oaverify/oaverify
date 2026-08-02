/**
 * Spec-load benchmark: what resolving a large multi-file spec costs,
 * and what recording source provenance adds to it.
 *
 * Spec load is the path every server process hits at startup and none
 * of them call `check`, so the number that matters most is the one with
 * provenance off: it has to be indistinguishable from a build that
 * cannot record provenance at all.
 *
 * Usage (from a worktree root, after `pnpm build`):
 *   node performance/bench-spec-load.mjs --generate /tmp/bench-spec
 *   node performance/bench-spec-load.mjs /tmp/bench-spec
 *
 * Generate once and point both builds at the same directory, or the
 * two runs are not comparing the same work. `--generate` is
 * deterministic, so regenerating produces byte-identical files.
 *
 * Zero dependencies beyond the oaverify dist bundle, like
 * bench-real-world.mjs, so it runs against a plain `pnpm build`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const FILES = 120;
const SCHEMAS_PER_FILE = 8;
const PROPS_PER_SCHEMA = 12;
const RUNS = 12;

/**
 * A spec whose shape stresses the thing being measured: many external
 * documents, many references across them, and far more nodes than
 * references, so per-node cost and per-reference cost are separable.
 */
function generate(dir) {
  mkdirSync(dir, { recursive: true });

  for (let f = 0; f < FILES; f += 1) {
    const schemas = {};
    for (let s = 0; s < SCHEMAS_PER_FILE; s += 1) {
      const properties = {};
      for (let p = 0; p < PROPS_PER_SCHEMA; p += 1) {
        properties[`prop_${p}`] = {
          type: "string",
          description: `property ${p} of schema ${s} in file ${f}`,
          minLength: p,
          maxLength: 100 + p,
        };
      }
      // One cross-file reference per schema, so the reference count
      // grows with the document rather than staying constant.
      properties["next"] = { $ref: `./m${(f + 1) % FILES}.json#/components/schemas/S0` };
      schemas[`S${s}`] = {
        type: "object",
        required: [`prop_0`],
        properties,
      };
    }
    writeFileSync(join(dir, `m${f}.json`), JSON.stringify({ components: { schemas } }));
  }

  const paths = {};
  for (let f = 0; f < FILES; f += 1) {
    const content = {};
    // Reference every schema in the file, so hoisting has to carry all
    // of them into the resolved document rather than deduping down to
    // one per file.
    for (let s = 0; s < SCHEMAS_PER_FILE; s += 1) {
      content[`application/vnd.s${s}+json`] = {
        schema: { $ref: `./m${f}.json#/components/schemas/S${s}` },
      };
    }
    paths[`/r${f}`] = {
      post: {
        operationId: `op${f}`,
        requestBody: { content },
        responses: { 200: { description: "ok" } },
      },
    };
  }
  writeFileSync(
    join(dir, "entry.json"),
    JSON.stringify({ openapi: "3.1.0", info: { title: "Bench", version: "1" }, paths }),
  );
  return join(dir, "entry.json");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--generate") {
    const dir = resolvePath(args[1] ?? "/tmp/bench-spec");
    const entry = generate(dir);
    process.stdout.write(`generated ${FILES + 1} files under ${dir}\n`);
    process.stdout.write(`entry: ${entry}\n`);
    return;
  }

  const dir = resolvePath(args[0] ?? "/tmp/bench-spec");
  const entry = join(dir, "entry.json");

  // The @oaverify/core bundle for the worktree this is run from, so
  // pointing two worktrees at the same generated spec compares builds.
  const spec = await import(pathToFileURL(resolvePath(process.cwd(), "dist/spec.js")).href);
  const { composeReaders, createFileReader, loadSpec } = spec;

  // Two readers, because they answer different questions. The
  // filesystem one is what a server process actually pays at startup,
  // where reads dominate. The in-memory one takes the reads out so the
  // walk's own cost is visible, which is where a per-node instrumentation
  // regression would hide.
  const fileReader = () => composeReaders([createFileReader(dir)]);
  const preloaded = new Map();
  {
    const seed = await loadSpec({ reader: fileReader(), entry });
    void seed;
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const name of readdirSync(dir)) {
      preloaded.set(join(dir, name), JSON.parse(readFileSync(join(dir, name), "utf8")));
    }
  }
  const memoryReader = () => ({
    canRead: (uri) => preloaded.has(uri),
    read: async (uri) => structuredClone(preloaded.get(uri)),
  });

  const run = async (reader, options) => {
    const started = process.hrtime.bigint();
    const loaded = await loadSpec({ reader: reader(), entry, ...options });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    return { elapsed, loaded };
  };

  const measure = async (reader) => {
    // Warm up: the first loads pay JIT and page-cache costs that have
    // nothing to do with what is being compared.
    for (let i = 0; i < 3; i += 1) {
      await run(reader, {});
      await run(reader, { provenance: true });
    }
    const off = [];
    const on = [];
    for (let i = 0; i < RUNS; i += 1) {
      // Interleaved rather than in two blocks, so a drift in machine
      // state lands on both series instead of on one.
      off.push((await run(reader, {})).elapsed);
      on.push((await run(reader, { provenance: true })).elapsed);
    }
    return { off: median(off), on: median(on) };
  };

  const fromDisk = await measure(fileReader);
  const fromMemory = await measure(memoryReader);

  const { loaded } = await run(memoryReader, { provenance: true });
  const regions = loaded.regions ?? [];
  const nodes = countNodes(loaded.document);

  const line = (label, m) =>
    `${label.padEnd(22)} off ${m.off.toFixed(2)} ms   on ${m.on.toFixed(2)} ms   ` +
    `on/off ${(m.on / m.off).toFixed(3)}x   +${(m.on - m.off).toFixed(2)} ms`;

  process.stdout.write(
    [
      `spec:                  ${FILES + 1} files, ${nodes} nodes in the resolved document`,
      `regions recorded:      ${regions.length}`,
      line("filesystem reader:", fromDisk),
      line("in-memory reader:", fromMemory),
      "",
    ].join("\n"),
  );
}

function countNodes(value) {
  if (value === null || typeof value !== "object") return 1;
  let total = 1;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    total += countNodes(child);
  }
  return total;
}

await main();
