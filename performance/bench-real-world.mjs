/**
 * Real-world OpenAPI benchmark driver. Takes one or more spec entry
 * paths (YAML / JSON), loads each through @oaverify/internal-spec's `loadSpec`,
 * constructs a `Validator`, and reports:
 *
 *   - raw file size on disk
 *   - `loadSpec` duration (read + resolve external $refs)
 *   - `createValidator` construction duration (includes request-body +
 *     parameter compilation per-operation; response bodies are lazy)
 *   - cold-path `validateRequest` median over a sample of operations
 *     (forces lazy compilation of request validators; does not touch
 *     response-body schemas)
 *   - resulting heap usage
 *
 * Usage (from repo root, after `pnpm build`):
 *   node performance/bench-real-world.mjs <spec-entry> [...more entries]
 *
 * The entries must be resolvable by `createFileReader` (local paths
 * or file:// URIs). Relative paths resolve against the process CWD.
 * Inside each spec, external `$ref`s resolve against the entry's own
 * directory.
 *
 * Deliberately zero dependencies beyond the oaverify dist bundle itself,
 * so this script works against a plain `pnpm build` without needing
 * the performance sub-package's dev deps.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import $RefParser from "@apidevtools/json-schema-ref-parser";
import { loadSpec, composeReaders, createFileReader } from "../dist/spec.js";
import { createValidator } from "../dist/index.js";

const entries = process.argv.slice(2);
if (entries.length === 0) {
  console.error("usage: node performance/bench-real-world.mjs <spec-entry> [...]");
  process.exit(2);
}

const reader = composeReaders([createFileReader()]);

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function bytesOfDirectory(entryPath) {
  // Approximate the full spec size as the entry file plus every
  // YAML/JSON file in the directory tree rooted at its parent.
  const dir = dirname(entryPath);
  let total = 0;
  function walk(p) {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let children;
      try {
        children = readdirSync(p);
      } catch {
        return;
      }
      for (const child of children) walk(resolvePath(p, child));
      return;
    }
    if (/\.(yaml|yml|json)$/i.test(p)) total += st.size;
  }
  walk(dir);
  return total || statSync(entryPath).size;
}

// Benchmark one spec.
async function bench(entryPath) {
  const abs = resolvePath(process.cwd(), entryPath);
  const entryUrl = pathToFileURL(abs).href;

  const sizeOnDisk = bytesOfDirectory(abs);

  // Two load paths in sequence:
  //   (a) oaverify's own loadSpec. May fail when a subtree from an external
  //       file contains internal `#/components/...` refs that get
  //       orphaned by the inliner. On this run we time it anyway; if
  //       it throws we fall back to (b) and record the failure.
  //   (b) @apidevtools/json-schema-ref-parser — the same resolver
  //       express-openapi-validator uses. Produces a fully-dereferenced
  //       document we can feed straight to createValidator. Isolates
  //       compile / validate performance from resolver concerns.
  let oavLoadMs = null;
  let oavLoadError = null;
  try {
    const tA = performance.now();
    await loadSpec({ reader, entry: entryUrl });
    oavLoadMs = performance.now() - tA;
  } catch (e) {
    oavLoadError = e instanceof Error ? e.message : String(e);
  }

  const t0 = performance.now();
  const document = await $RefParser.dereference(abs);
  const t1 = performance.now();

  const t2 = performance.now();
  const v = createValidator(document);
  const t3 = performance.now();

  const pathCount = Object.keys(document.paths ?? {}).length;
  const ops = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!pathItem || !pathItem[method]) continue;
      ops.push({ method: method.toUpperCase(), path });
    }
  }

  // Cold-path validateRequest: the first call for each (method, path)
  // triggers the lazy per-op compile. Measure each separately; report
  // the median so one pathological op doesn't drown the signal.
  const validateSample = ops.slice(0, Math.min(ops.length, 50));
  const perCall = [];
  for (const op of validateSample) {
    const testPath = op.path.replace(/\{[^}]+\}/g, "x");
    const t = performance.now();
    v.validateRequest({ method: op.method, path: testPath });
    perCall.push(performance.now() - t);
  }

  // Hot-path: same ops again — request validators are now cached.
  const hotSample = ops.slice(0, Math.min(ops.length, 50));
  const hotPerCall = [];
  for (const op of hotSample) {
    const testPath = op.path.replace(/\{[^}]+\}/g, "x");
    const t = performance.now();
    v.validateRequest({ method: op.method, path: testPath });
    hotPerCall.push(performance.now() - t);
  }

  const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  return {
    file: entryPath,
    openapi: document.openapi,
    size: sizeOnDisk,
    pathCount,
    opCount: ops.length,
    oavLoadMs,
    oavLoadError,
    loadMs: t1 - t0,
    compileMs: t3 - t2,
    coldMedianMs: median(perCall),
    coldMaxMs: Math.max(...perCall, 0),
    hotMedianMs: median(hotPerCall),
    heapMB,
  };
}

const rows = [];
for (const entry of entries) {
  try {
    rows.push(await bench(entry));
  } catch (err) {
    console.error(`ERR ${entry}: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
  }
}

console.log();
console.log(
  [
    "spec",
    "openapi",
    "size",
    "paths",
    "ops",
    "refParse",
    "oavLoad",
    "compile",
    "cold med",
    "cold max",
    "hot med",
    "heap",
  ]
    .map((s, i) => s.padEnd(i === 0 ? 45 : 9))
    .join(""),
);
console.log("-".repeat(145));
for (const r of rows) {
  console.log(
    [
      r.file.length > 43 ? "…" + r.file.slice(-42) : r.file,
      r.openapi ?? "?",
      fmtSize(r.size),
      String(r.pathCount),
      String(r.opCount),
      fmtMs(r.loadMs),
      r.oavLoadError ? "FAIL" : fmtMs(r.oavLoadMs),
      fmtMs(r.compileMs),
      fmtMs(r.coldMedianMs),
      fmtMs(r.coldMaxMs),
      fmtMs(r.hotMedianMs),
      `${r.heapMB}MB`,
    ]
      .map((s, i) => String(s).padEnd(i === 0 ? 45 : 9))
      .join(""),
  );
  if (r.oavLoadError) {
    console.log(`  oaverify loadSpec failed: ${r.oavLoadError}`);
  }
}
console.log();
