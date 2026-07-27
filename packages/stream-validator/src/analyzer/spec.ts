/**
 * Per-operation streamability rollup over a resolved OpenAPI document. For
 * every operation it analyzes the request body and each response body and
 * returns a peak-buffer budget per body, so a deployer can see, spec-wide,
 * which operations stream and which buffer (and where).
 *
 * The document must already be resolved (external `$ref`s inlined, e.g. via
 * `resolveSpec`); this walk follows only local `#/components/...` refs. It is
 * engine-free (it calls {@link analyzeStreamability}, never the streaming
 * engine), so it does not pull the engine into a consumer that only wants
 * the analysis.
 *
 * @packageDocumentation
 */

import type {
  MediaTypeObject,
  OpenAPIDocument,
  OperationObject,
  RequestBodyObject,
  ResponseObject,
} from "@oaverify/internal-core";
import {
  carryComponents,
  HTTP_METHODS,
  resolveLocalRef,
  versionFromDoc,
} from "../openapi/body-schema.js";
import type { StreamValidatorOptions } from "../options.js";
import { analyzeStreamability, type StreamabilityReport } from "./analyze.js";

/**
 * Fields common to every {@link BodyBudget} variant.
 *
 * @public
 */
export interface BodyBudgetBase {
  /** Whether this is the request body or a response body. */
  role: "request" | "response";
  /** Response status key (`"200"`, `"default"`); absent for the request. */
  status?: string;
  /** The body media type (`"application/json"`, ...). */
  mediaType: string;
}

/**
 * The streamability budget for one request or response body of an operation.
 * Exactly one of `report` / `error` is present (an exclusive union, so a
 * consumer that narrows on `error` reads `report` without a cast): `error`
 * holds the message when the body's schema cannot be classified (an
 * unstreamable keyword, an unknown keyword, or an unresolvable `$ref`), the
 * same failure `createStreamValidator` would raise; otherwise `report` holds
 * the peak-buffer budget.
 *
 * @public
 */
export type BodyBudget =
  | (BodyBudgetBase & { report: StreamabilityReport; error?: never })
  | (BodyBudgetBase & { error: string; report?: never });

/**
 * The budget for one operation: every request/response body that carries a
 * schema, in document order (request first).
 *
 * @public
 */
export interface OperationBudget {
  /** HTTP method, upper-cased (`"POST"`). */
  method: string;
  /** Path-template key as declared (`"/pets/{id}"`). */
  path: string;
  /** Per-body budgets; empty when the operation declares no body schema. */
  bodies: BodyBudget[];
}

/**
 * A spec-wide streamability rollup. See {@link analyzeSpec}.
 *
 * @public
 */
export interface SpecBudget {
  /** One entry per operation that carries at least one body schema. */
  operations: OperationBudget[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Analyze one media-type schema, capturing a classification failure as a
// per-body error so one bad body does not abort the whole sweep.
function budgetForBody(
  doc: OpenAPIDocument,
  content: Record<string, MediaTypeObject> | undefined,
  base: Omit<BodyBudgetBase, "mediaType">,
  options: StreamValidatorOptions,
): BodyBudget[] {
  if (content === undefined) return [];
  const out: BodyBudget[] = [];
  for (const [mediaType, mto] of Object.entries(content)) {
    const schema = mto.schema;
    if (schema === undefined) continue; // a media type with no schema is unconstrained
    try {
      const report = analyzeStreamability(carryComponents(doc, schema), options);
      out.push({ ...base, mediaType, report });
    } catch (e) {
      out.push({ ...base, mediaType, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function bodiesForOperation(
  doc: OpenAPIDocument,
  op: OperationObject,
  where: string,
  options: StreamValidatorOptions,
): BodyBudget[] {
  const bodies: BodyBudget[] = [];

  if (op.requestBody !== undefined) {
    try {
      const rb = resolveLocalRef<RequestBodyObject>(doc, op.requestBody, "requestBody", where);
      bodies.push(...budgetForBody(doc, rb.content, { role: "request" }, options));
    } catch (e) {
      bodies.push({
        role: "request",
        mediaType: "*",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  for (const [status, responseOrRef] of Object.entries(op.responses ?? {})) {
    try {
      const resp = resolveLocalRef<ResponseObject>(
        doc,
        responseOrRef,
        "response",
        `${where} -> ${status}`,
      );
      bodies.push(...budgetForBody(doc, resp.content, { role: "response", status }, options));
    } catch (e) {
      bodies.push({
        role: "response",
        status,
        mediaType: "*",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return bodies;
}

/**
 * Roll up a streamability budget for every operation in a resolved OpenAPI
 * document. The OpenAPI version is read off `doc.openapi` (override with
 * `options.openApiVersion`) and applied to every body; other options
 * (`maxBufferedBytes`, `dialect`, ...) thread through to
 * {@link analyzeStreamability}.
 *
 * Operations with no body schema are omitted. A body whose schema cannot be
 * classified is reported with `error` set rather than throwing, so a sweep
 * over real specs surveys the whole document.
 *
 * @public
 */
export function analyzeSpec(
  doc: OpenAPIDocument,
  options: StreamValidatorOptions = {},
): SpecBudget {
  const openApiVersion = options.openApiVersion ?? versionFromDoc(doc.openapi);
  const merged: StreamValidatorOptions =
    openApiVersion === undefined ? options : { ...options, openApiVersion };

  const operations: OperationBudget[] = [];
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isRecord(op)) continue;
      const where = `${method.toUpperCase()} "${path}"`;
      const bodies = bodiesForOperation(doc, op as OperationObject, where, merged);
      if (bodies.length > 0) operations.push({ method: method.toUpperCase(), path, bodies });
    }
  }
  return { operations };
}
