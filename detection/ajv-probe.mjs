/**
 * Ajv's side of the comparison.
 *
 * Ajv does not lint OpenAPI documents, so asking "what does Ajv say
 * about this spec" has no direct answer. The comparable operation is
 * the one oaverify performs at the same moment: compile every schema
 * the document carries, with the strictness options that exist for
 * catching authoring mistakes.
 *
 * Emits the same normalized finding shape run.ts uses for the CLIs.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";

const specPath = process.argv[2];
const findings = [];

/** Collect every schema position an OpenAPI document can hold. */
function collectSchemas(doc) {
  const out = [];
  const components = doc?.components?.schemas;
  if (components && typeof components === "object") {
    for (const [name, schema] of Object.entries(components)) {
      out.push([`components.schemas.${name}`, schema]);
    }
  }
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object") continue;
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        for (const [type, media] of Object.entries(response?.content ?? {})) {
          if (media?.schema !== undefined) {
            out.push([`paths.${path}.${method}.responses.${status}.${type}`, media.schema]);
          }
        }
      }
      for (const [type, media] of Object.entries(op.requestBody?.content ?? {})) {
        if (media?.schema !== undefined) {
          out.push([`paths.${path}.${method}.requestBody.${type}`, media.schema]);
        }
      }
    }
  }
  return out;
}

try {
  const doc = parseYaml(readFileSync(specPath, "utf8"));

  for (const [where, schema] of collectSchemas(doc)) {
    // A fresh instance per schema: one compile throwing must not stop
    // the rest, and strict mode is per-instance state.
    const ajv = new Ajv({
      strict: true,
      strictRequired: true,
      strictTypes: true,
      strictTuples: true,
      allErrors: true,
      validateFormats: false,
      logger: false,
    });

    // Register the document's components so `#/components/schemas/X`
    // refs resolve the way they would in a real OpenAPI toolchain.
    try {
      ajv.addSchema({ $id: "spec", ...doc }, "spec");
    } catch {
      // A malformed components block is itself what we are measuring;
      // let the per-schema compile below report it.
    }

    try {
      ajv.compile(schema);
    } catch (e) {
      findings.push({
        rule: "ajv/compile",
        message: e.message,
        location: where,
        severity: "error",
      });
    }
  }

  process.stdout.write(JSON.stringify({ findings }));
} catch (e) {
  process.stdout.write(JSON.stringify({ findings: [], fatal: String(e.message) }));
}
