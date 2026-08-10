/**
 * Overlays: merge environment-specific patches into a base OpenAPI
 * document before constructing the validator. Common uses include adding
 * a gateway-injected header to every operation, extending a schema with
 * extra properties, or replacing a response shape in test environments.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/overlay.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { applyOverlays, loadSpec, type SpecOverlay } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/petstore.yaml", import.meta.url));
const { document: base } = await loadSpec({
  reader: createYamlFileReader(),
  entry: specPath,
});

// Gateway adds `X-Request-Id` to every GET in prod. Rather than edit the
// base spec, overlay the requirement in at load time.
const overlay: SpecOverlay = {
  overrides: {
    "/pets": {
      operations: {
        get: {
          upsertParameters: [
            { name: "X-Request-Id", in: "header", required: true, schema: { type: "string" } },
          ],
        },
      },
    },
  },
};

const merged = applyOverlays(base, [overlay]);
const v = createValidator(merged);

// Without the header: should fail.
const missing = v.validateRequest({ method: "GET", path: "/pets" });
console.log("without X-Request-Id:");
if (!missing.valid) console.log(formatText(missing.errors));

// With the header: clean.
const ok = v.validateRequest({
  method: "GET",
  path: "/pets",
  headers: { "x-request-id": "abc-123" },
});
console.log("\nwith X-Request-Id ->", ok.valid ? "ok" : "FAIL");
