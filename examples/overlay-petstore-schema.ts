/**
 * Overlay: extend a component schema without touching the upstream spec.
 *
 * Scenario: an upstream petstore defines `Pet` as `{ name, tag }`. Your
 * deployment additionally requires `vaccinated: boolean` on every pet
 * accepted by POST /pets. Rather than forking the spec and keeping the
 * fork in sync, you overlay an extension onto the `Pet` component.
 *
 * The overlay merges the extension into the original schema via
 * `allOf`: the original shape still applies, and the extension adds to it.
 * Consumers that only know about the upstream `Pet` continue to see a
 * compatible shape; the extra constraint is enforced on top.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/overlay-petstore-schema.ts
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

// Deployment-specific extension: require `vaccinated: boolean`. Because
// `extendSchemas` merges via allOf, the upstream Pet shape is preserved
// (still requires `name`, still permits optional `tag`) and the new
// constraint adds to it.
const overlay: SpecOverlay = {
  extendSchemas: {
    Pet: {
      type: "object",
      required: ["vaccinated"],
      properties: { vaccinated: { type: "boolean" } },
    },
  },
};

const merged = applyOverlays(base, [overlay]);
const v = createValidator(merged);

// Without vaccinated: rejected by the overlaid spec.
const missing = v.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido" },
});
console.log("POST /pets without `vaccinated`:");
if (!missing.valid) console.log(formatText(missing.errors));

// With vaccinated: clean.
const ok = v.validateRequest({
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { name: "Fido", vaccinated: true },
});
console.log("\nPOST /pets with `vaccinated: true` ->", ok.valid ? "ok" : "FAIL");
