/**
 * Custom formats: register a string format (here, E.164 phone numbers)
 * and enforce it alongside the built-ins. A format is any
 * `(value: string) => boolean`, merged onto the `oav/formats` defaults
 * when you build the validator.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/custom-formats.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/oav/src/yaml.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/contacts.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

const e164 = (s: string): boolean => /^\+[1-9]\d{6,14}$/.test(s);

const v = createValidator(document, {
  formats: { "e164-phone": e164 },
});

const ok = v.validateRequest({
  method: "POST",
  path: "/contacts",
  contentType: "application/json",
  body: { phone: "+14155550123" },
});
console.log("+14155550123 ->", ok.valid ? "ok" : "FAIL");

const bad = v.validateRequest({
  method: "POST",
  path: "/contacts",
  contentType: "application/json",
  body: { phone: "415-555-0123" }, // not E.164
});
if (!bad.valid) {
  console.log("\n415-555-0123:\n" + formatText(bad.errors));
}
