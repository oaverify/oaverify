/**
 * Bridge an OpenAPI document to a streaming body validator.
 *
 * The stream validator validates one *resolved* schema; routing and
 * body-schema lookup stay the caller's job (the same split the framework
 * adapters keep). `streamValidatorForOperation` does the mechanical part:
 * given a resolved document and an operation locator, it pulls the
 * request-body schema, carries the document's ref container so an internal
 * `$ref` (`#/components/schemas/Pet`) resolves, and reads the OpenAPI
 * version off `doc.openapi`. It mirrors `@oaverify/core`'s
 * `getOperation` locator (`{ method, path }`).
 *
 * `path` is the literal path-template key, looked up exactly (no
 * template matching). Resolve a real request path to its template
 * upstream, then pass the template here.
 *
 * The footgun this removes: by hand you must spread the document's
 * `components` onto the body schema, or construction throws
 * `unresolvable $ref` before any byte streams. The helper carries it for
 * you.
 *
 * Translation to the published packages: `resolveSpec` from
 * `@oaverify/core/spec`, `streamValidatorForOperation` from
 * `@oaverify/stream`. See ./README.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/stream-from-spec.ts
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { formatSummary } from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { resolveSpec } from "../packages/spec/src/index.ts";
import {
  streamValidatorForOperation,
  toValidationError,
  ValidationFailedError,
} from "../packages/stream-validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/petstore.yaml", import.meta.url));
const { document } = await resolveSpec({ reader: createYamlFileReader(), entry: specPath });

// Drain the echoed bytes; a real caller would forward them to storage.
const drain = async (src: AsyncIterable<Buffer>): Promise<void> => {
  for await (const _ of src) {
    /* discard */
  }
};

async function streamPet(label: string, pet: unknown): Promise<void> {
  // Your router selects the operation; here we name POST /pets directly.
  // The helper pulls its body schema (`$ref: #/components/schemas/Pet`),
  // carries `components`, and detects the 3.1 version off the document.
  const validator = streamValidatorForOperation(document, { method: "post", path: "/pets" });
  try {
    await pipeline(Readable.from(JSON.stringify(pet)), validator, drain);
    console.log(`${label} -> ok`);
  } catch (err) {
    if (err instanceof ValidationFailedError) {
      // Bridge to @oaverify/internal-core's error model and reuse its one-line summary.
      const summary = formatSummary(toValidationError(err.verdict.violations));
      console.log(`${label} -> rejected: ${summary}`);
    } else {
      throw err;
    }
  }
}

await streamPet("valid Pet        ", { name: "Fido", tag: "dog" });
await streamPet("Pet missing name ", { tag: "dog" });
