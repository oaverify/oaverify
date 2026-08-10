/**
 * Cross-field validation via an object-level custom keyword.
 *
 * JSON Schema keywords see only their own data, so a field-level
 * check like "max >= min" can't reach sibling fields. The pattern:
 * declare a custom keyword on the OBJECT that names the cross-field
 * rule, register a validator that sees the whole object, and let
 * the validator reach siblings directly.
 *
 * This is the oaverify equivalent of Ajv's `$data` references
 * (`{ minimum: { $data: "1/min" } }`), which aren't part of standard
 * JSON Schema. Trade-off: the constraint sits on the parent object
 * in the schema rather than inside the constrained field's own
 * subschema.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/cross-field-validation.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";
import type { CustomKeywordValidator } from "../packages/validator/src/index.ts";

/**
 * `x-cross-field: { <field>: { atLeast: <other-field> } }`: the
 * named field must be `>=` the named other field. Walks the rules
 * map, reaches each named sibling directly on the object data.
 */
const crossField: CustomKeywordValidator = (data, schemaValue) => {
  if (typeof data !== "object" || data === null) return true;
  const obj = data as Record<string, unknown>;
  const rules = schemaValue as Record<string, { atLeast?: string }>;
  for (const [field, rule] of Object.entries(rules)) {
    if (rule.atLeast === undefined) continue;
    const a = obj[field];
    const b = obj[rule.atLeast];
    if (typeof a !== "number" || typeof b !== "number") continue;
    if (a < b) {
      return {
        message: `${field} (${a}) must be at least ${rule.atLeast} (${b})`,
        params: { field, atLeast: rule.atLeast, got: a, expected: b },
      };
    }
  }
  return true;
};

const specPath = fileURLToPath(new URL("./specs/ranges.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

const v = createValidator(document, {
  keywords: { "x-cross-field": crossField },
});

const ok = v.validateRequest({
  method: "POST",
  path: "/search",
  contentType: "application/json",
  body: { min: 3, max: 10 },
});
console.log("min=3 max=10  ->", ok.valid ? "ok" : "FAIL");

const bad = v.validateRequest({
  method: "POST",
  path: "/search",
  contentType: "application/json",
  body: { min: 10, max: 3 },
});
if (!bad.valid) {
  console.log("\nmin=10 max=3:\n" + formatText(bad.errors));
}
