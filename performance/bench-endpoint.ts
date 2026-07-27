/**
 * End-to-end HTTP comparison: a REST endpoint that buffers-then-validates
 * (receive whole body -> JSON.parse -> oaverify) vs one that streams-and-
 * validates (req -> @oaverify/internal-stream-validator). Real `http` server + real
 * sockets, so backpressure is genuine.
 *
 * The headline variable is upload bandwidth: streaming overlaps validation
 * with byte arrival (and can reject mid-upload), while buffer-then-validate
 * can't begin until the last byte lands. Measures:
 *
 *   crossover    - time-to-verdict for a VALID body across upload rates.
 *                  Below the streamer's ~throughput, validation hides
 *                  behind I/O; above it, native parse wins. The "blast"
 *                  row confirms backpressure: /stream gates the client's
 *                  effective upload rate to the validator's speed.
 *   early-reject - an invalid body (bad element near the start): /stream
 *                  rejects after a few KB and closes the socket; /buffer
 *                  must receive the whole body first. Reports MB sent.
 *   concurrency  - N concurrent valid uploads: peak server RSS. /stream is
 *                  flat; /buffer holds N x (body + parsed graph).
 *
 * The server runs in its own child process so its peak RSS is clean.
 *
 * Usage (from performance/, after `pnpm install`):
 *   pnpm tsx bench-endpoint.ts
 *   EP_SIZE_MB=128 EP_CONC=24 pnpm tsx bench-endpoint.ts
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import {
  createStreamValidator,
  ValidationFailedError,
} from "../packages/stream-validator/src/index.ts";
import type { SchemaOrBoolean } from "../packages/core/src/index.ts";

const MB = 1024 * 1024;
const SCHEMA: SchemaOrBoolean = {
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

function element(i: number, invalid: boolean): string {
  // The 2nd element is the bad one in `invalid` runs: id as a string fails
  // `type: integer` near the very start of the body.
  const id = invalid && i === 1 ? '"BAD"' : String(i + 1);
  return `{"id":${id},"name":"item-${i}","tags":["a","b","c"]}`;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server
function runServer(): void {
  const compiled = compileSchema(SCHEMA as never, { dialect: jsonSchemaDialect, maxErrors: 1 });
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;
  }, 15);
  timer.unref();

  const server = http.createServer((req, res) => {
    if (req.url === "/reset") {
      peakRss = process.memoryUsage().rss;
      res.end("ok");
      return;
    }
    if (req.url === "/peak") {
      res.end(JSON.stringify({ peakRssMB: peakRss / MB }));
      return;
    }
    if (req.url === "/buffer") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("error", () => {});
      req.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const valid = compiled.validate(value).valid;
          res.writeHead(valid ? 200 : 422);
          res.end(JSON.stringify({ valid }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ valid: false, parseError: true }));
        }
      });
      return;
    }
    if (req.url === "/stream") {
      const validator = createStreamValidator(SCHEMA); // terminate, maxErrors 1
      const sink = new Writable({ write: (_c, _e, cb) => cb() });
      validator.on("error", () => {});
      let responded = false;
      const respond = (code: number, body: unknown): void => {
        if (responded) return;
        responded = true;
        // `connection: close` + ending the response stops the server
        // reading the request; the client sees the verdict and aborts its
        // upload. (We don't destroy req first, so the response flushes.)
        res.writeHead(code, { connection: "close" });
        res.end(JSON.stringify(body));
      };
      validator.result.then(
        (v) => respond(v.valid ? 200 : 422, { valid: v.valid }),
        (err) =>
          respond(err instanceof ValidationFailedError ? 422 : 400, { valid: false, early: true }),
      );
      req.on("error", () => {});
      req.pipe(validator);
      sink.on("error", () => {});
      validator.pipe(sink);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr !== null && typeof addr === "object") process.stdout.write(`PORT=${addr.port}\n`);
  });
}

// ---------------------------------------------------------------- client
interface UploadResult {
  verdict: string;
  ms: number;
  mbSent: number;
}

function upload(
  port: number,
  opts: { path: string; sizeBytes: number; rate: number | null; invalid: boolean },
): Promise<UploadResult> {
  return new Promise((resolve) => {
    let settled = false;
    let sent = 0;
    const t0 = process.hrtime.bigint();
    const finish = (verdict: string): void => {
      if (settled) return;
      settled = true;
      resolve({ verdict, ms: Number(process.hrtime.bigint() - t0) / 1e6, mbSent: sent / MB });
    };

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          let v = "?";
          try {
            v = (JSON.parse(body) as { valid?: boolean }).valid ? "valid" : "invalid";
          } catch {
            v = "parse-error";
          }
          finish(v);
        });
      },
    );

    // Single drain/close coordination (no per-chunk listener leak).
    let closed = false;
    let wakeDrain: (() => void) | null = null;
    const wake = (): void => {
      if (wakeDrain) {
        const w = wakeDrain;
        wakeDrain = null;
        w();
      }
    };
    req.on("drain", wake);
    req.on("close", () => {
      closed = true;
      wake();
    });
    req.on("error", () => {
      closed = true;
      wake();
      finish("aborted");
    });

    void (async () => {
      let i = 0;
      const startNs = process.hrtime.bigint();
      while (sent < opts.sizeBytes && !settled && !closed && req.writable) {
        const piece = Buffer.from((i === 0 ? "[" : ",") + element(i, opts.invalid), "utf8");
        i += 1;
        const ok = req.write(piece);
        sent += piece.length;
        if (!ok && !closed) await new Promise<void>((r) => (wakeDrain = r)); // backpressure
        if (opts.rate !== null) {
          const targetMs = (sent / opts.rate) * 1000;
          const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          if (elapsedMs < targetMs) await delay(targetMs - elapsedMs);
        }
      }
      if (req.writable && !closed) {
        req.write("]");
        req.end();
      }
    })();
  });
}

// ---------------------------------------------------------------- parent
async function control(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    });
  });
}

async function peakRss(port: number): Promise<number> {
  return (JSON.parse(await control(port, "/peak")) as { peakRssMB: number }).peakRssMB;
}

function row(label: string, r: UploadResult): string {
  const tput = (r.mbSent / (r.ms / 1000)).toFixed(0);
  return `${label.padEnd(22)} ${r.ms.toFixed(0).padStart(6)}ms  verdict=${r.verdict.padEnd(8)} sent=${r.mbSent.toFixed(1).padStart(6)}MB  eff=${tput.padStart(4)} MB/s`;
}

async function spawnServer(): Promise<{ port: number; kill: () => void }> {
  const self = fileURLToPath(import.meta.url);
  const child = spawn("node", ["--import", "tsx", self, "--server"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  const port = Number(/PORT=(\d+)/.exec(line.toString())?.[1]);
  return { port, kill: () => child.kill() };
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const { port, kill } = await spawnServer();
  try {
    return await fn(port);
  } finally {
    kill();
  }
}

async function parent(): Promise<void> {
  const sizeMB = Number(process.env.EP_SIZE_MB ?? 64);
  const conc = Number(process.env.EP_CONC ?? 16);
  const concSizeMB = Number(process.env.EP_CONC_SIZE_MB ?? 16);
  const size = sizeMB * MB;

  // crossover + early-reject share one server (RSS is not the metric here).
  await withServer(async (port) => {
    console.log(`\npayload ${sizeMB} MB (array of typed objects)\n`);
    console.log(`=== crossover: time-to-verdict for a VALID ${sizeMB} MB body, by upload rate ===`);
    for (const rate of [10, 30, 100, null]) {
      const label = rate === null ? "blast (unthrottled)" : `${rate} MB/s`;
      const bytesRate = rate === null ? null : rate * MB;
      const b = await upload(port, {
        path: "/buffer",
        sizeBytes: size,
        rate: bytesRate,
        invalid: false,
      });
      const s = await upload(port, {
        path: "/stream",
        sizeBytes: size,
        rate: bytesRate,
        invalid: false,
      });
      console.log(row(`  buffer @ ${label}`, b));
      console.log(row(`  stream @ ${label}`, s));
    }

    console.log(`\n=== early-reject: INVALID body (bad 2nd element), 30 MB/s, ${sizeMB} MB ===`);
    console.log(
      row(
        "  buffer (invalid)",
        await upload(port, { path: "/buffer", sizeBytes: size, rate: 30 * MB, invalid: true }),
      ),
    );
    console.log(
      row(
        "  stream (invalid)",
        await upload(port, { path: "/stream", sizeBytes: size, rate: 30 * MB, invalid: true }),
      ),
    );
  });

  // Concurrency RSS: a FRESH server per endpoint, since RSS is a
  // high-water mark that does not shrink after a prior endpoint's load.
  console.log(`\n=== concurrency: ${conc} x ${concSizeMB} MB valid uploads, peak server RSS ===`);
  for (const path of ["/buffer", "/stream"]) {
    const peak = await withServer(async (port) => {
      await control(port, "/reset");
      await Promise.all(
        Array.from({ length: conc }, () =>
          upload(port, { path, sizeBytes: concSizeMB * MB, rate: 50 * MB, invalid: false }),
        ),
      );
      return peakRss(port);
    });
    console.log(`  ${path.padEnd(8)} peak RSS ${peak.toFixed(0)} MB`);
  }
}

if (process.argv.includes("--server")) runServer();
else await parent();
