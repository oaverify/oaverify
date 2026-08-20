/**
 * Bridge a resolved OpenAPI document to a streaming body validator,
 * mirroring `@oaverify/internal-validator`'s `Validator.getOperation` locator shape
 * (`{ method, path }`).
 *
 * The stream validator validates one resolved schema; routing and
 * body-schema lookup stay the caller's job (the split the framework
 * adapters keep). This helper does the mechanical part the
 * `stream-from-spec` recipe spelled out by hand: pull the operation's
 * request-body schema and carry the document's ref container so an
 * internal `$ref` (`#/components/schemas/Pet`) resolves. Omitting that
 * container is the footgun that throws `unresolvable $ref` at
 * construction.
 *
 * `path` is the literal path-template key (`"/pets/{id}"`), looked up
 * exactly: no template matching (that needs the router). Resolve a real
 * request path to its template upstream (e.g. `Validator.matchRoute`),
 * then pass the template here. The document must be resolved (via
 * `resolveSpec`) so internal refs live under `components`.
 *
 * @packageDocumentation
 */

import type { HttpMethod, OpenAPIDocument, RequestBodyObject } from "@oaverify/internal-core";
import { createStreamValidator, type StreamValidator } from "./engine/index.js";
import {
  carryComponents,
  HTTP_METHOD_SET,
  resolveLocalRef,
  versionFromDoc,
} from "./openapi/body-schema.js";
import type { StreamValidatorOptions } from "./options.js";

/**
 * Locates a request body within an {@link OpenAPIDocument}.
 *
 * @public
 */
export interface OperationLocator {
  /** HTTP method (case-insensitive), e.g. `"post"`. */
  method: string;
  /** Literal path-template key as declared, e.g. `"/pets/{id}"`. Matched exactly. */
  path: string;
  /** Request body media type. Defaults to `"application/json"`. */
  mediaType?: string;
}

/**
 * Build a {@link StreamValidator} for an operation's request body. Reads
 * the OpenAPI version off `doc.openapi` (override with
 * `options.openApiVersion`) and carries `doc.components` so internal
 * `$ref`s resolve.
 *
 * ```ts
 * import { resolveSpec } from "@oaverify/core/spec";
 * import { streamValidatorForOperation } from "@oaverify/stream";
 *
 * const { document } = await resolveSpec({ reader, entry });
 * const validator = streamValidatorForOperation(document, {
 *   method: "post",
 *   path: "/pets",
 * });
 * await pipeline(request, validator, sink);
 * ```
 *
 * A local `requestBody` `$ref` (`#/components/requestBodies/...`, a normal
 * shape `resolveSpec` leaves in place) is followed; an external one that
 * survived resolution throws. Throws (before any byte) when the path,
 * method, request body, media type, or body schema is absent. Pairs with
 * `@oaverify/internal-validator`'s `getOperation`: same `{ method, path }` locator,
 * exact-key lookup, no routing.
 *
 * @public
 */
export function streamValidatorForOperation(
  doc: OpenAPIDocument,
  locator: OperationLocator,
  options: StreamValidatorOptions = {},
): StreamValidator {
  const method = locator.method.toLowerCase();
  if (!HTTP_METHOD_SET.has(method)) {
    throw new Error(`streamValidatorForOperation: unknown HTTP method "${locator.method}"`);
  }
  const pathItem = doc.paths?.[locator.path];
  if (pathItem === undefined) {
    throw new Error(`streamValidatorForOperation: no path "${locator.path}" in the document`);
  }
  const where = `${method.toUpperCase()} "${locator.path}"`;
  const operation = pathItem[method as HttpMethod];
  if (operation === undefined) {
    throw new Error(`streamValidatorForOperation: no ${where} operation in the document`);
  }
  if (operation.requestBody === undefined) {
    throw new Error(`streamValidatorForOperation: ${where} has no requestBody`);
  }
  const requestBody = resolveLocalRef<RequestBodyObject>(
    doc,
    operation.requestBody,
    "requestBody",
    where,
  );
  const mediaType = locator.mediaType ?? "application/json";
  const mediaTypeObject = requestBody.content[mediaType];
  if (mediaTypeObject === undefined) {
    throw new Error(`streamValidatorForOperation: no "${mediaType}" content for ${where}`);
  }
  const bodySchema = mediaTypeObject.schema;
  if (bodySchema === undefined) {
    throw new Error(`streamValidatorForOperation: no schema for "${mediaType}" on ${where}`);
  }

  // Carry the document's ref container so an internal `$ref` in the body
  // schema resolves (deref a top-level `$ref` first; see carryComponents).
  const schema = carryComponents(doc, bodySchema);

  const openApiVersion = options.openApiVersion ?? versionFromDoc(doc.openapi);
  return createStreamValidator(schema, {
    ...options,
    ...(openApiVersion === undefined ? {} : { openApiVersion }),
  });
}
