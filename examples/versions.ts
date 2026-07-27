/**
 * Multi-version support: the same conceptual "create a pet" operation,
 * declared three different ways, one per OpenAPI version. The validator
 * reads `openapi` once at construction and picks the right dialect, so
 * there's no per-request branching.
 *
 * - 3.0.x: `nullable: true`, boolean `exclusiveMaximum`
 * - 3.1.x: `type: ["string", "null"]`, numeric `exclusiveMaximum`
 * - 3.2.x: like 3.1 but can use the new `QUERY` HTTP method
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/versions.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const reader = createYamlFileReader();
const specUrl = (name: string): string =>
  fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

// --- OpenAPI 3.0.x ---------------------------------------------------------
const { document: spec30 } = await loadSpec({ reader, entry: specUrl("pets-3.0.yaml") });
const v30 = createValidator(spec30);
console.log(
  "3.0.3  tag=null        ->",
  v30.validateRequest({
    method: "POST",
    path: "/pets",
    contentType: "application/json",
    body: { name: "Fido", tag: null },
  }).valid
    ? "ok"
    : "FAIL",
);
console.log(
  "3.0.3  priority=10     ->",
  (() => {
    const e = v30.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: "Fido", priority: 10 }, // exclusiveMaximum: true means must be < 10
    });
    return e.valid ? "ok (should fail!)" : "rejected (as expected)";
  })(),
);

// --- OpenAPI 3.1.x ---------------------------------------------------------
const { document: spec31 } = await loadSpec({ reader, entry: specUrl("pets-3.1.yaml") });
const v31 = createValidator(spec31);
console.log(
  "3.1.0  tag=null        ->",
  v31.validateRequest({
    method: "POST",
    path: "/pets",
    contentType: "application/json",
    body: { name: "Fido", tag: null },
  }).valid
    ? "ok"
    : "FAIL",
);

// --- OpenAPI 3.2.x ---------------------------------------------------------
const { document: spec32 } = await loadSpec({ reader, entry: specUrl("pets-3.2.yaml") });
const v32 = createValidator(spec32);
const r = v32.validateRequest({
  method: "QUERY",
  path: "/pets/search",
  contentType: "application/json",
  body: { filter: "cats" },
});
console.log("3.2.0  QUERY /search  ->", r.valid ? "ok" : "FAIL:\n" + formatText(r.errors));
