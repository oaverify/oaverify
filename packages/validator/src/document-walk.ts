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
 * A schema `$ref` is not followed. A target is visited at its own
 * definition, so following it would report the same defect once per
 * reference. In a resolved document every schema has a definition to be
 * visited at.
 *
 * A `$ref` on a non-schema object (Path Item, Parameter, Header, Response,
 * Request Body, Media Type, Callback) is followed, because its target may
 * have no definition the walk otherwise reaches: the resolver stitches a
 * cycle among external objects under `x-oaverify-externals`, where nothing
 * names it. The target is visited once, at its own pointer, and only when
 * nothing reached it directly.
 *
 * @packageDocumentation
 */

import {
  escapePointerSegment,
  pointerFromRefFragment,
  resolveJsonPointer,
  type HttpMethod,
  type OpenAPIDocument,
} from "@oaverify/internal-core";
import type { ResolvedGraph } from "@oaverify/internal-schema";
import { refSiblingIsDiscarded } from "@oaverify/internal-schema/internals";
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
 * OAS 3.2 also puts Operation Objects in `additionalOperations`,
 * which the document walk visits independently of runtime method support.
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
  /** Each OpenAPI schema slot, before shape filtering or subschema traversal. */
  onSchemaRoot?: (schema: unknown, pointer: string) => void;

  /**
   * Whether the active dialect discards `$ref` siblings (OAS 3.0).
   *
   * When set, a Schema Object with `$ref` is treated as reference-only:
   * its sibling keywords and their subtrees are not visited.
   */
  refSuppressesSiblings?: boolean;
  /**
   * Every Schema Object reached, including subschemas, each with the
   * RFC 6901 pointer to it. A schema shared by identity is visited
   * once. Return `false` to skip that schema's own subschemas.
   */
  onSchemaNode?: (schema: Record<string, unknown>, pointer: string) => void | boolean;
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
 * `components.callbacks`), the `schemas` / `parameters` / `headers`
 * / `requestBodies` / `responses` / `mediaTypes` / `pathItems` sections
 * of `components`, and then the target of every local non-schema `$ref`
 * found on the way that none of those reached.
 *
 * @internal
 */
