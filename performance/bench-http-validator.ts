/**
 * Hot-path benchmark for @oaverify/internal-validator request/response orchestration.
 *
 * This complements run.ts, which measures the JSON Schema compiler
 * directly. The validator benchmark constructs one OpenAPI validator,
 * then times repeated validateRequest / validateResponse calls through
 * routing, content negotiation, and body-schema validation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bench } from "tinybench";
import { createValidator } from "../packages/validator/src/index.ts";
import type { HttpRequest, HttpResponse, OpenAPIDocument } from "../packages/core/src/index.ts";

const args = process.argv.slice(2);
const numArg = (name: string, dflt: number): number => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number.parseInt(a.slice(name.length + 3), 10) : dflt;
};
const time = numArg("time", 500);

type Result = {
  task: string;
  hz: number;
  mean: number;
};

function fmtHz(hz: number): string {
  if (hz >= 1e6) return (hz / 1e6).toFixed(2) + "M";
  if (hz >= 1e3) return (hz / 1e3).toFixed(1) + "K";
  return hz.toFixed(0);
}

function fmtUs(us: number): string {
  if (us < 1) return (us * 1000).toFixed(2) + "ns";
  if (us < 1000) return us.toFixed(2) + "us";
  return (us / 1000).toFixed(2) + "ms";
}

function taskStats(t: { result?: unknown }): { hz: number; mean: number } | null {
  const r = t.result as { throughput?: { mean?: number }; latency?: { mean?: number } } | undefined;
  const hz = r?.throughput?.mean;
  const latency = r?.latency?.mean;
  if (typeof hz !== "number" || typeof latency !== "number") return null;
  return { hz, mean: latency * 1e3 };
}

const widgetSchema = {
  type: "object",
  required: ["id", "name", "price", "tags"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 3, maxLength: 80 },
    price: { type: "number", minimum: 0 },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const content = {
  "application/json": { schema: widgetSchema },
  "application/vnd.oav.widget+json; version=1": { schema: widgetSchema },
  "application/*": { schema: widgetSchema },
} as const;

const spec: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "HTTP validator benchmark", version: "1.0.0" },
  paths: {
    "/widgets/{id}": {
      post: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", minLength: 1 },
          },
        ],
        requestBody: {
          required: true,
          content,
        },
        responses: {
          "200": {
            description: "ok",
            content,
          },
        },
      },
    },
  },
};

const validator = createValidator(spec);

const body = {
  id: "w-123",
  name: "desk lamp",
  price: 42,
  tags: ["lighting", "office"],
};

const reqValid: HttpRequest = {
  method: "POST",
  path: "/widgets/w-123",
  contentType: "application/vnd.oav.widget+json; version=1; charset=utf-8",
  pathParams: {},
  body,
};

const reqWrongContentType: HttpRequest = {
  ...reqValid,
  contentType: "text/csv",
};

const resValid: HttpResponse = {
  status: 200,
  contentType: "application/vnd.oav.widget+json; version=1; charset=utf-8",
  body,
};

const resWrongContentType: HttpResponse = {
  ...resValid,
  contentType: "text/csv",
};

if (!validator.validateRequest(reqValid).valid) throw new Error("valid request preflight failed");
if (validator.validateRequest(reqWrongContentType).valid) {
  throw new Error("wrong-content-type request preflight failed");
}
if (!validator.validateResponse(reqValid, resValid).valid) {
  throw new Error("valid response preflight failed");
}
if (validator.validateResponse(reqValid, resWrongContentType).valid) {
  throw new Error("wrong-content-type response preflight failed");
}

const bench = new Bench({ time });
bench
  .add("validateRequest valid media type", () => {
    validator.validateRequest(reqValid);
  })
  .add("validateRequest wrong content-type", () => {
    validator.validateRequest(reqWrongContentType);
  })
  .add("validateResponse valid media type", () => {
    validator.validateResponse(reqValid, resValid);
  })
  .add("validateResponse wrong content-type", () => {
    validator.validateResponse(reqValid, resWrongContentType);
  });

await bench.run();

const results: Result[] = [];
console.log(`\n=== HTTP validator hot path (${time}ms/task) ===`);
for (const t of bench.tasks) {
  const stats = taskStats(t);
  if (stats === null) {
    console.log(`  ${t.name.padEnd(42)} ERRORED`);
    continue;
  }
  console.log(
    `  ${t.name.padEnd(42)} ${fmtHz(stats.hz).padStart(8)} ops/s  ${fmtUs(stats.mean).padStart(10)} / op`,
  );
  results.push({ task: t.name, hz: stats.hz, mean: stats.mean });
}

const perfDir = dirname(fileURLToPath(import.meta.url));
const timestamp = new Date().toISOString();
const cpuList = cpus();
const payload = JSON.stringify(
  {
    meta: {
      timestamp,
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpuList[0]?.model ?? "unknown",
      cpuCount: cpuList.length,
      timePerTaskMs: time,
    },
    results,
  },
  null,
  2,
);

const historyDir = resolve(perfDir, "results");
mkdirSync(historyDir, { recursive: true });
const outPath = join(historyDir, `http-validator-${timestamp.replace(/:/g, "-")}.json`);
writeFileSync(outPath, payload);
console.log(`\nRaw numbers written to ${outPath}`);
