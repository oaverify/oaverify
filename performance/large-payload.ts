/**
 * Large-response stress benchmark: how oaverify behaves when the payload is
 * a very large array (tens to hundreds of MB once parsed), which is the
 * regime real API responses hit and the synthetic `run.ts`
 * microbenchmarks (100-element arrays) do not.
 *
 * What it isolates that ops/sec cannot:
 *
 *   - parse vs validate split. A large body is `JSON.parse`d into a JS
 *     object graph before any validator runs; that parse + residency
 *     often dwarfs validation. We measure both.
 *   - retained memory. oaverify's DEFAULT mode collects every error into a
 *     tree. On a broadly-invalid large payload that is ~one node per
 *     failure: an unbounded-memory / OOM vector. `maxErrors` and
 *     `predicate` bound it. We measure the RSS the validator retains
 *     on top of the (already resident) payload.
 *   - the default-mode mismatch vs Ajv. Ajv's default is `allErrors:
 *     false` (fast-fail); oaverify's default is collect-all. Comparing
 *     Ajv-default against oav-default compares fast-fail against
 *     collect-all. This script runs both Ajv modes so the comparison
 *     can be made honestly: Ajv-default ~ oav-maxErrors:1,
 *     Ajv-allErrors ~ oav-default.
 *
 * Each (engine+mode, validity) scenario runs in its own child process
 * so retained error trees never overlap in one heap and a crash in one
 * cell is contained. The parent spawns, the child measures one cell and
 * prints a single JSON line.
 *
 * Usage (from performance/, after `pnpm install`):
 *   pnpm bench:large                 # default element count
 *   LP_N=1000000 pnpm bench:large    # ~hundreds of MB; needs RAM
 *   LP_HEAP=1024 pnpm bench:large    # cap child heap (MB) to force the
 *                                    # OOM vector to show as a crash
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import type { SchemaOrBoolean } from "../packages/core/src/index.ts";

// ----- shared shape -----

const SCHEMA: SchemaOrBoolean = {
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

type Engine = "oav-default" | "oav-maxErrors1" | "oav-predicate" | "ajv-default" | "ajv-allErrors";
type Validity = "valid" | "invalid";

const ENGINES: Engine[] = [
  "oav-default",
  "oav-maxErrors1",
  "oav-predicate",
  "ajv-default",
  "ajv-allErrors",
];
const VALIDITIES: Validity[] = ["valid", "invalid"];

const N = Number.parseInt(process.env.LP_N ?? "500000", 10);
const HEAP_MB = process.env.LP_HEAP ? Number.parseInt(process.env.LP_HEAP, 10) : null;

function buildArray(n: number, validity: Validity): unknown[] {
  const out = new Array(n);
  if (validity === "valid") {
    for (let i = 0; i < n; i += 1) {
      out[i] = { id: i + 1, name: `item-${i}`, tags: ["a", "b", "c"] };
    }
  } else {
    // Every element fails several ways at once (wrong-typed id, missing
    // name, wrong-typed tag, an additional property). This maximises the
    // error-tree size in collect-all mode: the point is to expose the
    // memory vector, not to model a typical near-valid payload.
    for (let i = 0; i < n; i += 1) {
      out[i] = { id: `oops-${i}`, tags: [1, 2, 3], extra: true };
    }
  }
  return out;
}

interface CellResult {
  engine: Engine;
  validity: Validity;
  n: number;
  payloadMB: number;
  parseMs: number;
  validateMs: number;
  payloadRssMB: number; // resident growth from building the parsed payload
  retainedMB: number; // RSS the validator adds on top, after validate (tree live)
  valid: boolean;
  truncated: boolean | null;
}

function rssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function gc(): void {
  // Exposed when the child is spawned with --expose-gc; harmless no-op otherwise.
  (globalThis as { gc?: () => void }).gc?.();
}

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms
}

// ----- child: measure one cell -----

function runCell(engine: Engine, validity: Validity): CellResult {
  const startRss = (gc(), rssMB());

  const data = buildArray(N, validity);
  // A reusable JSON string so we can time parse independently of build.
  const json = JSON.stringify(data);
  const payloadMB = json.length / 1024 / 1024;

  gc();
  const payloadRssMB = rssMB() - startRss;

  // Parse cost, on its own, against the same bytes the validator will see.
  const p0 = now();
  const parsed = JSON.parse(json);
  const parseMs = now() - p0;

  let valid = false;
  let truncated: boolean | null = null;
  const baseRss = (gc(), rssMB());
  const v0 = now();

  if (engine.startsWith("oaverify")) {
    const opts =
      engine === "oav-predicate"
        ? ({ dialect: jsonSchemaDialect, predicate: true } as const)
        : engine === "oav-maxErrors1"
          ? ({ dialect: jsonSchemaDialect, maxErrors: 1 } as const)
          : ({ dialect: jsonSchemaDialect } as const);
    const compiled = compileSchema(SCHEMA, opts);
    const res = compiled.validate(parsed) as boolean | { valid: boolean; truncated?: boolean };
    if (typeof res === "boolean") {
      valid = res;
    } else {
      valid = res.valid;
      truncated = res.truncated ?? false;
    }
  } else {
    const ajv = new Ajv({ allErrors: engine === "ajv-allErrors", strict: false });
    const validateFn = ajv.compile(SCHEMA);
    valid = validateFn(parsed) as boolean;
  }

  const validateMs = now() - v0;
  // No GC here: we want the memory the validator is *retaining* (the
  // error tree) measured while it is still reachable.
  const retainedMB = rssMB() - baseRss;

  // Keep `parsed`/result reachable past the measurement.
  if (valid && (parsed as unknown[]).length < 0) throw new Error("unreachable");

  return {
    engine,
    validity,
    n: N,
    payloadMB,
    parseMs,
    validateMs,
    payloadRssMB,
    retainedMB,
    valid,
    truncated,
  };
}

// ----- parent: orchestrate cells in isolated children -----

function spawnCell(engine: Engine, validity: Validity): Promise<CellResult | { error: string }> {
  return new Promise((resolve) => {
    const selfPath = fileURLToPath(import.meta.url);
    const nodeArgs = ["--expose-gc"];
    if (HEAP_MB !== null) nodeArgs.push(`--max-old-space-size=${HEAP_MB}`);
    nodeArgs.push("--import", "tsx", selfPath, "--worker");
    const child = spawn(process.execPath, nodeArgs, {
      env: { ...process.env, LP_ENGINE: engine, LP_VALIDITY: validity },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).at(-1);
      if (code !== 0 || !line) {
        resolve({ error: code === null ? "killed (likely OOM)" : `exit ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(line) as CellResult);
      } catch {
        resolve({ error: "unparseable child output" });
      }
    });
  });
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  console.log(
    `large-payload stress: N=${N} elements per array${HEAP_MB ? `, heap cap ${HEAP_MB}MB` : ""}`,
  );
  console.log(
    "(each cell runs in its own process; retainedMB = RSS the validator adds on top of the parsed payload)\n",
  );

  const rows: Array<{ engine: Engine; validity: Validity; r: CellResult | { error: string } }> = [];
  for (const validity of VALIDITIES) {
    for (const engine of ENGINES) {
      process.stdout.write(`  ${engine} / ${validity} ... `);
      const r = await spawnCell(engine, validity);
      console.log("error" in r ? `ERROR: ${r.error}` : "ok");
      rows.push({ engine, validity, r });
    }
  }

  // Table
  const header = [
    "engine",
    "validity",
    "payloadMB",
    "parseMs",
    "validateMs",
    "retainedMB",
    "valid",
    "trunc",
  ];
  console.log("\n" + header.join("\t"));
  for (const { engine, validity, r } of rows) {
    if ("error" in r) {
      console.log([engine, validity, "-", "-", "-", "-", "-", r.error].join("\t"));
      continue;
    }
    console.log(
      [
        engine,
        validity,
        fmt(r.payloadMB),
        fmt(r.parseMs),
        fmt(r.validateMs),
        fmt(r.retainedMB),
        String(r.valid),
        r.truncated === null ? "-" : String(r.truncated),
      ].join("\t"),
    );
  }
}

// ----- entry -----

if (process.argv.includes("--worker")) {
  const engine = process.env.LP_ENGINE as Engine;
  const validity = process.env.LP_VALIDITY as Validity;
  const result = runCell(engine, validity);
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  void main();
}