export function walkDocumentSchemas(document: OpenAPIDocument, hooks: DocumentWalkHooks): void {
  const seenSchemas = new Set<unknown>();
  const refSuppressesSiblings = hooks.refSuppressesSiblings ?? false;

  // Non-schema objects visited so far, and the local `$ref` targets to
  // visit once the named containers are done. A target something visited
  // directly is skipped; direct visits themselves are not deduplicated.
  const reached = new Set<object>();
  const pending: Array<[(value: unknown, pointer: string) => void, string, unknown]> = [];
  const enter = (
    value: Record<string, unknown>,
    visit: (value: unknown, pointer: string) => void,
    oneHop = false,
  ): void => {
    reached.add(value);
    const resolved = followLocal(value, document, oneHop);
    if (resolved !== undefined) pending.push([visit, resolved.pointer, resolved.target]);
  };

  const walkSchema = (schema: unknown, pointer: string, isRoot = true): void => {
    if (isRoot) hooks.onSchemaRoot?.(schema, pointer);
    if (!isObj(schema) || seenSchemas.has(schema)) return;
    seenSchemas.add(schema);
    if (refSuppressesSiblings && "$ref" in schema) return;

    if (hooks.onSchemaNode?.(schema, pointer) === false) return;

    for (const { key, value, at } of subschemaEntries(schema)) {
      const step = at === undefined ? "" : `/${typeof at === "number" ? at : escapePointer(at)}`;
      walkSchema(value, `${pointer}/${key}${step}`, false);
    }
  };

  const walkEncoding = (entry: unknown, pointer: string): void => {
    if (!isObj(entry)) return;
    const headers = entry["headers"];
    if (isObj(headers)) {
      for (const [name, header] of Object.entries(headers)) {
        walkParameterLike(header, `${pointer}/headers/${escapePointer(name)}`);
      }
    }
    walkEncodings(entry, pointer);
  };

  const walkEncodings = (host: Record<string, unknown>, pointer: string): void => {
    const encoding = host["encoding"];
    if (isObj(encoding)) {
      for (const [name, entry] of Object.entries(encoding)) {
        walkEncoding(entry, `${pointer}/encoding/${escapePointer(name)}`);
      }
    }
    const prefix = host["prefixEncoding"];
    if (Array.isArray(prefix)) {
      for (const [i, entry] of prefix.entries())
        walkEncoding(entry, `${pointer}/prefixEncoding/${i}`);
    }
    if (host["itemEncoding"] !== undefined)
      walkEncoding(host["itemEncoding"], `${pointer}/itemEncoding`);
  };

  const walkMediaType = (mediaType: unknown, pointer: string): void => {
    if (!isObj(mediaType)) return;
    enter(mediaType, walkMediaType);
    if (mediaType["schema"] !== undefined) walkSchema(mediaType["schema"], `${pointer}/schema`);
    if (mediaType["itemSchema"] !== undefined)
      walkSchema(mediaType["itemSchema"], `${pointer}/itemSchema`);
    hooks.onMediaType?.(mediaType, pointer);
    walkEncodings(mediaType, pointer);
  };

  const walkContent = (content: unknown, pointer: string): void => {
    if (!isObj(content)) return;
    for (const [name, mediaType] of Object.entries(content)) {
      walkMediaType(mediaType, `${pointer}/${escapePointer(name)}`);
    }
  };

  const walkParameterLike = (param: unknown, pointer: string): void => {
    if (!isObj(param)) return;
    enter(param, walkParameterLike);
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
    enter(response, walkResponse);
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
    enter(body, walkRequestBody);
    if (body["content"] !== undefined) walkContent(body["content"], `${pointer}/content`);
  };

  const walkCallback = (callback: unknown, pointer: string): void => {
    if (!isObj(callback)) return;
    enter(callback, walkCallback);
    for (const [expression, item] of Object.entries(callback)) {
      walkPathItem(item, `${pointer}/${escapePointer(expression)}`);
    }
  };

  const walkCallbacks = (callbacks: unknown, pointer: string): void => {
    if (!isObj(callbacks)) return;
    for (const [name, callback] of Object.entries(callbacks)) {
      walkCallback(callback, `${pointer}/${escapePointer(name)}`);
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
    enter(item, walkPathItem, true);
    walkParameterList(item["parameters"], `${pointer}/parameters`);
    for (const method of METHODS) {
      if (item[method] !== undefined) walkOperation(item[method], `${pointer}/${method}`);
    }
    const additional = item["additionalOperations"];
    if (isObj(additional)) {
      for (const [method, operation] of Object.entries(additional)) {
        walkOperation(operation, `${pointer}/additionalOperations/${escapePointer(method)}`);
      }
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
  if (isObj(components)) {
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
    const mediaTypes = components["mediaTypes"];
    if (isObj(mediaTypes)) {
      for (const [name, entry] of Object.entries(mediaTypes)) {
        walkMediaType(entry, `/components/mediaTypes/${escapePointer(name)}`);
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
        walkCallback(entry, `/components/callbacks/${escapePointer(name)}`);
      }
    }
  }

  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const [visit, pointer, target] = next;
    if (isObj(target) && !reached.has(target)) visit(target, pointer);
  }
}

/**
 * The value a local `$ref` chain ends at, with the pointer of its last
 * hop. `undefined` when `value` is not a reference, or when a hop is not
 * a local pointer, does not resolve, or the chain runs past 32 hops:
 * conformance and the resolver report those, and the walk skips them.
 * With `oneHop`, the caller visits intermediate Path Item siblings too.
 */
function followLocal(
  value: Record<string, unknown>,
  document: OpenAPIDocument,
  oneHop = false,
): { target: unknown; pointer: string } | undefined {
  let current: unknown = value;
  let pointer: string | undefined;
  for (let hops = 0; hops <= 32; hops++) {
    if (!isObj(current) || typeof current["$ref"] !== "string") {
      return pointer === undefined ? undefined : { target: current, pointer };
    }
    const next = hops === 32 ? undefined : pointerFromRefFragment(current["$ref"]);
    if (next === undefined) return undefined;
    try {
      current = resolveJsonPointer(document, next);
    } catch {
      return undefined;
    }
    pointer = next;
    if (oneHop) return { target: current, pointer };
  }
  return undefined;
}

/**
 * Add the ignored-edge metadata a document-root schema resolver needs
 * under OAS 3.0 `$ref` sibling suppression.
 *
 * `resolve(document)` is still a JSON Schema graph walk, so it cannot
 * discover OpenAPI's document-level schema positions on its own.
 * Pointer resolution then needs these exact object/key edges to refuse
 * refs into discarded sibling subtrees without confusing ordinary maps
 * that happen to contain a literal `$ref` key.
 *
 * @internal
 */
export function recordDocumentRefSiblingSuppression(
  document: OpenAPIDocument,
  graph: ResolvedGraph,
): void {
  if (graph.refSuppressesSiblings !== true) return;
  const ignoredRefSiblingKeys = graph.ignoredRefSiblingKeys ?? new WeakMap();
  graph.ignoredRefSiblingKeys = ignoredRefSiblingKeys;

  walkDocumentSchemas(document, {
    onSchemaNode(schema) {
      const ignored = Object.keys(schema).filter((key) => refSiblingIsDiscarded(schema, key, true));
      if (ignored.length > 0) ignoredRefSiblingKeys.set(schema, new Set(ignored));
      return "$ref" in schema ? false : undefined;
    },
  });
}
