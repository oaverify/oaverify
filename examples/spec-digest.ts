/**
 * Example: derive middleware config from an OpenAPI spec at startup.
 *
 * `digestOperation` walks an {@link OperationObject} once and returns
 * a small, flat object the calling code can match against its
 * framework's configuration (multer limits, body-parser content
 * types, auth-middleware expectations). One source of truth: the
 * spec; the middleware reads it instead of hardcoding duplicates.
 *
 * This file is documentation, not library API. Copy it into your
 * project and adapt the interpretation choices (what `maxLength` means
 * on a binary field, which `x-*` extensions to recognize, how nested
 * `properties` roll up) to match your domain. Keeping those decisions
 * in application code, not in oav, avoids baking one team's conventions
 * into every team's startup.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/spec-digest.ts
 */

import { fileURLToPath } from "node:url";
import type {
  MediaTypeObject,
  OperationObject,
  ParameterObject,
  SchemaObject,
  SecurityRequirementObject,
} from "../packages/core/src/index.ts";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

/**
 * Flat summary of the declaration-time facts a handler wiring step
 * usually needs. Extend with whatever your middleware cares about.
 */
export interface OperationDigest {
  operationId?: string;
  deprecated: boolean;
  /** Media types declared on the operation's request body. */
  requestContentTypes: string[];
  /** Per content-type, the spec-declared body size ceiling (if any). */
  bodyLimits: Record<string, { maxBytes?: number }>;
  /** Required header parameters (by spec name). */
  requiredHeaders: string[];
  /**
   * Security requirements: outer array is the OR-set of alternatives,
   * inner array is the AND-set of scheme names within one alternative.
   */
  security: string[][];
}

function getMediaTypes(op: OperationObject): Record<string, MediaTypeObject> {
  const body = op.requestBody;
  if (body === undefined || "$ref" in body) return {};
  return body.content;
}

export function digestOperation(op: OperationObject): OperationDigest {
  return {
    operationId: op.operationId,
    deprecated: op.deprecated === true,
    requestContentTypes: Object.keys(getMediaTypes(op)),
    bodyLimits: bodyLimitsByMediaType(op),
    requiredHeaders: (op.parameters ?? [])
      .filter((p): p is ParameterObject => "name" in p && p.in === "header" && p.required === true)
      .map((p) => p.name),
    security: (op.security ?? []).map((req: SecurityRequirementObject) => Object.keys(req)),
  };
}

/**
 * Walk every media-type entry on the request body and pull out the
 * smallest declared `maxLength` on a `format: binary` / `format: byte`
 * field. Returns a map so consumers that send different content types
 * to different middleware (multer for `multipart/form-data`,
 * `express.raw()` for `application/octet-stream`) can look up each
 * one independently.
 */
function bodyLimitsByMediaType(op: OperationObject): Record<string, { maxBytes?: number }> {
  const out: Record<string, { maxBytes?: number }> = {};
  for (const [mediaType, mto] of Object.entries(getMediaTypes(op))) {
    out[mediaType] = { maxBytes: declaredMaxBytes(mto.schema) };
  }
  return out;
}

/**
 * Recursive scan of a schema for a `maxLength` on a binary/byte
 * field. `maxLength` on a `format: binary` field is the OpenAPI
 * convention for byte-count; on a plain string it means code
 * points. This recipe treats only the binary case as a byte ceiling.
 * Your domain may want an `x-max-bytes` extension, a custom annotation
 * keyword, or something else entirely.
 */
function declaredMaxBytes(schema: SchemaObject | boolean | undefined): number | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (
    (schema.format === "binary" || schema.format === "byte") &&
    typeof schema.maxLength === "number"
  ) {
    return schema.maxLength;
  }
  for (const child of Object.values(schema.properties ?? {})) {
    const found = declaredMaxBytes(child as SchemaObject);
    if (found !== undefined) return found;
  }
  if (schema.items !== undefined) {
    const found = declaredMaxBytes(schema.items as SchemaObject);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---- Demo: load spec, digest, print ------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const specPath = fileURLToPath(new URL("./specs/uploads.yaml", import.meta.url));
  const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

  const validator = createValidator(document);
  const info = validator.getOperation({ method: "POST", path: "/uploads" });
  if (info === null) throw new Error("no matching operation");

  const digest = digestOperation(info.operation);
  console.log(JSON.stringify(digest, null, 2));
}
