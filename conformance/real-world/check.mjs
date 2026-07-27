/**
 * Runs each OpenAPI 3.x spec under ./specs/ through @oaverify/internal-spec + @oaverify/internal-validator
 * and reports whether the spec loads, resolves, and produces a working
 * validator. The point is real-world handling, not request/response checking.
 *
 * Usage (from repo root):
 *   pnpm build
 *   node conformance/real-world/check.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { loadSpec, createFileReader, composeReaders } from "../../dist/spec.js";
import { createValidator } from "../../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS = join(HERE, "specs");

const files = readdirSync(SPECS)
  .filter((f) => /\.(json|ya?ml)$/i.test(f))
  .sort();

const reader = composeReaders([createFileReader()]);

function truncate(s, n = 240) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

const results = [];
for (const file of files) {
  const specPath = join(SPECS, file);
  const entry = pathToFileURL(specPath).href;
  const row = {
    file,
    size: null,
    loadMs: null,
    compileMs: null,
    paths: null,
    status: "ok",
    detail: "",
  };
  try {
    const raw = readFileSync(specPath, "utf8");
    row.size = raw.length;
    // Probe the version string from the raw text before we hand off.
    const probe = extname(file).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);
    const version = probe.openapi ?? probe.swagger ?? "(none)";
    if (!String(version).startsWith("3.")) {
      row.status = "skipped";
      row.detail = `openapi=${version}`;
      results.push(row);
      continue;
    }
    const t0 = performance.now();
    const loaded = await loadSpec({ reader, entry });
    const t1 = performance.now();
    row.loadMs = Math.round(t1 - t0);
    row.paths = Object.keys(loaded.document.paths ?? {}).length;
    const t2 = performance.now();
    const v = createValidator(loaded.document);
    const t3 = performance.now();
    row.compileMs = Math.round(t3 - t2);
    // Smoke test: validate a request against every declared operation.
    // We're not checking the result — only that routing + lazy per-op
    // compilation + execution don't throw and don't blow the heap.
    // validateRequest never touches response schemas, so this stays
    // cheap even on Stripe-shaped specs.
    let invoked = 0;
    for (const [path, pathItem] of Object.entries(loaded.document.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
        if (!pathItem || !pathItem[method]) continue;
        const testPath = path.replace(/\{[^}]+\}/g, "x");
        v.validateRequest({ method: method.toUpperCase(), path: testPath });
        invoked += 1;
      }
    }
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    row.detail = `v=${v.detectedVersion ?? "?"} paths=${row.paths} ops=${invoked} heap=${heapMB}MB`;
  } catch (err) {
    row.status = "error";
    row.detail = truncate(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
  results.push(row);
  const tag = row.status === "ok" ? "OK " : row.status === "skipped" ? "SKP" : "ERR";
  const size = row.size ? `${Math.round(row.size / 1024)}KB` : "?";
  const timing = row.loadMs !== null ? `load=${row.loadMs}ms compile=${row.compileMs}ms` : "";
  console.log(`${tag} ${file.padEnd(25)} ${size.padStart(7)}  ${timing.padEnd(30)} ${row.detail}`);
}

const ok = results.filter((r) => r.status === "ok").length;
const err = results.filter((r) => r.status === "error").length;
const skp = results.filter((r) => r.status === "skipped").length;
console.log(`\n${ok} ok, ${err} error, ${skp} skipped (${results.length} total)`);
if (err > 0) process.exit(1);
