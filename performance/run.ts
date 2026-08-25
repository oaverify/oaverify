/**
 * Cross-library benchmarks for @oaverify/internal-schema vs ajv (2020-12 dialect).
 *
 * Two modes:
 *
 *   - Synthetic (default): iterate over ./schemas.ts and measure
 *     compile + validate with hand-authored valid/invalid inputs.
 *   - Spec (--spec=<path>): load an OpenAPI document, extract every
 *     unique request/response body schema, and measure each library's
 *     compile time across the set. Validate is skipped in this mode
 *     because real-world schemas come without paired valid/invalid
 *     fixtures.
 *
 * Output is a timestamped JSON file under ./results/ (gitignored;
 * numbers are host-dependent). Render it into markdown tables with
 * `pnpm bench:render`. See ./README.md for details.
 *
 * Flags:
 *   --time=<ms>      tinybench time budget per task (default 500)
 *   --cooldown=<ms>  fallow sleep after each task to limit cross-talk
 *                    (default 0; set it for publishable runs)
 *   --filter=<name>  run only schemas whose name includes <name>
 *   --spec=<path>    real-world spec compile mode
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import { Bench } from "tinybench";
import Ajv from "ajv/dist/2020.js";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import { builtInFormats } from "../packages/formats/src/index.ts";
import { perfSchemas, type PerfSchema } from "./schemas.ts";

const args = process.argv.slice(2);
const numArg = (name: string, dflt: number): number => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number.parseInt(a.slice(name.length + 3), 10) : dflt;
};
const filterArg = args.find((a) => a.startsWith("--filter="));
const filter = filterArg?.slice("--filter=".length);
const time = numArg("time", 500);
const cooldown = numArg("cooldown", 0);
const specArg = args.find((a) => a.startsWith("--spec="));
const specPath = specArg?.slice("--spec=".length);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Fallow period after every task so thermal / GC state from one task
// doesn't bleed into the next. Applied as a tinybench per-task afterAll
// hook; tasks run sequentially, so this spaces the whole sweep.
const taskOpts = cooldown > 0 ? { afterAll: () => sleep(cooldown) } : {};

type Result = {
  schema: string;
  metric: "compile" | "validate";
  lib: "ajv" | "ajv-reused" | "ajv-fast" | "oav" | "oav-all" | "oav-predicate";
  validity?: "valid" | "invalid";
  hz: number; // ops/sec
  mean: number; // µs/op
  variant?: string; // full task name (e.g. "oav validate (valid)")
};
const results: Result[] = [];

function fmtHz(hz: number): string {
  if (hz >= 1e6) return (hz / 1e6).toFixed(2) + "M";
  if (hz >= 1e3) return (hz / 1e3).toFixed(1) + "K";
  return hz.toFixed(0);
}
function fmtUs(us: number): string {
  if (us < 1) return (us * 1000).toFixed(2) + "ns";
  if (us < 1000) return us.toFixed(2) + "µs";
  return (us / 1000).toFixed(2) + "ms";
}

// tinybench v6's Task.result is a union that includes errored / aborted /
// not-started states with no statistics. Probe for throughput/latency
// instead of dereferencing blindly so one failing task can't take the
// whole script down.
function taskStats(t: { result?: unknown }): { hz: number; mean: number } | null {
  const r = t.result as { throughput?: { mean?: number }; latency?: { mean?: number } } | undefined;
  const hz = r?.throughput?.mean;
  const latency = r?.latency?.mean;
  if (typeof hz !== "number" || typeof latency !== "number") return null;
  return { hz, mean: latency * 1e3 };
}

function taskErrorMessage(t: { result?: unknown }): string | undefined {
  const r = t.result as { error?: { message?: string } } | undefined;
  return r?.error?.message;
}

function validityOf(taskName: string): "valid" | "invalid" | undefined {
  if (taskName.includes("(valid)")) return "valid";
  if (taskName.includes("(invalid")) return "invalid";
  return undefined;
}

async function benchSchema(s: PerfSchema): Promise<void> {
  console.log(`\n=== ${s.name}: ${s.description} ===`);

  // Compile options for oav / ajv are identical each iteration, so hoist
  // them; the hot loop reduces to the library's work.
  const oavOpts = { dialect: jsonSchemaDialect, formats: builtInFormats };
  const ajvFactory = () => new Ajv({ allErrors: true, strict: false });

  // COMPILE BENCH: each task turns a schema object into a callable
  // validator. ajv is measured twice because the two numbers answer
  // different questions and only one of them is what most deployments
  // pay (#935).
  //
  //   "ajv compile" constructs an instance per iteration. A fresh
  //   Ajv2020 compiles the 2020-12 meta-schema before it can compile
  //   anything else, so this is dominated by that one-time cost. It is
  //   the honest number for a process that compiles one schema and
  //   exits, and it is why this column used to be flat across schemas
  //   of wildly different sizes.
  //
  //   "ajv-reused compile" shares one instance, which is what a service
  //   holding per-tenant or per-test validators actually does. ajv
  //   caches compiled schemas by object identity, so compiling the same
  //   object twice returns the first result and measures nothing; the
  //   schema is evicted after each compile to keep every iteration a
  //   real compile. Eviction is the cheapest way to do that which still
  //   hands both libraries the identical object: measured at ~0.1us
  //   against structuredClone's 0.7-2.8us on these shapes, so it sits
  //   under the noise instead of inflating ajv's column.
  //
  // oav has no analogue of either: it holds no instance and compiles no
  // meta-schema, so one task covers it.
  const ajvReused = ajvFactory();
  const compileBench = new Bench({ time });
  compileBench
    .add(
      "ajv compile",
      () => {
        ajvFactory().compile(s.schema);
      },
      taskOpts,
    )
    .add(
      "ajv-reused compile",
      () => {
        ajvReused.compile(s.schema);
        ajvReused.removeSchema(s.schema);
      },
      taskOpts,
    )
    .add(
      "oav compile",
      () => {
        compileSchema(s.schema as never, oavOpts);
      },
      taskOpts,
    );

  await compileBench.run();

  console.log("compile:");
  for (const t of compileBench.tasks) {
    const lib = t.name.split(" ")[0] as Result["lib"];
    const stats = taskStats(t);
    if (stats === null) {
      const why = taskErrorMessage(t) ?? "no result";
      console.log(`  ${t.name.padEnd(22)}  ERRORED (${why})`);
      continue;
    }
    console.log(
      `  ${t.name.padEnd(22)}  ${fmtHz(stats.hz).padStart(8)} ops/s   ${fmtUs(stats.mean).padStart(10)} / op`,
    );
    results.push({ schema: s.name, metric: "compile", lib, hz: stats.hz, mean: stats.mean });
  }

  // VALIDATE BENCH: every library pre-compiles its validator OUTSIDE the
  // timed loop; the hot path is just `validator(sample)`. No closure,
  // no modulo, no cursor math — so what we measure is as close as
  // possible to the real production cost of "I already loaded the spec;
  // now validate this one payload".

  // ajv collecting every error (allErrors: true): full-collect.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const ajvValidate = ajv.compile(s.schema);

  // ajv's fail-fast mode (allErrors: false): stops at the first failure.
  const ajvFast = new Ajv({ allErrors: false, strict: false });
  const ajvValidateFast = ajvFast.compile(s.schema);

  // oav's zero-config default: flat output, maxErrors 1 (fail-fast). The
  // apples-to-apples partner for ajv-fast (allErrors: false).
  const oav = compileSchema(s.schema as never, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
  });

  // oav collecting every error: the partner for ajv (allErrors: true).
  const oavAll = compileSchema(s.schema as never, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    maxErrors: Number.POSITIVE_INFINITY,
  });

  // oav predicate mode: boolean only, no error materialization.
  const oavPredicate = compileSchema(s.schema as never, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    output: "predicate",
  });

  // Each config: how to run it (timed) and its boolean verdict (used by
  // the pre-flight check). Flat / full-collect return `{ valid }`;
  // predicate and ajv return a bare boolean.
  const configs: {
    lib: Result["lib"];
    run: (x: unknown) => void;
    verdict: (x: unknown) => boolean;
  }[] = [
    { lib: "ajv", run: (x) => void ajvValidate(x), verdict: (x) => ajvValidate(x) === true },
    {
      lib: "ajv-fast",
      run: (x) => void ajvValidateFast(x),
      verdict: (x) => ajvValidateFast(x) === true,
    },
    {
      lib: "oav",
      run: (x) => void oav.validate(x),
      verdict: (x) => (oav.validate(x) as { valid: boolean }).valid,
    },
    {
      lib: "oav-all",
      run: (x) => void oavAll.validate(x),
      verdict: (x) => (oavAll.validate(x) as { valid: boolean }).valid,
    },
    {
      lib: "oav-predicate",
      run: (x) => void oavPredicate.validate(x),
      verdict: (x) => oavPredicate.validate(x) === true,
    },
  ];

  // Pre-flight: every authored input must validate as labeled under
  // every config. This both confirms fixtures are correctly labeled and
  // that ajv and oav agree on the verdict; a mismatch means a timed task
  // would measure the wrong path, so fail loudly before timing.
  for (const c of configs) {
    s.validInputs.forEach((x, i) => {
      if (!c.verdict(x)) throw new Error(`${s.name}: ${c.lib} rejects validInputs[${i}]`);
    });
    s.invalidInputs.forEach((x, i) => {
      if (c.verdict(x)) throw new Error(`${s.name}: ${c.lib} accepts invalidInputs[${i}]`);
    });
  }

  // Valid path: one representative sample per config. Invalid path: one
  // task per authored fixture per config, so the published invalid
  // number spans the failure-position spread instead of a single point.
  // Each task still validates ONE fixed payload — pure hot loop, no
  // per-iteration selection.
  const validSample = s.validInputs[0];
  const validateBench = new Bench({ time });
  for (const c of configs) {
    validateBench.add(`${c.lib} validate (valid)`, () => c.run(validSample), taskOpts);
  }
  for (const c of configs) {
    s.invalidInputs.forEach((sample, i) => {
      validateBench.add(`${c.lib} validate (invalid #${i})`, () => c.run(sample), taskOpts);
    });
  }
  await validateBench.run();

  console.log("validate:");
  for (const t of validateBench.tasks) {
    const lib = t.name.split(" ")[0] as Result["lib"];
    const stats = taskStats(t);
    if (stats === null) {
      const why = taskErrorMessage(t) ?? "no result";
      console.log(`  ${t.name.padEnd(30)}  ERRORED (${why})`);
      continue;
    }
    console.log(
      `  ${t.name.padEnd(30)}  ${fmtHz(stats.hz).padStart(8)} ops/s   ${fmtUs(stats.mean).padStart(10)} / op`,
    );
    results.push({
      schema: s.name,
      metric: "validate",
      lib,
      validity: validityOf(t.name),
      hz: stats.hz,
      mean: stats.mean,
      variant: t.name,
    });
  }
}

/**
 * Pull every request / response body schema out of an OpenAPI document,
 * deduplicating by object identity (which works because
 * @apidevtools/json-schema-ref-parser dereferences `$ref`s to shared
 * references, so schemas reused across operations appear as one).
 */
