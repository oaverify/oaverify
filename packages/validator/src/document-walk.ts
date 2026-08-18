/**
 * One traversal of an OpenAPI document's schema-bearing positions,
 * shared by everything that needs to visit them.
 *
 * Four consumers: the `examples` check (which needs schema nodes *and*
 * the objects that carry examples beside a schema), `@oaverify/check`'s
 * ReDoS check and its `format-not-validated` pass, and the CLI's
 * unknown-format collection (which need only schema nodes). Another
 * independent copy of "where does OpenAPI put schemas" is how one walker
 * gains a container the others silently miss, so the structure lives
 * here once and callers supply hooks.
 *
 * That is also the blast radius of an omission here, and it is wider
 * than it looks: `query` was missing from METHODS below, and all four
 * went quiet on an OAS 3.2 QUERY operation rather than one of them
 * reporting differently.
 *
 * Positions inside a schema come from `core`'s subschema constants, so
 * this cannot drift from what the compiler treats as a subschema either.
 *
 * `$ref` is not followed. A target is visited at its own definition, so
 * following it would report the same defect once per reference. In a
 * resolved document every schema has a definition to be visited at.
 *
 * @packageDocumentation
 */

import {
  escapePointerSegment,
  type HttpMethod,
  type OpenAPIDocument,
} from "@oaverify/internal-core";
import { subschemaEntries } from "@oaverify/internal-core/subschema-positions";

/**
 * The fixed method fields that hold an Operation Object under a Path
 * Item.
 *
 * Written as a `Record<HttpMethod, true>` and read back with
 * `Object.keys`, so the compiler requires every member of the union.
 * An array, however it is typed, cannot: `satisfies` rejects a name that
 * is not a method, and nothing rejects a method the list forgets. The
 * omission is the failure that happened. `query` went missing here while
 * the router, the spec linter, the stream analyzer and the CLI emitter
 * all carried it, and nothing failed anywhere: all four consumers of
 * this walk simply reported nothing for a QUERY operation.
 *
 * Not the whole story under OAS 3.2, which also puts Operation Objects
 * in `additionalOperations`, keyed by arbitrary method token. That is
 * unhandled here and everywhere else in the repo; see the issue.
 */
const METHOD_FIELDS: Record<HttpMethod, true> = {
  get: true,
  put: true,
  post: true,
  delete: true,
  options: true,
  head: true,
  patch: true,
  trace: true,
  query: true,
};

/**
 * {@link METHOD_FIELDS} as a list. Exported so a second walk over
 * Operation Objects reuses this one instead of writing its own copy:
 * the `query` omission described above is what an independent copy
 * costs.
 *
 * @internal
 */
export const METHODS = Object.keys(METHOD_FIELDS) as readonly HttpMethod[];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * RFC 6901 segment escaping: `~` becomes `~0`, `/` becomes `~1`.
 *
 * The core implementation under the name this package's importers
 * already use. It is one function rather than a copy because the
 * pointers escaped here (`ExampleIssue`, `RedosIssue`) and the ones
 * escaped in the compiler are documented as the same grammar, and a
 * consumer is invited to compare them. Two implementations would make
 * that guarantee depend on them staying identical by luck.
 */
export const escapePointer = escapePointerSegment;

/**
 * Hooks a caller supplies. Every one is optional; a walk with none is a
 * no-op that still costs the traversal.
 */
export interface DocumentWalkHooks {
  /**
   * Every Schema Object reached, including subschemas, each with the
   * RFC 6901 pointer to it. A schema shared by identity is visited once.
   */
  onSchemaNode?: (schema: Record<string, unknown>, pointer: string) => void;
  /**
   * A Media Type Object, whose `example` / `examples` sit beside its
   * `schema` rather than inside it.
   */
  onMediaType?: (mediaType: Record<string, unknown>, pointer: string) => void;
  /**
   * A Parameter or Header Object, which has the same beside-the-schema
   * shape as a Media Type Object. Includes the Header Objects under
   * `encoding.<property>.headers`.
   */
  onParameterLike?: (param: Record<string, unknown>, pointer: string) => void;
}

/**
 * Walk a resolved OpenAPI document, calling the supplied hooks.
 *
 * Reaches `paths`, `webhooks`, callbacks (on an operation and under
 * `components.callbacks`), and the `schemas` / `parameters` / `headers`
 * / `requestBodies` / `responses` / `pathItems` sections of
 * `components`.
 *
 * @internal
 */
