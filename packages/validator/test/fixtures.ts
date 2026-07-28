import type {
  HttpRequest,
  HttpResponse,
  OpenAPIDocument,
  ValidationError,
} from "@oaverify/internal-core";
import { collectLeaves } from "@oaverify/internal-core";
import {
  createValidator as createValidatorRaw,
  type TreeValidator,
  type ValidatorOptions,
} from "../src/index.js";

/**
 * Shared test helpers for the validator test suite. Extracted so the
 * request / response / custom-keywords / lazy-compile test files can
 * share a minimal vocabulary without each one inlining its own spec.
 */

/**
 * Test shim: a tree-mode, uncapped validator whose
 * `validateRequest` / `validateResponse` return `ValidationError | null`.
 * The logic-focused suites assert error codes, paths, and counts, all of
 * which are output-shape-independent, so this shim lets them keep doing
 * that without threading the v3 result object through every case. The
 * `output` knob, the flat default, and reshaping/budget behavior are
 * covered directly by `output-modes.test.ts`.
 */
export type TreeShim = Omit<TreeValidator, "validateRequest" | "validateResponse"> & {
  validateRequest(req: HttpRequest): ValidationError | null;
  validateResponse(req: HttpRequest, res: HttpResponse): ValidationError | null;
};

export function createValidator(spec: OpenAPIDocument, options: ValidatorOptions = {}): TreeShim {
  // Annotated: `createValidator` is overloaded, and spreading `options`
  // widens the argument enough that resolution falls back to the union
  // of all three output shapes, making `r.error` below a type error.
  const v: TreeValidator = createValidatorRaw(spec, {
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
    ...options,
  } as ValidatorOptions & { output: "tree" });
  return Object.assign(Object.create(null) as object, v, {
    validateRequest: (req: HttpRequest): ValidationError | null => {
      const r = v.validateRequest(req);
      return r.valid ? null : r.error;
    },
    validateResponse: (req: HttpRequest, res: HttpResponse): ValidationError | null => {
      const r = v.validateResponse(req, res);
      return r.valid ? null : r.error;
    },
  }) as TreeShim;
}

export function leafCodes(err: ValidationError | null | undefined): string[] {
  return err === null || err === undefined ? [] : collectLeaves(err).map((l) => l.code);
}

export function leafAt(
  err: ValidationError | null | undefined,
  pathStr: string,
): ValidationError | undefined {
  if (err === null || err === undefined) return undefined;
  return collectLeaves(err).find((l) => l.path.join(".") === pathStr);
}

/**
 * Minimal 3.1 Pet Store covering GET /pets, POST /pets, and
 * GET /pets/{petId}, enough surface area for tests that need a
 * realistic multi-operation spec without inlining a large literal.
 */
export function petSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    paths: {
      "/pets": {
        get: {
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1 },
            },
            { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "array", items: { type: "object" } } },
              },
            },
          },
        },
        post: {
          parameters: [
            { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
                },
              },
            },
          },
          responses: {
            "201": { description: "created" },
            "4XX": { description: "client err" },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

/**
 * Narrow a validation result to its failure branch.
 *
 * `expect(r.valid).toBe(false)` does not narrow a discriminated union,
 * so `r.errors` is a type error at every assertion site. The two
 * workarounds both have costs: `r.errors?.[0]` types fine but an
 * assertion against `undefined` can pass for the wrong reason, and
 * `if (r.valid) return` silently skips the rest of the test when the
 * result is unexpectedly valid. This throws instead.
 */
export function failure<T extends { valid: boolean }>(result: T): Extract<T, { valid: false }> {
  if (result.valid) {
    throw new Error("expected an invalid result, got a valid one");
  }
  return result as Extract<T, { valid: false }>;
}

/**
 * Narrow past a `$ref` union. OpenAPI containers type most members as
 * `ReferenceObject | T`; these specs are already resolved, so the ref
 * branch is unreachable -- but say so explicitly rather than casting,
 * so a genuinely unresolved ref fails loudly here.
 */
export function notRef<T extends object>(node: T): Exclude<T, { $ref: string }> {
  if ("$ref" in node) {
    throw new Error(`expected a resolved object, got $ref ${String(node.$ref)}`);
  }
  return node as Exclude<T, { $ref: string }>;
}
