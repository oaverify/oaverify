// eov memory test server — Express 4 + express-openapi-validator (ajv under the hood).
// Run with: node --expose-gc server.mjs
//
// Instruments /__memory (and /__memory?gc=1 to force a GC first).

import express from "express";
import OpenApiValidator from "express-openapi-validator";
import { fileURLToPath } from "node:url";

const specPath = fileURLToPath(new URL("./openapi.yaml", import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

// Memory probe BEFORE the validator middleware chain so eov doesn't
// intercept it (eov would 404 this path since it isn't in the spec).
app.get("/__memory", (req, res) => {
  if (req.query.gc === "1" && globalThis.gc) {
    globalThis.gc();
    globalThis.gc();
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

app.use(
  OpenApiValidator.middleware({
    apiSpec: specPath,
    validateRequests: true,
    validateResponses: false,
  }),
);

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

// eov's default error shape.
app.use(
  /** @type {import("express").ErrorRequestHandler} */ (
    (err, _req, res, _next) => {
      res.status(err.status ?? 500).json({ message: err.message, errors: err.errors });
    }
  ),
);

const PORT = Number(process.env.PORT ?? 3810);
app.listen(PORT, () => console.log(`eov listening on ${PORT}`));