export function walkDocumentSchemas(document: OpenAPIDocument, hooks: DocumentWalkHooks): void {
  const seenSchemas = new Set<unknown>();

  const walkSchema = (schema: unknown, pointer: string): void => {
    if (!isObj(schema) || seenSchemas.has(schema)) return;
    seenSchemas.add(schema);

    hooks.onSchemaNode?.(schema, pointer);

    for (const { key, value, at } of subschemaEntries(schema)) {
      const step = at === undefined ? "" : `/${typeof at === "number" ? at : escapePointer(at)}`;
      walkSchema(value, `${pointer}/${key}${step}`);
    }
  };

  const walkContent = (content: unknown, pointer: string): void => {
    if (!isObj(content)) return;
    for (const [mediaTypeName, mediaType] of Object.entries(content)) {
      if (!isObj(mediaType)) continue;
      const at = `${pointer}/${escapePointer(mediaTypeName)}`;
      if (mediaType["schema"] !== undefined) walkSchema(mediaType["schema"], `${at}/schema`);
      hooks.onMediaType?.(mediaType, at);
      // A Header Object is legal at `encoding.<property>.headers.<name>`.
      const encoding = mediaType["encoding"];
      if (!isObj(encoding)) continue;
      for (const [property, entry] of Object.entries(encoding)) {
        if (!isObj(entry)) continue;
        const headers = entry["headers"];
        if (!isObj(headers)) continue;
        for (const [headerName, header] of Object.entries(headers)) {
          walkParameterLike(
            header,
            `${at}/encoding/${escapePointer(property)}/headers/${escapePointer(headerName)}`,
          );
        }
      }
    }
  };

  const walkParameterLike = (param: unknown, pointer: string): void => {
    if (!isObj(param)) return;
    if (param["schema"] !== undefined) walkSchema(param["schema"], `${pointer}/schema`);
    if (param["content"] !== undefined) walkContent(param["content"], `${pointer}/content`);
    hooks.onParameterLike?.(param, pointer);
  };

  const walkParameterList = (params: unknown, pointer: string): void => {
    if (!Array.isArray(params)) return;
    for (const [i, p] of params.entries()) walkParameterLike(p, `${pointer}/${i}`);
  };

  const walkResponse = (response: unknown, pointer: string): void => {
    if (!isObj(response)) return;
    if (response["content"] !== undefined) walkContent(response["content"], `${pointer}/content`);
    const headers = response["headers"];
    if (isObj(headers)) {
      for (const [name, header] of Object.entries(headers)) {
        walkParameterLike(header, `${pointer}/headers/${escapePointer(name)}`);
      }
    }
  };

  const walkRequestBody = (body: unknown, pointer: string): void => {
    if (!isObj(body)) return;
    if (body["content"] !== undefined) walkContent(body["content"], `${pointer}/content`);
  };

  const walkCallbacks = (callbacks: unknown, pointer: string): void => {
    if (!isObj(callbacks)) return;
    for (const [name, callback] of Object.entries(callbacks)) {
      if (!isObj(callback)) continue;
      const at = `${pointer}/${escapePointer(name)}`;
      for (const [expression, item] of Object.entries(callback)) {
        walkPathItem(item, `${at}/${escapePointer(expression)}`);
      }
    }
  };

  const walkOperation = (operation: unknown, pointer: string): void => {
    if (!isObj(operation)) return;
    walkParameterList(operation["parameters"], `${pointer}/parameters`);
    if (operation["requestBody"] !== undefined) {
      walkRequestBody(operation["requestBody"], `${pointer}/requestBody`);
    }
    const responses = operation["responses"];
    if (isObj(responses)) {
      for (const [status, response] of Object.entries(responses)) {
        walkResponse(response, `${pointer}/responses/${escapePointer(status)}`);
      }
    }
    walkCallbacks(operation["callbacks"], `${pointer}/callbacks`);
  };

  const walkPathItem = (item: unknown, pointer: string): void => {
    if (!isObj(item)) return;
    walkParameterList(item["parameters"], `${pointer}/parameters`);
    for (const method of METHODS) {
      if (item[method] !== undefined) walkOperation(item[method], `${pointer}/${method}`);
    }
  };

  const doc = document as unknown as Record<string, unknown>;

  for (const container of ["paths", "webhooks"] as const) {
    const entries = doc[container];
    if (!isObj(entries)) continue;
    for (const [name, item] of Object.entries(entries)) {
      walkPathItem(item, `/${container}/${escapePointer(name)}`);
    }
  }

  const components = doc["components"];
  if (!isObj(components)) return;

  const schemas = components["schemas"];
  if (isObj(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      walkSchema(schema, `/components/schemas/${escapePointer(name)}`);
    }
  }
  for (const section of ["parameters", "headers"] as const) {
    const entries = components[section];
    if (!isObj(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      walkParameterLike(entry, `/components/${section}/${escapePointer(name)}`);
    }
  }
  const requestBodies = components["requestBodies"];
  if (isObj(requestBodies)) {
    for (const [name, entry] of Object.entries(requestBodies)) {
      walkRequestBody(entry, `/components/requestBodies/${escapePointer(name)}`);
    }
  }
  const responses = components["responses"];
  if (isObj(responses)) {
    for (const [name, entry] of Object.entries(responses)) {
      walkResponse(entry, `/components/responses/${escapePointer(name)}`);
    }
  }
  const pathItems = components["pathItems"];
  if (isObj(pathItems)) {
    for (const [name, entry] of Object.entries(pathItems)) {
      walkPathItem(entry, `/components/pathItems/${escapePointer(name)}`);
    }
  }
  const callbacks = components["callbacks"];
  if (isObj(callbacks)) {
    for (const [name, entry] of Object.entries(callbacks)) {
      if (!isObj(entry)) continue;
      for (const [expression, item] of Object.entries(entry)) {
        walkPathItem(
          item,
          `/components/callbacks/${escapePointer(name)}/${escapePointer(expression)}`,
        );
      }
    }
  }
}