function extractBodySchemas(doc: unknown): unknown[] {
  const out = new Set<unknown>();
  const paths = (doc as Record<string, unknown>)?.paths as Record<string, unknown> | undefined;
  if (paths === undefined) return [];
  for (const pathItem of Object.values(paths)) {
    if (pathItem === null || typeof pathItem !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head", "query"]) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (op === null || typeof op !== "object") continue;
      const reqBody = (op as Record<string, unknown>).requestBody as
        | { content?: Record<string, { schema?: unknown }> }
        | undefined;
      for (const mt of Object.values(reqBody?.content ?? {})) {
        if (mt?.schema !== undefined && mt.schema !== null) out.add(mt.schema);
      }
      const responses = (op as Record<string, unknown>).responses as
        | Record<string, { content?: Record<string, { schema?: unknown }> }>
        | undefined;
      for (const resp of Object.values(responses ?? {})) {
        for (const mt of Object.values(resp?.content ?? {})) {
          if (mt?.schema !== undefined && mt.schema !== null) out.add(mt.schema);
        }
      }
    }
  }
  return [...out];
}

async function benchSpec(path: string): Promise<void> {
  // Use @apidevtools/json-schema-ref-parser to produce a fully
  // dereferenced document. That isolates compile-time comparisons from
  // any resolver differences between libraries and gives ajv / oav an
  // identical input.
  const doc = await $RefParser.dereference(path);
  const schemas = extractBodySchemas(doc);
  console.log(`\n=== Real-world spec: ${path} ===`);
  console.log(`${schemas.length} unique request/response body schemas.`);
  if (schemas.length === 0) return;

  // Per-schema compile timings with plain performance.now(). tinybench's
  // warmup + iteration machinery is overkill at ms scale and across
  // 100+ schemas it blows past anything resembling a reasonable run time.
  const ajvTimes: number[] = [];
  const oavTimes: number[] = [];
  const ajvErrors: string[] = [];
  const oavErrors: string[] = [];

  for (let i = 0; i < schemas.length; i += 1) {
    const schema = schemas[i];

    try {
      const t0 = performance.now();
      // `logger: false` suppresses "unknown format X" warnings that
      // would otherwise flood the output; the schemas use OAS-specific
      // formats (`duration`, `float`) that neither ajv nor ajv-formats
      // recognize by default.
      new Ajv({ allErrors: true, strict: false, logger: false }).compile(schema as never);
      ajvTimes.push(performance.now() - t0);
    } catch (err) {
      ajvErrors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      const t0 = performance.now();
      compileSchema(schema as never, { dialect: jsonSchemaDialect, formats: builtInFormats });
      oavTimes.push(performance.now() - t0);
    } catch (err) {
      oavErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const row = (label: string, times: number[], errors: string[]): void => {
    if (times.length === 0) {
      console.log(`  ${label.padEnd(10)}  all ${schemas.length} schemas failed to compile`);
      return;
    }
    const total = times.reduce((a, b) => a + b, 0);
    const max = Math.max(...times);
    const mean = total / times.length;
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const failed = errors.length;
    const failedTag = failed > 0 ? `  (${failed} failed)` : "";
    console.log(
      `  ${label.padEnd(10)}  total ${fmtUs(total * 1000).padStart(10)}   ` +
        `mean ${fmtUs(mean * 1000).padStart(10)}   ` +
        `p95 ${fmtUs(p95 * 1000).padStart(10)}   ` +
        `max ${fmtUs(max * 1000).padStart(10)}${failedTag}`,
    );
  };

  console.log("compile (per library, aggregated across every schema):");
  row("ajv", ajvTimes, ajvErrors);
  row("oav", oavTimes, oavErrors);

  for (const [lib, errs] of [["ajv", ajvErrors] as const, ["oav", oavErrors] as const]) {
    if (errs.length === 0) continue;
    console.log(`\n${lib} compile errors:`);
    const counts = new Map<string, number>();
    for (const e of errs) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [msg, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`  ${count}×  ${msg.length > 120 ? msg.slice(0, 117) + "…" : msg}`);
    }
    if (counts.size > 5) console.log(`  … and ${counts.size - 5} other distinct error(s)`);
  }

  const pushSpec = (lib: "ajv" | "oav", times: number[]): void => {
    if (times.length === 0) return;
    const total = times.reduce((a, b) => a + b, 0);
    results.push({
      schema: path,
      metric: "compile",
      lib,
      hz: times.length / (total / 1000),
      mean: (total / times.length) * 1000,
    });
  };
  pushSpec("ajv", ajvTimes);
  pushSpec("oav", oavTimes);
}

if (specPath !== undefined) {
  await benchSpec(specPath);
} else {
  const filtered = filter ? perfSchemas.filter((s) => s.name.includes(filter)) : perfSchemas;
  for (const s of filtered) await benchSchema(s);

  // Relative table: each library's ops/sec normalized to ajv's.
  console.log("\n=== Relative throughput (vs ajv = 1.00) ===");
  console.log(
    "schema".padEnd(14) +
      "task".padEnd(22) +
      "ajv".padEnd(8) +
      "ajv-fast".padEnd(10) +
      "oav".padEnd(8) +
      "oav-all".padEnd(9) +
      "oav-pred",
  );
  console.log("-".repeat(72));
  const byKey = new Map<string, Record<string, number>>();
  for (const r of results) {
    const variantLabel = r.variant ? r.variant.replace(/^\S+\s+/, "") : r.metric;
    const key = `${r.schema}|${variantLabel}`;
    const row = byKey.get(key) ?? {};
    row[r.lib] = r.hz;
    byKey.set(key, row);
  }
  for (const [key, row] of byKey) {
    const [schema, task] = key.split("|");
    const ajv = row["ajv"] ?? 0;
    const ajvFast = row["ajv-fast"] ?? 0;
    const oav = row["oav"] ?? 0;
    const oavAll = row["oav-all"] ?? 0;
    const oavPred = row["oav-predicate"] ?? 0;
    const base = ajv || 1;
    const fmt = (n: number) => (n === 0 ? "-" : (n / base).toFixed(2));
    console.log(
      (schema ?? "").padEnd(14) +
        (task ?? "").padEnd(22) +
        "1.00".padEnd(8) +
        fmt(ajvFast).padEnd(10) +
        fmt(oav).padEnd(8) +
        fmt(oavAll).padEnd(9) +
        fmt(oavPred),
    );
  }
}

const perfDir = dirname(fileURLToPath(import.meta.url));

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: perfDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function ajvVersion(): string {
  try {
    return (createRequire(import.meta.url)("ajv/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const timestamp = new Date().toISOString();
const cpuList = cpus();
const meta = {
  timestamp,
  commitSha: gitSha(),
  nodeVersion: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpuList[0]?.model ?? "unknown",
  cpuCount: cpuList.length,
  ajvVersion: ajvVersion(),
  timePerTaskMs: time,
  cooldownMs: cooldown,
  mode: specPath !== undefined ? "spec" : "synthetic",
  specPath: specPath ?? null,
} as const;
const payload = JSON.stringify({ meta, results }, null, 2);

const historyDir = resolve(perfDir, "results");
mkdirSync(historyDir, { recursive: true });
const fileSafeTs = timestamp.replace(/:/g, "-");
const outPath = join(historyDir, `${fileSafeTs}.json`);
writeFileSync(outPath, payload);

console.log(`\nRaw numbers written to ${outPath}`);
console.log(`Render a table with:  pnpm bench:render ${outPath}`);
