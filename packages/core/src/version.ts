/**
 * OpenAPI version detection and dialect identity.
 *
 * The OpenAPI Specification has two major variants that affect
 * validator behavior:
 *
 * - **3.0.x**: uses a draft-Wright-00-based JSON Schema dialect with
 *   its own flavours of `type` (single string only), `nullable: true`,
 *   boolean `exclusiveMaximum`/`Minimum`, no sibling keys for `$ref`,
 *   and no `const` / `if`/`then`/`else` / `contains` /
 *   `unevaluatedProperties` / `patternProperties`.
 * - **3.1.x** and **3.2.x**: use JSON Schema 2020-12. 3.2 is largely
 *   additive over 3.1 (new methods like `QUERY`, tightened rules) and
 *   shares 3.1's dialect.
 *
 * This module is intentionally tiny: it classifies a spec into one of
 * these buckets. Consumers (notably `@oaverify/internal-validator`) use the bucket
 * to pick the right vocabulary set at validator construction.
 *
 * @packageDocumentation
 */

/**
 * The three supported OpenAPI major.minor lines.
 *
 * @public
 */
export type OpenAPIVersion = "3.0" | "3.1" | "3.2";

/**
 * Inspect an OpenAPI document's `openapi` field and bucket it by
 * major.minor. Returns `undefined` when the field is missing, malformed,
 * or targets a line we don't recognize.
 *
 * @param spec - Anything shaped like an OpenAPI document. Safe on
 *               arbitrary input; returns `undefined` without throwing.
 * @returns The matched version bucket, or `undefined`.
 *
 * @example
 * ```ts
 * detectOpenAPIVersion({ openapi: "3.1.0", info: { ... } }); // "3.1"
 * detectOpenAPIVersion({ openapi: "3.2.0-rc1" });            // "3.2"
 * detectOpenAPIVersion({ swagger: "2.0" });                  // undefined
 * ```
 *
 * @public
 */
export function detectOpenAPIVersion(spec: unknown): OpenAPIVersion | undefined {
  if (spec === null || typeof spec !== "object") return undefined;
  const openapi = (spec as { openapi?: unknown }).openapi;
  if (typeof openapi !== "string") return undefined;
  const match = /^(\d+)\.(\d+)/.exec(openapi);
  if (match === null) return undefined;
  const major = match[1];
  const minor = match[2];
  if (major !== "3") return undefined;
  if (minor === "0") return "3.0";
  if (minor === "1") return "3.1";
  if (minor === "2") return "3.2";
  return undefined;
}

/**
 * Why did {@link detectOpenAPIVersion} return `undefined`? Distinguishes
 * category errors (missing or non-string `openapi` field, wrong major)
 * from a valid-shaped 3.x spec with an unknown minor (forward-compat).
 *
 * @public
 */
export type UnknownVersionReason =
  | { kind: "missing-openapi"; message: string }
  | { kind: "wrong-major"; message: string }
  | { kind: "ok-unknown-minor"; raw: string };

/**
 * Classify a spec's `openapi` field when {@link detectOpenAPIVersion}
 * returned `undefined`. Shared by `createValidator` (runtime) and
 * `compile-spec` (AOT) so both emit the same warning / error messages.
 *
 * @public
 */
export function classifyUnknownVersion(rawOpenapi: unknown): UnknownVersionReason {
  if (typeof rawOpenapi !== "string") {
    return {
      kind: "missing-openapi",
      message:
        "expected an OpenAPI 3.x document; the `openapi` field must be a string " +
        `like "3.1.0" (got ${typeof rawOpenapi}). ` +
        'Swagger 2.0 documents use `swagger: "2.0"` instead and need to be converted ' +
        "first (e.g. `npx swagger2openapi input.json -o output.json`). " +
        "AsyncAPI / OpenRPC / other formats are different domains and oaverify doesn't handle them.",
    };
  }
  const match = /^(\d+)\.(\d+)/.exec(rawOpenapi);
  if (match === null) {
    return {
      kind: "missing-openapi",
      message: `the \`openapi\` field \`"${rawOpenapi}"\` doesn't look like a semver version`,
    };
  }
  const major = match[1]!;
  if (major !== "3") {
    const hint =
      major === "2"
        ? " Convert to 3.x first, e.g. `npx swagger2openapi input.json -o output.json`."
        : "";
    return {
      kind: "wrong-major",
      message: `oaverify supports OpenAPI 3.x; got openapi: "${rawOpenapi}".${hint}`,
    };
  }
  return { kind: "ok-unknown-minor", raw: rawOpenapi };
}
