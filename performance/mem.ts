/**
 * Steady-state HTTP-server memory benchmark.
 *
 * Spawns two Express 4 servers (one wraps oav, the other
 * wraps express-openapi-validator, which uses ajv under the hood)
 * against the same 40-schema OpenAPI spec. Hits each with 500 warmup
 * requests + 100 × 500 = 50,000 workload requests round-robin across
 * 13 cases (valid + invalid POST/GET/404/405 on five endpoints,
 * exercising oneOf discrimination, nested objects, pattern + format
 * constraints, and array-of-items schemas). Forces GC between samples
 * via each server's `/__memory?gc=1` endpoint.
 *
 * Reports baseline, post-warmup, steady-state, and post-idle RSS +
 * heapUsed. The gap is the sustained validator + runtime footprint
 * each library carries at rest; growth across 50k reqs is a
 * leak-shape check.
 *
 * Not a `tinybench` task: the numbers measured are memory
 * footprints, which need a running HTTP server with a stable workload
 * rather than microbenchmark-style hot loops.
 *
 * Bootstrap:
 *   cd performance/mem-bench && pnpm install
 *   cd ..
 *   pnpm bench:mem
 *
 * Env overrides (defaults produce the canonical 50k run):
 *   BATCHES (default 100)
 *   PER_BATCH (default 500)
 *   WARMUP (default 500)
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEM_BENCH_DIR = resolve(__dirname, "mem-bench");
const RESULTS_DIR = resolve(__dirname, "results");

const BATCHES = Number(process.env.BATCHES ?? 100);
const PER_BATCH = Number(process.env.PER_BATCH ?? 500);
const WARMUP = Number(process.env.WARMUP ?? 500);

// ----- fixtures (same shape for both servers, identical payloads) -----

const validTransaction = () => ({
  id: "12345678-1234-4234-8234-123456789012",
  amount: { value: 1500, currency: "USD" },
  currency: "USD",
  createdAt: "2026-04-23T10:30:00Z",
  memo: "lunch",
  status: "completed",
  tags: ["food", "travel"],
  paymentMethod: {
    type: "card",
    card: { last4: "4242", brand: "visa", expMonth: 12, expYear: 2028, holderName: "Jane Doe" },
  },
  billingAddress: {
    line1: "500 Main St",
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    country: "US",
    email: "jane@example.com",
  },
});

const invalidTransaction = () => ({
  id: "not-a-uuid",
  amount: { value: -5, currency: "us" },
  currency: "USD",
  createdAt: "yesterday",
  tags: ["", "x".repeat(60)],
  paymentMethod: {
    type: "card",
    card: { last4: "42", brand: "mystery", expMonth: 13, expYear: 1999 },
  },
});

const validTransfer = () => ({
  from: { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Checking" },
  to: { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Savings" },
  items: [
    {
      sku: "SKU-ABC123",
      quantity: 2,
      price: { value: 1999, currency: "USD" },
      metadata: { color: "red" },
    },
    { sku: "SKU-XYZ789", quantity: 1, price: { value: 5000, currency: "USD" } },
  ],
  note: "monthly top-up",
});

const invalidTransfer = () => ({
  from: { accountId: "bad-uuid" },
  to: { displayName: "Savings" },
  items: [],
});

const validAccount = () => ({
  type: "checking",
  owner: {
    kind: "individual",
    firstName: "Jane",
    lastName: "Doe",
    dob: "1990-05-12",
    ssn: "123-45-6789",
  },
  balance: { value: 250000, currency: "USD" },
  openedAt: "2026-01-15T09:00:00Z",
  preferences: { notifications: ["email", "sms"], currency: "USD", locale: "en-US" },
  addresses: [
    { line1: "1 Main St", city: "Austin", region: "TX", postalCode: "73301", country: "US" },
  ],
});

const invalidAccount = () => ({
  type: "crypto",
  owner: { kind: "individual", firstName: "", lastName: "Doe", dob: "not-a-date" },
  balance: { value: 0, currency: "us" },
});

const validInvoice = () => ({
  customer: { accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", displayName: "Acme Corp" },
  issuedAt: "2026-04-23T00:00:00Z",
  dueAt: "2026-05-23T00:00:00Z",
  currency: "USD",
  lineItems: [
    {
      description: "Consulting hours",
      quantity: 10,
      unitPrice: { value: 20000, currency: "USD" },
      taxCategory: "standard",
      discount: { kind: "percent", value: 5 },
    },
    {
      description: "Travel",
      quantity: 1,
      unitPrice: { value: 45000, currency: "USD" },
      taxCategory: "exempt",
    },
  ],
  taxBreakdown: [{ rate: 0.0825, amount: { value: 16500, currency: "USD" }, jurisdiction: "TX" }],
});

const invalidInvoice = () => ({
  customer: { accountId: "not-a-uuid" },
  issuedAt: "tomorrow",
  lineItems: [],
});

const validSubscription = () => ({
  plan: {
    kind: "tiered",
    tiers: [
      { upTo: 100, amount: { value: 1000, currency: "USD" } },
      { upTo: 1000, amount: { value: 800, currency: "USD" } },
    ],
  },
  billingCycle: { interval: "month", intervalCount: 1, anchorDay: 1 },
  startDate: "2026-05-01",
  trialDays: 14,
});

const invalidSubscription = () => ({
  plan: { kind: "metered", unitAmount: { value: 1, currency: "USD" } },
  billingCycle: { interval: "fortnight", intervalCount: 0 },
  startDate: "2026/05/01",
});

type Case = {
  name: string;
  method: string;
  path: string;
  body?: () => Record<string, unknown>;
  headers?: Record<string, string>;
};

const cases: Case[] = [
  { name: "tx-valid", method: "POST", path: "/transactions", body: validTransaction },
  { name: "tx-invalid", method: "POST", path: "/transactions", body: invalidTransaction },
  {
    name: "tf-valid",
    method: "POST",
    path: "/transfers",
    body: validTransfer,
    headers: { "x-idempotency-key": "AAAA-BBBB-CCCC-DDDD" },
  },
  {
    name: "tf-invalid",
    method: "POST",
    path: "/transfers",
    body: invalidTransfer,
    headers: { "x-idempotency-key": "AAAA-BBBB-CCCC-DDDD" },
  },
  { name: "acct-valid", method: "POST", path: "/accounts", body: validAccount },
  { name: "acct-invalid", method: "POST", path: "/accounts", body: invalidAccount },
  { name: "inv-valid", method: "POST", path: "/invoices", body: validInvoice },
  { name: "inv-invalid", method: "POST", path: "/invoices", body: invalidInvoice },
  { name: "sub-valid", method: "POST", path: "/subscriptions", body: validSubscription },
  { name: "sub-invalid", method: "POST", path: "/subscriptions", body: invalidSubscription },
  { name: "tx-list", method: "GET", path: "/transactions?limit=25&status=pending" },
  { name: "tx-unknown", method: "POST", path: "/unknown-route", body: () => ({}) },
  { name: "tx-badverb", method: "PATCH", path: "/transactions", body: () => ({}) },
];

// ----- HTTP helpers -----

interface MemorySample {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  uptime: number;
}

async function fireRequest(base: string, c: Case): Promise<number> {
  const res = await fetch(base + c.path, {
    method: c.method,
    headers: { "content-type": "application/json", ...c.headers },
    body: c.body ? JSON.stringify(c.body()) : undefined,
  });
  await res.arrayBuffer();
  return res.status;
}

async function sample(base: string, withGc = true): Promise<MemorySample> {
  const r = await fetch(base + `/__memory${withGc ? "?gc=1" : ""}`);
  return (await r.json()) as MemorySample;
}

async function batchRun(
  base: string,
  n: number,
): Promise<{ durationMs: number; statuses: Record<number, number> }> {
  const statuses = new Map<number, number>();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const c = cases[i % cases.length]!;
    const got = await fireRequest(base, c);
    statuses.set(got, (statuses.get(got) ?? 0) + 1);
  }
  return {
    durationMs: performance.now() - t0,
    statuses: Object.fromEntries(statuses),
  };
}

// ----- server lifecycle -----

interface ServerHandle {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  base: string;
}

async function startServer(script: string, port: number): Promise<ServerHandle> {
  const proc = spawn("node", ["--expose-gc", script], {
    cwd: MEM_BENCH_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://localhost:${port}`;
  proc.stderr.on("data", (d) => process.stderr.write(`[server:${port}] ${d}`));

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server ${script} did not ready in 10s`)),
      10000,
    );
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(`listening on ${port}`)) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.once("exit", (code) => reject(new Error(`server ${script} exited early (${code})`)));
  });
  await ready;
  return { proc, base };
}

async function stopServer(h: ServerHandle): Promise<void> {
  const closed = new Promise<void>((resolve) => h.proc.once("exit", () => resolve()));
  h.proc.kill("SIGTERM");
  await closed;
}

// ----- per-server run -----

interface BatchResult {
  batch: number;
  durationMs: number;
  statuses: Record<number, number>;
}

interface ServerResult {
  label: string;
  baseline: MemorySample;
  afterWarmup: MemorySample;
  perBatch: (BatchResult & MemorySample)[];
  postIdle: MemorySample;
}

async function runOne(label: string, script: string, port: number): Promise<ServerResult> {
  process.stderr.write(`\n[mem] ${label}: starting ${script}\n`);
  const srv = await startServer(script, port);
  try {
    const baseline = await sample(srv.base, true);
    process.stderr.write(
      `[mem] ${label}: baseline  rss=${mb(baseline.rss)}  heapUsed=${mb(baseline.heapUsed)}\n`,
    );

    await batchRun(srv.base, WARMUP);
    const afterWarmup = await sample(srv.base, true);
    process.stderr.write(
      `[mem] ${label}: warmup    rss=${mb(afterWarmup.rss)}  heapUsed=${mb(afterWarmup.heapUsed)}\n`,
    );

    const perBatch: (BatchResult & MemorySample)[] = [];
    for (let i = 0; i < BATCHES; i++) {
      const res = await batchRun(srv.base, PER_BATCH);
      const mem = await sample(srv.base, true);
      perBatch.push({ batch: i + 1, ...res, ...mem });
      if ((i + 1) % 10 === 0 || i === 0) {
        process.stderr.write(
          `[mem] ${label}: batch ${i + 1}/${BATCHES}  ${res.durationMs.toFixed(0)}ms  rss=${mb(mem.rss)}  heapUsed=${mb(mem.heapUsed)}\n`,
        );
      }
    }

    await new Promise((r) => setTimeout(r, 2000));
    const postIdle = await sample(srv.base, true);
    process.stderr.write(
      `[mem] ${label}: postIdle  rss=${mb(postIdle.rss)}  heapUsed=${mb(postIdle.heapUsed)}\n`,
    );

    return { label, baseline, afterWarmup, perBatch, postIdle };
  } finally {
    await stopServer(srv);
  }
}

// ----- output -----

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarize(r: ServerResult) {
  const lastFive = r.perBatch.slice(-5);
  return {
    baselineRss: r.baseline.rss,
    baselineHeapUsed: r.baseline.heapUsed,
    afterWarmupRss: r.afterWarmup.rss,
    afterWarmupHeapUsed: r.afterWarmup.heapUsed,
    steadyRss: avg(lastFive.map((b) => b.rss)),
    steadyHeapUsed: avg(lastFive.map((b) => b.heapUsed)),
    postIdleRss: r.postIdle.rss,
    postIdleHeapUsed: r.postIdle.heapUsed,
    growthRss: r.perBatch.at(-1)!.rss - r.afterWarmup.rss,
    growthHeapUsed: r.perBatch.at(-1)!.heapUsed - r.afterWarmup.heapUsed,
    avgBatchMs: avg(r.perBatch.map((b) => b.durationMs)),
  };
}

function printTable(oav: ServerResult, eov: ServerResult): void {
  const o = summarize(oav);
  const e = summarize(eov);
  const row = (label: string, ov: number, ev: number, format: (n: number) => string) =>
    `${label.padEnd(28)}  ${format(ov).padStart(12)}  ${format(ev).padStart(12)}  ${format(ev - ov).padStart(12)}`;
  const pct = (ov: number, ev: number) => ((1 - ov / ev) * 100).toFixed(0) + "%";

  console.log("");
  console.log(
    `=== Steady-state memory: ${BATCHES} × ${PER_BATCH} = ${BATCHES * PER_BATCH} reqs ===`,
  );
  console.log("");
  console.log(
    `${"metric".padEnd(28)}  ${"oav".padStart(12)}  ${"eov+ajv".padStart(12)}  ${"Δ (eov-oav)".padStart(12)}`,
  );
  console.log("-".repeat(72));
  console.log(
    row("baseline  RSS", o.baselineRss, e.baselineRss, mb),
    ` (-${pct(o.baselineRss, e.baselineRss)})`,
  );
  console.log(row("baseline  heapUsed", o.baselineHeapUsed, e.baselineHeapUsed, mb));
  console.log(row("warmup    RSS", o.afterWarmupRss, e.afterWarmupRss, mb));
  console.log(row("warmup    heapUsed", o.afterWarmupHeapUsed, e.afterWarmupHeapUsed, mb));
  console.log(
    row("steady    RSS (avg last 5)", o.steadyRss, e.steadyRss, mb),
    ` (-${pct(o.steadyRss, e.steadyRss)})`,
  );
  console.log(row("steady    heapUsed (avg)", o.steadyHeapUsed, e.steadyHeapUsed, mb));
  console.log(row("postIdle  RSS", o.postIdleRss, e.postIdleRss, mb));
  console.log(row("postIdle  heapUsed", o.postIdleHeapUsed, e.postIdleHeapUsed, mb));
  console.log(row("growth    RSS", o.growthRss, e.growthRss, mb));
  console.log(row("growth    heapUsed", o.growthHeapUsed, e.growthHeapUsed, mb));
  console.log("");
  console.log(
    `batch throughput (avg ms per ${PER_BATCH}-req batch): oav ${o.avgBatchMs.toFixed(0)}ms, eov ${e.avgBatchMs.toFixed(0)}ms`,
  );
}

// ----- main -----

const oav = await runOne("oav", "server-oav.mjs", 3800);
const eov = await runOne("eov", "server-eov.mjs", 3810);

// Sanity: both servers should have seen the same status distribution each batch.
const oavStatuses = JSON.stringify(oav.perBatch[0]!.statuses);
const eovStatuses = JSON.stringify(eov.perBatch[0]!.statuses);
if (oavStatuses !== eovStatuses) {
  process.stderr.write(
    `\n[mem] WARNING: status-code mismatch between servers\n  oav: ${oavStatuses}\n  eov: ${eovStatuses}\n`,
  );
}

printTable(oav, eov);

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = resolve(RESULTS_DIR, `mem-${stamp}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ batches: BATCHES, perBatch: PER_BATCH, warmup: WARMUP, oav, eov }, null, 2),
);
console.log(`\nRaw numbers written to ${outPath}`);
