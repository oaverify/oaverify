/**
 * Overlay: add a gateway-required header to an existing endpoint
 * without touching the upstream spec.
 *
 * Scenario: an upstream petstore accepts POST /pets with only a JSON
 * body, but your deployment sits behind a gateway that requires an
 * `X-Tenant` header on every write. Rather than forking the spec,
 * you overlay the requirement onto the operation at load time.
 *
 * `overrides` reaches into an existing path's operations and merges
 * per-operation fragments. `upsertParameters` appends new parameters
 * or replaces (by `name` + `in`) concrete existing ones. The upstream
 * body schema is untouched; only the parameter list changes.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/overlay-petstore-endpoint.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { applyOverlays, loadSpec, type SpecOverlay } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/petstore.yaml", import.meta.url));
const { document: base } = await loadSpec({
  reader: createYamlFileReader(),
  entry: specPath,
});

// Gateway requires `X-Tenant` on POST /pets.
const overlay: SpecOverlay = {
  overrides: {
    "/pets": {
      operations: {
        post: {
          upsertParameters: [
            { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
          ],
        },
      },
    },
  },
};

const merged = applyOverlays(base, [overlay]);
const v = createValidator(merged);

// Without the header: rejected by the overlaid spec.
const missing = v.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});
console.log("POST /pets without X-Tenant:");
if (!missing.valid) console.log(formatText(missing.errors));

// With the header: clean.
const ok = v.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  headers: { "x-tenant": "acme" },
  body: { name: "Fido" },
});
console.log("\nPOST /pets with X-Tenant ->", ok.valid ? "ok" : "FAIL");
