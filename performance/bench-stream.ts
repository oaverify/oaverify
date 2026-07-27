/**
 * Streaming vs parse-and-validate, on large payloads.
 *
 * Compares `@oaverify/internal-stream-validator` (one-pass, bytes-in) against the two
 * parse-and-validate engines (`@oaverify/internal-schema` and ajv, both: JSON.parse the
 * whole body, then validate the JS value) on a STREAM-classifiable schema
 * (a large array of typed objects, so the streamer never buffers).
 *
 * Two regimes, because they answer different questions:
 *
 *   throughput  - feed all three the SAME resident byte Buffer; time
 *                 validation only. Shows the JS tokenizer's per-byte cost
 *                 vs native JSON.parse, and peak RSS on top of the
 *                 resident payload.
 *   scale       - the streamer reads a payload GENERATED on the fly (never
 *                 fully resident); parse-and-validate must first
 *                 materialize it. Shows bounded vs payload-proportional
 *                 memory, and the hard wall where materialization fails
 *                 (V8's max string length, ~0.5 GB) long before 2 GB.
 *
 * Each cell runs in its own child process so peak RSS is clean and an OOM
 * / string-limit failure in one cell is contained.
 *
 * Usage (from performance/, after `pnpm install`):
 *   pnpm tsx bench-stream.ts                       # throughput, default sizes
 *   pnpm tsx bench-stream.ts --throughput=32,128,256   # MB sizes
 *   pnpm tsx bench-stream.ts --scale=256,512,1024,2048 # MB; stream vs materialize
 *   STREAM_HEAP=2048 pnpm tsx bench-stream.ts --scale=...  # cap child heap (MB)
 *
 * (A child cell is invoked as: bench-stream.ts --cell <engine> <mode> <bytes>)
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import { createStreamValidator } from "../packages/stream-validator/src/index.ts";
import type { SchemaOrBoolean } from "../packages/core/src/index.ts";

const SCHEMA: SchemaOrBoolean = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "array",
  items: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      active: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
};

const MB = 1024 * 1024;
const CHUNK = 64 * 1024; // 64 KiB write chunks, like a socket

// One array element. ~70 bytes; valid against SCHEMA.
function element(i: number): string {
  return `{"id":${i + 1},"name":"item-${i}","active":${i % 2 === 0},"tags":["a","b","c"]}`;
}

// A Readable that emits ~targetBytes of `[elem, elem, ...]` JSON without
// ever holding the whole payload in memory.
function generated(targetBytes: number): Readable {
  let emitted = 0;
  let i = 0;
  let done = false;
  return new Readable({
    read() {
      if (done) return;
      const parts: string[] = [];
      let batchBytes = 0;
      // Emit ~256 KiB per pull.
      while (batchBytes < 256 * 1024 && emitted < targetBytes) {
        const piece = (i === 0 ? "[" : ",") + element(i);
        parts.push(piece);
        batchBytes += piece.length;
        emitted += piece.length;
        i += 1;
      }
      if (emitted >= targetBytes) {
        parts.push("]");
        done = true;
      }
      this.push(Buffer.from(parts.join(""), "utf8"));
      if (done) this.push(null);
    },
  });
}

// Materialize ~targetBytes into a single Buffer (for the resident /
// parse-and-validate paths). Built from Buffer chunks so generation never
// needs a > max-string-length JS string.
function residentBuffer(targetBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let emitted = 0;
  let i = 0;
  let pending = "[";
  while (emitted < targetBytes) {
    const piece = (i === 0 ? "" : ",") + element(i);
    pending += piece;
    emitted += piece.length + 1;
    i += 1;
    if (pending.length >= 8 * MB) {
      chunks.push(Buffer.from(pending, "utf8"));
      pending = "";
    }
  }
  pending += "]";
  chunks.push(Buffer.from(pending, "utf8"));
  return Buffer.concat(chunks);
}

interface CellResult {
  ok: boolean;
  valid?: boolean;
  ms?: number;
  bytes?: number;
  peakRssMB?: number;
  error?: string;
}

function samplePeakRss(): { stop: () => number } {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 15);
  t.unref();
  return { stop: () => (clearInterval(t), peak) };
}

async function runStream(source: Readable, bytesHint: number): Promise<CellResult> {
  const sampler = samplePeakRss();
  const start = process.hrtime.bigint();
  let bytes = 0;
  const validator = createStreamValidator(SCHEMA, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
  });
  validator.on("error", () => {});
  // Count + discard the echoed output.
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      bytes += c.length;
      cb();
    },
  });
  try {
    const result = validator.result;
    await pipeline(source, validator, sink);
    const verdict = await result;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return {
      ok: true,
      valid: verdict.valid,
      ms,
      bytes: bytes || bytesHint,
      peakRssMB: sampler.stop() / MB,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, peakRssMB: sampler.stop() / MB };
  }
}

// Feed a resident Buffer through the streamer in CHUNK-sized writes.
function bufferToChunks(buf: Buffer): Readable {
  let off = 0;
  return new Readable({
    read() {
      if (off >= buf.length) {
        this.push(null);
        return;
      }
      const end = Math.min(off + CHUNK, buf.length);
      this.push(buf.subarray(off, end));
      off = end;
    },
  });
}

async function cell(engine: string, mode: string, bytes: number): Promise<CellResult> {
  if (engine === "stream") {
    const source = mode === "scale" ? generated(bytes) : bufferToChunks(residentBuffer(bytes));
    return runStream(source, bytes);
  }

  // parse-and-validate: materialize the bytes, decode to a string, parse,
  // validate. In `scale` mode the bytes come from the generator and must
  // be collected first (the cost streaming avoids).
  const sampler = samplePeakRss();
  try {
    let buf: Buffer;
    if (mode === "scale") {
      const parts: Buffer[] = [];
      for await (const c of generated(bytes)) parts.push(c as Buffer);
      buf = Buffer.concat(parts);
    } else {
      buf = residentBuffer(bytes);
    }
    const start = process.hrtime.bigint();
    const text = buf.toString("utf8"); // throws past V8's max string length
    const value = JSON.parse(text);
    // Read RSS now, while buf + text + the parsed graph all coexist: this
    // is the materialization peak the interval sampler misses (JSON.parse
    // blocks the event loop, so no timer fires during it).
    const rssAfterParse = process.memoryUsage().rss;
    let valid: boolean;
    if (engine === "ajv") {
      const ajv = new Ajv2020({ allErrors: false, strict: false });
      valid = ajv.compile(SCHEMA)(value) as boolean;
    } else {
      valid = compileSchema(SCHEMA as never, { dialect: jsonSchemaDialect }).validate(value).valid;
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const peak = Math.max(sampler.stop(), rssAfterParse, process.memoryUsage().rss);
    return { ok: true, valid, ms, bytes: buf.length, peakRssMB: peak / MB };
  } catch (err) {
    return { ok: false, error: (err as Error).message, peakRssMB: sampler.stop() / MB };
  }
}

// ---- child entry ----
const argv = process.argv.slice(2);
if (argv[0] === "--cell") {
  const [, engine, mode, bytesStr] = argv;
  cell(engine as string, mode as string, Number(bytesStr)).then((r) => {
    process.stdout.write(JSON.stringify(r) + "\n");
  });
} else {
  await parent(argv);
}

// "--flag=16,64,256" (MB) -> byte sizes; falls back to `fallbackMB`.
function parseSizes(arg: string | undefined, fallbackMB: number[]): number[] {
  const list = arg?.split("=")[1];
  const mbs = list === undefined ? fallbackMB : list.split(",").map(Number);
  return mbs.map((m) => Math.round(m * MB));
}

function spawnCell(engine: string, mode: string, bytes: number): Promise<CellResult> {
  const self = fileURLToPath(import.meta.url);
  const heap = process.env.STREAM_HEAP;
  const nodeArgs = ["--import", "tsx"];
  if (heap !== undefined) nodeArgs.push(`--max-old-space-size=${heap}`);
  nodeArgs.push(self, "--cell", engine, mode, String(bytes));
  return new Promise((resolve) => {
    const child = spawn("node", nodeArgs, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line) as CellResult);
      } catch {
        resolve({ ok: false, error: `child exited ${code} with no result` });
      }
    });
  });
}

function fmtRow(size: number, engine: string, r: CellResult): string {
  const mb = (size / MB).toFixed(0).padStart(5);
  const eng = engine.padEnd(7);
  if (!r.ok) {
    const peak = r.peakRssMB ? `${r.peakRssMB.toFixed(0)}MB` : "";
    return `${mb}MB  ${eng}  FAILED  peakRSS=${peak.padStart(7)}  ${(r.error ?? "").slice(0, 60)}`;
  }
  const secs = (r.ms ?? 0) / 1000;
  const tput = ((r.bytes ?? 0) / MB / secs).toFixed(0);
  return (
    `${mb}MB  ${eng}  ${secs.toFixed(2).padStart(7)}s  ${tput.padStart(5)} MB/s  ` +
    `peakRSS=${(r.peakRssMB ?? 0).toFixed(0).padStart(5)}MB  valid=${r.valid}`
  );
}

async function parent(args: string[]): Promise<void> {
  const scaleArg = args.find((a) => a.startsWith("--scale"));
  const mode = scaleArg ? "scale" : "throughput";
  const sizesBytes = scaleArg
    ? parseSizes(scaleArg, [256, 512, 1024, 2048])
    : parseSizes(
        args.find((a) => a.startsWith("--throughput")),
        [16, 64, 256],
      );
  const engines = mode === "scale" ? ["stream", "oav"] : ["stream", "oav", "ajv"];

  console.log(`\n=== ${mode} === schema: array of typed objects (fully STREAM-classified)\n`);
  for (const size of sizesBytes) {
    for (const engine of engines) {
      const r = await spawnCell(engine, mode, size);
      console.log(fmtRow(size, engine, r));
    }
    console.log("");
  }
}
