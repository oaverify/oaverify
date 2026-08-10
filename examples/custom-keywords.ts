/**
 * Custom keywords: register a schema keyword whose behavior depends on
 * runtime state the spec can't capture. Here, an "active tenant" check
 * backed by an in-memory cache. Good for Luhn checks, tick-size
 * multiples, currency-whitelists, etc.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/custom-keywords.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";
import type { CustomKeywordValidator } from "../packages/validator/src/index.ts";

const tenantCache = new Set(["t_acme", "t_globex"]);

const activeTenant: CustomKeywordValidator = (data) => {
  if (typeof data !== "string") return true;
  if (tenantCache.has(data)) return true;
  return { message: `tenant "${data}" is not active`, params: { tenantId: data } };
};

const specPath = fileURLToPath(new URL("./specs/widgets.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

const v = createValidator(document, {
  keywords: { activeTenant },
});

const ok = v.validateRequest({
  method: "POST",
  path: "/widgets",
  contentType: "application/json",
  body: { tenantId: "t_acme", name: "Widget A" },
});
console.log("t_acme (active) ->", ok.valid ? "ok" : "FAIL");

const bad = v.validateRequest({
  method: "POST",
  path: "/widgets",
  contentType: "application/json",
  body: { tenantId: "t_unknown", name: "Widget B" },
});
if (!bad.valid) {
  console.log("\nt_unknown:\n" + formatText(bad.errors));
}
