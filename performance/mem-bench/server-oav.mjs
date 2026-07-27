// oav memory test server — Express 4 + oav adapter.
// Run with: node --expose-gc server.mjs
//
// Instruments /__memory (and /__memory?gc=1 to force a GC first).

import express from "express";
import {
  allowHeaderFor,
  createValidator,
  createYamlFileReader,
  httpStatusFor,
  toProblemDetails,
} from "oaverify";
import { loadSpec } from "oaverify/spec";
import { fileURLToPath } from "node:url";

const specPath = fileURLToPath(new URL("./openapi.yaml", import.meta.url));
const { document } = await loadSpec({
  reader: createYamlFileReader(),
  entry: specPath,
});
const validator = createValidator(document);

const app = express();
app.use(express.json({ limit: "1mb" }));

// Memory probe (before validation middleware so it's always reachable).
app.get("/__memory", (req, res) => {
  if (req.query.gc === "1" && globalThis.gc) {
    globalThis.gc();
    globalThis.gc(); // twice: first pass frees; second compacts
  }
  const m = process.memoryUsage();
  res.json({
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    uptime: process.uptime(),
  });
});

// Validator adapter.
app.use(async (req, res, next) => {
  if (req.path === "/__memory") return next();
  const result = validator.validateRequest({
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    contentType: req.get("content-type") ?? undefined,
    body: req.body,
  });
  if (result.valid) return next();
  const errors = result.errors;
  const allow = allowHeaderFor(errors);
  if (allow !== undefined) res.setHeader("Allow", allow);
  res
    .status(httpStatusFor(errors))
    .type("application/problem+json")
    .json(toProblemDetails(errors, { instance: req.originalUrl }));
});

// Business handlers.
const ok201 = { id: "00000000-0000-0000-0000-000000000000" };
const ok201tx = { id: "00000000-0000-0000-0000-000000000000", status: "pending" };
const ok201inv = {
  id: "00000000-0000-0000-0000-000000000000",
  total: { value: 1, currency: "USD" },
};
app.post("/transactions", (_req, res) => res.status(201).json(ok201));
app.get("/transactions", (_req, res) => res.json({ items: [] }));
app.post("/transfers", (_req, res) => res.status(201).json(ok201tx));
app.post("/accounts", (_req, res) => res.status(201).json(ok201));
app.post("/invoices", (_req, res) => res.status(201).json(ok201inv));
app.post("/subscriptions", (_req, res) => res.status(201).json(ok201));

const PORT = Number(process.env.PORT ?? 3800);
app.listen(PORT, () => console.log(`oav listening on ${PORT}`));
