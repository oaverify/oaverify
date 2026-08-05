/**
 * Custom formats: register a string format (here, E.164 phone numbers)
 * and enforce it alongside the built-ins. One registry, whatever JSON
 * type a format constrains: a bare function is a string format, and a
 * numeric one says its type out loud. Merged onto the
 * `@oaverify/core/formats` defaults when you build the validator.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/custom-formats.ts
 */

import { fileURLToPath } from "node:url";
import { formatText } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/contacts.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

const e164 = (s: string): boolean => /^\+[1-9]\d{6,14}$/.test(s);

const v = createValidator(document, {
  formats: {
    // A bare function is a string format.
    "e164-phone": e164,
    // Constraining numbers says the type out loud. Nothing in this
    // spec uses it; it is here because it is the other half of the
    // shape.
    "basis-points": {
      type: "number",
      validate: (n) => Number.isInteger(n) && n >= 0 && n <= 10000,
    },
    // `false` registers the name and asserts nothing. This is how you
    // turn a built-in off, per format:
    //   int64: false,
  },
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
