import type {
  CallbackObject,
  ComponentsObject,
  ExampleObject,
  ExternalDocumentationObject,
  HeaderObject,
  HttpMethod,
  InfoObject,
  JsonValue,
  LinkObject,
  MediaTypeObject,
  OpenAPIDocument,
  OperationObject,
  ParameterLocation,
  ParameterObject,
  PathItem,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from "@oaverify/internal-core";
import { setSpecKey } from "@oaverify/internal-core";

/**
 * Per-operation override recipe used inside {@link SpecOverlay.overrides}.
 *
 * @public
 */
export interface PathOverride {
  /**
   * HTTP method → operation fragment. Keys are lowercase. The key
   * `"*"` applies the fragment to every method present on the path;
   * a concrete method key wins over the wildcard for that method.
   */
  operations?: Partial<Record<HttpMethod | "*", OperationOverride>>;
  /** Fields on the PathItem itself (e.g. `parameters`) to merge. */
  pathItem?: Partial<PathItem>;
}

/**
 * Recipe for patching a single {@link ResponseObject} inside an
 * operation. Used by {@link OperationOverride.patchResponses} to modify
 * a response in place rather than replace the whole thing (the
 * coarse-grained replacement lives on {@link OperationOverride.responses}).
 *
 * @public
 */
export interface ResponseOverride {
  /** Set or replace the response's `description`. */
  description?: string;
  /**
   * Shallow-merge into the response's `headers` map, keyed by header
   * name. Existing entries with the same key are overwritten.
   */
  headers?: Record<string, HeaderObject | ReferenceObject>;
  /**
   * Patch the response's `content` map, keyed by media type. When the
   * media type exists in the base, the override and base are
   * shallow-merged. When both supply a `schema`, the override schema
   * is wrapped as `allOf: [existing, override]` (mirrors
   * {@link SpecOverlay.extendSchemas}); when only the override supplies
   * one, it's applied as-is.
   */
  content?: Record<string, MediaTypeObject>;
}

/**
 * Recipe for patching a single {@link OperationObject}. Each field is
 * independent; use any subset. Field groups, in the order they apply:
 *
 * - {@link OperationOverride.replace | replace}: wholesale swap; mutually
 *   exclusive with every other field on this interface.
 * - Parameters: {@link OperationOverride.upsertParameters | upsertParameters},
 *   {@link OperationOverride.removeParameters | removeParameters}.
 * - Body: {@link OperationOverride.requestBody | requestBody}.
 * - Responses: {@link OperationOverride.responses | responses} (per-status
 *   replace), {@link OperationOverride.patchResponses | patchResponses}
 *   (per-status patch), {@link OperationOverride.removeResponses | removeResponses}.
 * - Tags: {@link OperationOverride.tags | tags} (replace),
 *   {@link OperationOverride.addTags | addTags},
 *   {@link OperationOverride.removeTags | removeTags}.
 * - Security: {@link OperationOverride.security | security} (replace),
 *   {@link OperationOverride.addSecurity | addSecurity},
 *   {@link OperationOverride.removeSecurity | removeSecurity}.
 * - Metadata: {@link OperationOverride.servers | servers},
 *   {@link OperationOverride.callbacks | callbacks},
 *   {@link OperationOverride.externalDocs | externalDocs},
 *   {@link OperationOverride.setExtensions | setExtensions}.
 *
 * Conflict rules applied by {@link applyOverlays}:
 * - `replace` is wholesale and cannot be combined with any other field.
 * - Within tags / security, the replace field cannot coexist with the
 *   matching add / remove additives.
 * - `removeParameters` / `removeResponses` silently no-op when the
 *   target isn't present; wildcard overrides (`"*"`) fan out to many
 *   operations and can't assume every target has the same surface.
 *
 * @public
 */
export interface OperationOverride {
  /** Replace the whole OperationObject. Mutually exclusive with every other field. */
  replace?: OperationObject;
  /**
   * Add-or-replace parameters by (`name`, `in`). Existing entries with
   * the same key are overwritten; anything else appends.
   * Reference-object entries (`{ $ref: … }`) in the base can't be
   * matched without resolution, so new parameters with the same key
   * append alongside them rather than replacing.
   */
  upsertParameters?: ParameterObject[];
  /** Remove parameters by (`name`, `in`). Silent no-op on missing entries. */
  removeParameters?: Array<{ name: string; in: ParameterLocation }>;
  /** Replace the request body entirely. */
  requestBody?: RequestBodyObject;
  /** Merge-by-status-code into responses. Status codes present in both base and override take the override. */
  responses?: Record<string, ResponseObject>;
  /**
   * Per-status response patches. Unlike {@link OperationOverride.responses}
   * which replaces a whole response by status code, `patchResponses`
   * modifies the existing response (description / headers / content) in
   * place. When the target status isn't present on the operation, the
   * patch is applied to an empty response and becomes the new entry
   * (matches OpenAPI Overlay 1.0 merge-on-missing semantics).
   */
  patchResponses?: Record<string, ResponseOverride>;
  /** Remove response status codes. Silent no-op on missing entries. */
  removeResponses?: string[];
  /** Replace the operation's tags wholesale. Cannot combine with `addTags` / `removeTags`. */
  tags?: string[];
  /** Append tag names. Duplicates against existing tags are dropped. */
  addTags?: string[];
  /** Remove tag names. Silent no-op on missing entries. */
  removeTags?: string[];
  /** Replace the operation's security requirement wholesale. Cannot combine with the additives. */
  security?: SecurityRequirementObject[];
  /** Append security requirements. */
  addSecurity?: SecurityRequirementObject[];
  /**
   * Remove security requirements that deep-equal one of the listed
   * entries. Silent no-op on missing entries (operations rarely list
   * the same requirement twice).
   */
  removeSecurity?: SecurityRequirementObject[];
  /** Replace the operation's `servers` list wholesale. */
  servers?: ServerObject[];
  /**
   * Add or replace callbacks by key. Existing callback names are
   * overwritten with the override's value.
   */
  callbacks?: Record<string, CallbackObject | ReferenceObject>;
  /** Set the operation's `externalDocs`. Replaces any existing value. */
  externalDocs?: ExternalDocumentationObject;
  /** Set or replace the operation's `operationId`. */
  operationId?: string;
  /** Set or replace the operation's `summary`. */
  summary?: string;
  /** Set or replace the operation's `description`. */
  description?: string;
  /** Set or replace the operation's `deprecated` flag. */
  deprecated?: boolean;
  /**
   * Set or remove `x-*` extension fields on the operation. An `undefined`
   * value deletes the field; any other value sets / replaces it.
   */
  setExtensions?: Record<`x-${string}`, JsonValue | undefined>;
}

/**
 * Predicate filter used by {@link SpecOverlay.modifyOperations}. All
 * present fields must match (AND); an undefined `where` matches every
 * operation under `paths` and `webhooks`.
 *
 * @public
 */
export interface OperationWhere {
  /** Match operations whose `tags` array contains any of these. */
  tags?: string[];
  /** Restrict by HTTP method. */
  methods?: HttpMethod[];
  /** Restrict by path; tested against the path string with `RegExp.test`. */
  pathPattern?: RegExp;
}

/**
 * One entry in {@link SpecOverlay.modifyOperations}.
 *
 * @public
 */
export interface ModifyOperationsEntry {
  where?: OperationWhere;
  apply: OperationOverride;
}

/**
 * Predicate filter used by {@link SpecOverlay.modifyParameters}.
 *
 * @public
 */
export interface ParameterWhere {
  /** Restrict by parameter location. */
  in?: ParameterLocation;
  /** Match the parameter `name` with `RegExp.test`. */
  nameMatches?: RegExp;
}

/**
 * One entry in {@link SpecOverlay.modifyParameters}. The `apply`
 * fragment is shallow-merged into each matching parameter; omit a field
 * to leave it unchanged. An explicit `undefined` overwrites the base
 * value (JSON serialization then drops the key).
 *
 * @public
 */
export interface ModifyParametersEntry {
  where?: ParameterWhere;
  apply: Partial<ParameterObject>;
}

/**
 * A spec overlay: instructions to patch the base OpenAPI document.
 * Overlays apply in order; later overlays win on conflict.
 *
 * Field groups, applied in this order within a single overlay:
 *
 * - Document metadata: {@link SpecOverlay.info | info},
 *   {@link SpecOverlay.servers | servers} (replace) /
 *   {@link SpecOverlay.addServers | addServers},
 *   {@link SpecOverlay.tags | tags} (replace) /
 *   {@link SpecOverlay.extendTags | extendTags} /
 *   {@link SpecOverlay.replaceTags | replaceTags} /
 *   {@link SpecOverlay.removeTags | removeTags},
 *   {@link SpecOverlay.security | security} (replace) /
 *   {@link SpecOverlay.addSecurity | addSecurity},
 *   {@link SpecOverlay.setExtensions | setExtensions}.
 * - Paths: {@link SpecOverlay.addPaths | addPaths} /
 *   {@link SpecOverlay.removePaths | removePaths} /
 *   {@link SpecOverlay.overrides | overrides}.
 * - Webhooks: {@link SpecOverlay.addWebhooks | addWebhooks} /
 *   {@link SpecOverlay.removeWebhooks | removeWebhooks}.
 * - Iterators: {@link SpecOverlay.modifyOperations | modifyOperations} /
 *   {@link SpecOverlay.modifyParameters | modifyParameters} run after
 *   the path / webhook edits above have settled.
 * - Components: schemas, parameters, requestBodies, responses, headers,
 *   securitySchemes, links, callbacks, examples each get
 *   `extend<Bucket>` / `replace<Bucket>` / `remove<Bucket>` verbs. The
 *   `extendSchemas` verb wraps in `allOf`; the other extend verbs
 *   shallow-merge.
 *
 * @public
 */
export interface SpecOverlay {
  /** Shallow-merge into the document's `info` object. */
  info?: Partial<InfoObject>;
  /** Replace the document's `servers` array wholesale. Cannot combine with `addServers`. */
  servers?: ServerObject[];
  /** Append to the document's `servers` array. */
  addServers?: ServerObject[];
  /** Replace the document's `tags` array wholesale. Cannot combine with the per-name tag verbs. */
  tags?: TagObject[];
  /**
   * Merge or insert tags by name. For an existing tag of the same name,
   * the entry is shallow-merged (override fields win). Tags absent from
   * the base are appended.
   */
  extendTags?: TagObject[];
  /** Replace tags by name. Tags absent from the base are appended. */
  replaceTags?: TagObject[];
  /** Remove tags by name. Throws if any name isn't present in the base. */
  removeTags?: string[];
  /**
   * Replace the document-level security requirement wholesale. Cannot
   * combine with `addSecurity`. Note that the OAS-defined "empty array
   * means anonymous" semantics are preserved: setting this to `[]`
   * removes the requirement.
   */
  security?: SecurityRequirementObject[];
  /** Append security requirements to the document's `security` array. */
  addSecurity?: SecurityRequirementObject[];
  /** Add webhook paths. Throws if a target name already exists. */
  addWebhooks?: Record<string, PathItem>;
  /** Remove webhook paths by name. Throws if a target name isn't present. */
  removeWebhooks?: string[];
  /**
   * Set or remove document-level `x-*` extension fields. A value of
   * `undefined` deletes the field; any other value sets / replaces it.
   */
  setExtensions?: Record<`x-${string}`, JsonValue | undefined>;

  /** Add new paths. Throws if a target path already exists in the base document. */
  addPaths?: Record<string, PathItem>;
  /** Remove paths. Throws if a target path isn't present in the base document. */
  removePaths?: string[];
  /**
   * Per-path modifications, keyed by path; see {@link PathOverride}.
   * Throws when a target path isn't present in the base document. The
   * key `"*"` applies its override to every path; entries apply in
   * declaration order.
   */
  overrides?: Record<string, PathOverride>;

  /**
   * Walk every operation under `paths` (and `webhooks` when present),
   * run the {@link ModifyOperationsEntry.where} predicate, and apply
   * the override on matches. Entries run in declaration order.
   * Webhook entries that are reference objects (`{ $ref: ... }`) are
   * passed through unchanged; their path-item contents aren't
   * inspectable pre-resolve.
   */
  modifyOperations?: ModifyOperationsEntry[];
  /**
   * Walk every operation's parameters (and each path-item-level
   * parameters list) and apply the patch on matches. Reference-object
   * parameters are skipped (their name / location aren't inspectable
   * without resolution).
   */
  modifyParameters?: ModifyParametersEntry[];

  /** Extend a component schema via `allOf` (original + extension both apply). */
  extendSchemas?: Record<string, SchemaObject>;
  /** Replace a component schema wholesale. */
  replaceSchemas?: Record<string, SchemaObject>;
  /** Remove component schemas. Throws if a target schema isn't present. */
  removeSchemas?: string[];

  /**
   * Shallow-merge a patch into existing `components.parameters` entries.
   *
   * The patch is a {@link https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype | Partial}
   * because that is what extending means: supplying only `description`
   * leaves `name` and `in` as the base declared them. A name not
   * already in the bucket is created from the patch as-is, so a partial
   * patch there produces a partial component; use `replaceParameters`
   * to add a complete one.
   */
  extendParameters?: Record<string, Partial<ParameterObject> | ReferenceObject>;
  /** Replace `components.parameters` entries by name. New keys append. */
  replaceParameters?: Record<string, ParameterObject | ReferenceObject>;
  /** Remove `components.parameters` entries by name. Throws on missing. */
  removeComponentParameters?: string[];

  /** Shallow-merge a patch into existing `components.responses` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendComponentResponses?: Record<string, Partial<ResponseObject> | ReferenceObject>;
  /** Replace `components.responses` entries by name. New keys append. */
  replaceComponentResponses?: Record<string, ResponseObject | ReferenceObject>;
  /** Remove `components.responses` entries by name. Throws on missing. */
  removeComponentResponses?: string[];

  /** Shallow-merge a patch into existing `components.requestBodies` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendRequestBodies?: Record<string, Partial<RequestBodyObject> | ReferenceObject>;
  /** Replace `components.requestBodies` entries by name. New keys append. */
  replaceRequestBodies?: Record<string, RequestBodyObject | ReferenceObject>;
  /** Remove `components.requestBodies` entries by name. Throws on missing. */
  removeRequestBodies?: string[];

  /** Shallow-merge a patch into existing `components.headers` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendHeaders?: Record<string, Partial<HeaderObject> | ReferenceObject>;
  /** Replace `components.headers` entries by name. New keys append. */
  replaceHeaders?: Record<string, HeaderObject | ReferenceObject>;
  /** Remove `components.headers` entries by name. Throws on missing. */
  removeHeaders?: string[];

  /** Shallow-merge a patch into existing `components.securitySchemes` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendSecuritySchemes?: Record<string, Partial<SecuritySchemeObject> | ReferenceObject>;
  /** Replace `components.securitySchemes` entries by name. New keys append. */
  replaceSecuritySchemes?: Record<string, SecuritySchemeObject | ReferenceObject>;
  /** Remove `components.securitySchemes` entries by name. Throws on missing. */
  removeSecuritySchemes?: string[];

  /** Shallow-merge a patch into existing `components.links` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendLinks?: Record<string, Partial<LinkObject> | ReferenceObject>;
  /** Replace `components.links` entries by name. New keys append. */
  replaceLinks?: Record<string, LinkObject | ReferenceObject>;
  /** Remove `components.links` entries by name. Throws on missing. */
  removeLinks?: string[];

  /** Shallow-merge a patch into existing `components.callbacks` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendCallbacks?: Record<string, Partial<CallbackObject> | ReferenceObject>;
  /** Replace `components.callbacks` entries by name. New keys append. */
  replaceCallbacks?: Record<string, CallbackObject | ReferenceObject>;
  /** Remove `components.callbacks` entries by name. Throws on missing. */
  removeCallbacks?: string[];

  /** Shallow-merge a patch into existing `components.examples` entries;
   * a new key is created from the patch. See {@link SpecOverlay.extendParameters}. */
  extendExamples?: Record<string, Partial<ExampleObject> | ReferenceObject>;
  /** Replace `components.examples` entries by name. New keys append. */
  replaceExamples?: Record<string, ExampleObject | ReferenceObject>;
  /** Remove `components.examples` entries by name. Throws on missing. */
  removeExamples?: string[];
}

// Record (not array) so the compiler enforces exact sync with the
// interface: a verb added to SpecOverlay without a row here (or vice
// versa) is a type error.
const SPEC_OVERLAY_VERB_RECORD: Record<keyof SpecOverlay, true> = {
  info: true,
  servers: true,
  addServers: true,
  tags: true,
  extendTags: true,
  replaceTags: true,
  removeTags: true,
  security: true,
  addSecurity: true,
  addWebhooks: true,
  removeWebhooks: true,
  setExtensions: true,
  addPaths: true,
  removePaths: true,
  overrides: true,
  modifyOperations: true,
  modifyParameters: true,
  extendSchemas: true,
  replaceSchemas: true,
  removeSchemas: true,
  extendParameters: true,
  replaceParameters: true,
  removeComponentParameters: true,
  extendComponentResponses: true,
  replaceComponentResponses: true,
  removeComponentResponses: true,
  extendRequestBodies: true,
  replaceRequestBodies: true,
  removeRequestBodies: true,
  extendHeaders: true,
  replaceHeaders: true,
  removeHeaders: true,
  extendSecuritySchemes: true,
  replaceSecuritySchemes: true,
  removeSecuritySchemes: true,
  extendLinks: true,
  replaceLinks: true,
  removeLinks: true,
  extendCallbacks: true,
  replaceCallbacks: true,
  removeCallbacks: true,
  extendExamples: true,
  replaceExamples: true,
  removeExamples: true,
};

/**
 * Every verb recognised by {@link applyOverlays}; the canonical key
 * list for {@link SpecOverlay}, kept in sync with the interface by the
 * type system. Useful for callers that want to report which keys of a
 * would-be overlay are unrecognised.
 *
 * @public
 */
export const specOverlayVerbs: ReadonlySet<string> = new Set(Object.keys(SPEC_OVERLAY_VERB_RECORD));

/**
 * Whether `value` is shaped like a {@link SpecOverlay}: a non-array
 * object whose every key is a recognised overlay verb. Key-level only;
 * the values are validated when {@link applyOverlays} applies them. An
 * empty object passes (a no-op overlay). A standard OpenAPI Overlay
 * 1.0 envelope (`overlay` / `actions`) fails; translate it first with
 * `@oaverify/core/overlay-spec`'s `translateOverlay`.
 *
 * @public
 */
export function isSpecOverlay(value: unknown): value is SpecOverlay {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => specOverlayVerbs.has(key));
}

const METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
];

/**
 * Apply a sequence of overlays to a base OpenAPI document, returning a new
 * document. Does not mutate the input.
 *
 * @param base - The base (resolved) OpenAPI document.
 * @param overlays - Overlays to apply in order.
 * @returns The patched document.
 * @throws On conflicts that the overlay semantics do not know how to merge.
 *
 * @example
 * ```ts
 * const patched = applyOverlays(spec, [overlay1, overlay2]);
 * ```
 *
 * @public
 */
export function applyOverlays(
  base: OpenAPIDocument,
  overlays: readonly SpecOverlay[],
): OpenAPIDocument {
  let doc: OpenAPIDocument = structuredClone(base);
  for (const overlay of overlays) doc = applyOverlay(doc, overlay);
  return doc;
}

function applyOverlay(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  assertNoSelfConflict(overlay);
  let next: OpenAPIDocument = { ...doc };

  next = applyDocumentMetadata(next, overlay);
  next = applyDocumentPaths(next, overlay);
  next = applyDocumentWebhooks(next, overlay);
  next = applyDocumentIterators(next, overlay);
  next = applyComponents(next, overlay);

  return next;
}

function applyDocumentMetadata(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  const next: OpenAPIDocument = { ...doc };

  if (overlay.info) {
    next.info = { ...doc.info, ...overlay.info };
  }

  if (overlay.servers !== undefined) {
    next.servers = [...overlay.servers];
  }
  if (overlay.addServers) {
    next.servers = [...(next.servers ?? []), ...overlay.addServers];
  }

  if (overlay.tags !== undefined) {
    next.tags = [...overlay.tags];
  }
  if (overlay.extendTags || overlay.replaceTags || overlay.removeTags) {
    next.tags = applyTagOps(next.tags ?? [], overlay);
  }

  if (overlay.security !== undefined) {
    next.security = [...overlay.security];
  }
  if (overlay.addSecurity) {
    next.security = [...(next.security ?? []), ...overlay.addSecurity];
  }

  if (overlay.setExtensions) {
    for (const [key, value] of Object.entries(overlay.setExtensions) as Array<
      [`x-${string}`, JsonValue | undefined]
    >) {
      if (value === undefined) {
        delete next[key];
      } else {
        setSpecKey(next as unknown as Record<string, unknown>, key, value);
      }
    }
  }

  return next;
}

function applyTagOps(tags: TagObject[], overlay: SpecOverlay): TagObject[] {
  const byName = new Map(tags.map((t) => [t.name, t]));

  for (const entry of overlay.extendTags ?? []) {
    const existing = byName.get(entry.name);
    byName.set(entry.name, existing ? { ...existing, ...entry } : entry);
  }
  for (const entry of overlay.replaceTags ?? []) {
    byName.set(entry.name, entry);
  }
  for (const name of overlay.removeTags ?? []) {
    if (!byName.has(name)) {
      throw new Error(`overlay removeTags targets unknown tag ${name}`);
    }
    byName.delete(name);
  }

  return Array.from(byName.values());
}

function applyDocumentPaths(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  if (!overlay.addPaths && !overlay.removePaths && !overlay.overrides) return doc;

  const next: OpenAPIDocument = { ...doc };
  const paths: Record<string, PathItem> = { ...next.paths };

  if (overlay.addPaths) {
    for (const [path, item] of Object.entries(overlay.addPaths)) {
      if (paths[path] !== undefined) {
        throw new Error(`overlay conflict: path ${path} already exists in the base document`);
      }
      setSpecKey(paths, path, item);
    }
  }

  if (overlay.removePaths) {
    for (const path of overlay.removePaths) {
      if (paths[path] === undefined) {
        throw new Error(`overlay removePaths targets unknown path ${path}`);
      }
      delete paths[path];
    }
  }

  if (overlay.overrides) {
    for (const [pathPattern, override] of Object.entries(overlay.overrides)) {
      const matches = pathPattern === "*" ? Object.keys(paths) : [pathPattern];
      for (const path of matches) {
        const item = paths[path];
        if (item === undefined) {
          throw new Error(`overlay override targets unknown path ${path}`);
        }
        setSpecKey(paths, path, applyPathOverride(item, override));
      }
    }
  }

  next.paths = paths;
  return next;
}

function applyDocumentWebhooks(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  if (!overlay.addWebhooks && !overlay.removeWebhooks) return doc;

  const next: OpenAPIDocument = { ...doc };
  const webhooks: Record<string, PathItem | ReferenceObject> = { ...next.webhooks };

  if (overlay.addWebhooks) {
    for (const [name, item] of Object.entries(overlay.addWebhooks)) {
      if (webhooks[name] !== undefined) {
        throw new Error(`overlay conflict: webhook ${name} already exists in the base document`);
      }
      setSpecKey(webhooks, name, item);
    }
  }

  if (overlay.removeWebhooks) {
    for (const name of overlay.removeWebhooks) {
      if (webhooks[name] === undefined) {
        throw new Error(`overlay removeWebhooks targets unknown webhook ${name}`);
      }
      delete webhooks[name];
    }
  }

  next.webhooks = webhooks;
  return next;
}

function applyDocumentIterators(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  if (!overlay.modifyOperations && !overlay.modifyParameters) return doc;

  let next: OpenAPIDocument = { ...doc };
  if (overlay.modifyOperations) {
    for (const entry of overlay.modifyOperations) {
      next = applyModifyOperations(next, entry);
    }
  }
  if (overlay.modifyParameters) {
    for (const entry of overlay.modifyParameters) {
      next = applyModifyParameters(next, entry);
    }
  }
  return next;
}

function applyModifyOperations(
  doc: OpenAPIDocument,
  entry: ModifyOperationsEntry,
): OpenAPIDocument {
  const next: OpenAPIDocument = { ...doc };
  if (doc.paths) {
    next.paths = walkPathsForModify(doc.paths, entry);
  }
  if (doc.webhooks) {
    next.webhooks = walkWebhooksForModify(doc.webhooks, entry);
  }
  return next;
}

function walkPathsForModify(
  paths: Record<string, PathItem>,
  entry: ModifyOperationsEntry,
): Record<string, PathItem> {
  const out: Record<string, PathItem> = {};
  for (const [path, item] of Object.entries(paths)) {
    setSpecKey(out, path, applyOpModifyToPathItem(path, item, entry));
  }
  return out;
}

function walkWebhooksForModify(
  webhooks: Record<string, PathItem | ReferenceObject>,
  entry: ModifyOperationsEntry,
): Record<string, PathItem | ReferenceObject> {
  const out: Record<string, PathItem | ReferenceObject> = {};
  for (const [name, item] of Object.entries(webhooks)) {
    if ("$ref" in item) {
      setSpecKey(out, name, item);
      continue;
    }
    setSpecKey(out, name, applyOpModifyToPathItem(name, item, entry));
  }
  return out;
}

function applyOpModifyToPathItem(
  pathOrName: string,
  item: PathItem,
  entry: ModifyOperationsEntry,
): PathItem {
  if (entry.where?.pathPattern && !stablePatternTest(entry.where.pathPattern, pathOrName)) {
    return item;
  }
  const next: PathItem = { ...item };
  let changed = false;
  for (const method of METHODS) {
    const op = next[method];
    if (op === undefined) continue;
    if (entry.where?.methods && !entry.where.methods.includes(method)) continue;
    if (entry.where?.tags && !operationHasAnyTag(op, entry.where.tags)) continue;
    next[method] = applyOperationOverride(op, entry.apply);
    changed = true;
  }
  return changed ? next : item;
}

function operationHasAnyTag(op: OperationObject, tags: string[]): boolean {
  if (!op.tags) return false;
  return op.tags.some((t) => tags.includes(t));
}

function applyModifyParameters(
  doc: OpenAPIDocument,
  entry: ModifyParametersEntry,
): OpenAPIDocument {
  const next: OpenAPIDocument = { ...doc };
  if (doc.paths) {
    const paths: Record<string, PathItem> = {};
    for (const [path, item] of Object.entries(doc.paths)) {
      setSpecKey(paths, path, applyParamModifyToPathItem(item, entry));
    }
    next.paths = paths;
  }
  if (doc.webhooks) {
    const webhooks: Record<string, PathItem | ReferenceObject> = {};
    for (const [name, item] of Object.entries(doc.webhooks)) {
      if ("$ref" in item) {
        setSpecKey(webhooks, name, item);
        continue;
      }
      setSpecKey(webhooks, name, applyParamModifyToPathItem(item, entry));
    }
    next.webhooks = webhooks;
  }
  return next;
}

function applyParamModifyToPathItem(item: PathItem, entry: ModifyParametersEntry): PathItem {
  const next: PathItem = { ...item };
  if (item.parameters) {
    next.parameters = item.parameters.map((p) => mergeParamIfMatch(p, entry));
  }
  for (const method of METHODS) {
    const op = next[method];
    if (op === undefined) continue;
    if (op.parameters) {
      next[method] = {
        ...op,
        parameters: op.parameters.map((p) => mergeParamIfMatch(p, entry)),
      };
    }
  }
  return next;
}

function mergeParamIfMatch(
  param: ParameterObject | ReferenceObject,
  entry: ModifyParametersEntry,
): ParameterObject | ReferenceObject {
  if (!("name" in param)) return param;
  if (entry.where?.in && param.in !== entry.where.in) return param;
  if (entry.where?.nameMatches && !stablePatternTest(entry.where.nameMatches, param.name)) {
    return param;
  }
  return { ...param, ...entry.apply };
}

/**
 * `RegExp.test()` advances `lastIndex` on /…/g and /…/y inputs. Reusing
 * the same pattern across multiple iterations of the modify* iterators
 * would then skip matches. Reset `lastIndex` to 0 around the call so
 * every test starts from the beginning, and restore the caller's
 * original `lastIndex` afterwards so the regex object is left as the
 * caller passed it. Sticky (`y`) semantics are preserved (a `y` pattern
 * still anchors at the matching position 0).
 */
function stablePatternTest(pattern: RegExp, input: string): boolean {
  const prev = pattern.lastIndex;
  pattern.lastIndex = 0;
  try {
    return pattern.test(input);
  } finally {
    pattern.lastIndex = prev;
  }
}

interface ComponentBucketVerbs<T> {
  bucket: keyof ComponentsObject;
  extend?: Record<string, T>;
  replace?: Record<string, T>;
  remove?: string[];
  /** Label for error messages (e.g. "removeSchemas"). */
  removeVerb: string;
}

function applyComponents(doc: OpenAPIDocument, overlay: SpecOverlay): OpenAPIDocument {
  const buckets: ComponentBucketVerbs<unknown>[] = [
    {
      bucket: "schemas",
      extend: overlay.extendSchemas,
      replace: overlay.replaceSchemas,
      remove: overlay.removeSchemas,
      removeVerb: "removeSchemas",
    },
    {
      bucket: "parameters",
      extend: overlay.extendParameters,
      replace: overlay.replaceParameters,
      remove: overlay.removeComponentParameters,
      removeVerb: "removeComponentParameters",
    },
    {
      bucket: "responses",
      extend: overlay.extendComponentResponses,
      replace: overlay.replaceComponentResponses,
      remove: overlay.removeComponentResponses,
      removeVerb: "removeComponentResponses",
    },
    {
      bucket: "requestBodies",
      extend: overlay.extendRequestBodies,
      replace: overlay.replaceRequestBodies,
      remove: overlay.removeRequestBodies,
      removeVerb: "removeRequestBodies",
    },
    {
      bucket: "headers",
      extend: overlay.extendHeaders,
      replace: overlay.replaceHeaders,
      remove: overlay.removeHeaders,
      removeVerb: "removeHeaders",
    },
    {
      bucket: "securitySchemes",
      extend: overlay.extendSecuritySchemes,
      replace: overlay.replaceSecuritySchemes,
      remove: overlay.removeSecuritySchemes,
      removeVerb: "removeSecuritySchemes",
    },
    {
      bucket: "links",
      extend: overlay.extendLinks,
      replace: overlay.replaceLinks,
      remove: overlay.removeLinks,
      removeVerb: "removeLinks",
    },
    {
      bucket: "callbacks",
      extend: overlay.extendCallbacks,
      replace: overlay.replaceCallbacks,
      remove: overlay.removeCallbacks,
      removeVerb: "removeCallbacks",
    },
    {
      bucket: "examples",
      extend: overlay.extendExamples,
      replace: overlay.replaceExamples,
      remove: overlay.removeExamples,
      removeVerb: "removeExamples",
    },
  ];

  const touched = buckets.some((b) => b.extend || b.replace || b.remove);
  if (!touched) return doc;

  const next: OpenAPIDocument = { ...doc };
  const components: ComponentsObject = { ...next.components };

  for (const b of buckets) {
    if (!b.extend && !b.replace && !b.remove) continue;
    const entries: Record<string, unknown> = {
      ...(components[b.bucket] as Record<string, unknown> | undefined),
    };

    if (b.bucket === "schemas") {
      // Schemas use allOf-extend, not shallow-merge.
      for (const [name, extension] of Object.entries(b.extend ?? {})) {
        const existing = entries[name];
        setSpecKey(
          entries,
          name,
          existing === undefined ? extension : { allOf: [existing, extension] },
        );
      }
    } else {
      for (const [name, extension] of Object.entries(b.extend ?? {})) {
        const existing = entries[name];
        if (existing === undefined || typeof existing !== "object") {
          setSpecKey(entries, name, extension);
        } else {
          setSpecKey(entries, name, { ...(existing as object), ...(extension as object) });
        }
      }
    }

    for (const [name, replacement] of Object.entries(b.replace ?? {})) {
      setSpecKey(entries, name, replacement);
    }

    for (const name of b.remove ?? []) {
      if (!(name in entries)) {
        throw new Error(`overlay ${b.removeVerb} targets unknown ${b.bucket} entry ${name}`);
      }
      delete entries[name];
    }

    (components as Record<string, unknown>)[b.bucket] = entries;
  }

  next.components = components;
  return next;
}

/**
 * Hard-reject overlays whose own fields contradict each other before
 * we start mutating anything. A contradictory overlay is almost
 * certainly a consumer bug, and silently picking a winner would hide
 * it; surfacing the conflict with a location message is cheaper.
 */
function assertNoSelfConflict(overlay: SpecOverlay): void {
  if (overlay.addPaths && overlay.removePaths) {
    for (const p of overlay.removePaths) {
      if (p in overlay.addPaths) {
        throw new Error(`overlay self-conflict: addPaths and removePaths both name ${p}`);
      }
    }
  }
  if (overlay.addWebhooks && overlay.removeWebhooks) {
    for (const name of overlay.removeWebhooks) {
      if (name in overlay.addWebhooks) {
        throw new Error(`overlay self-conflict: addWebhooks and removeWebhooks both name ${name}`);
      }
    }
  }

  assertWholesaleVsAdditive(
    overlay.servers !== undefined,
    overlay.addServers !== undefined,
    "servers",
    "addServers",
  );
  assertWholesaleVsAdditive(
    overlay.security !== undefined,
    overlay.addSecurity !== undefined,
    "security",
    "addSecurity",
  );

  const tagsWholesale = overlay.tags !== undefined;
  const tagsAdditives =
    overlay.extendTags !== undefined ||
    overlay.replaceTags !== undefined ||
    overlay.removeTags !== undefined;
  if (tagsWholesale && tagsAdditives) {
    throw new Error(
      "overlay self-conflict: tags (wholesale) cannot combine with extendTags / replaceTags / removeTags",
    );
  }
  if (overlay.replaceTags && overlay.removeTags) {
    const names = new Set(overlay.replaceTags.map((t) => t.name));
    for (const n of overlay.removeTags) {
      if (names.has(n)) {
        throw new Error(`overlay self-conflict: replaceTags and removeTags both name ${n}`);
      }
    }
  }
  if (overlay.extendTags && overlay.removeTags) {
    const names = new Set(overlay.extendTags.map((t) => t.name));
    for (const n of overlay.removeTags) {
      if (names.has(n)) {
        throw new Error(`overlay self-conflict: extendTags and removeTags both name ${n}`);
      }
    }
  }

  assertBucketSelfConflicts(
    "schemas",
    overlay.extendSchemas,
    overlay.replaceSchemas,
    overlay.removeSchemas,
  );
  assertBucketSelfConflicts(
    "parameters",
    overlay.extendParameters,
    overlay.replaceParameters,
    overlay.removeComponentParameters,
  );
  assertBucketSelfConflicts(
    "responses",
    overlay.extendComponentResponses,
    overlay.replaceComponentResponses,
    overlay.removeComponentResponses,
  );
  assertBucketSelfConflicts(
    "requestBodies",
    overlay.extendRequestBodies,
    overlay.replaceRequestBodies,
    overlay.removeRequestBodies,
  );
  assertBucketSelfConflicts(
    "headers",
    overlay.extendHeaders,
    overlay.replaceHeaders,
    overlay.removeHeaders,
  );
  assertBucketSelfConflicts(
    "securitySchemes",
    overlay.extendSecuritySchemes,
    overlay.replaceSecuritySchemes,
    overlay.removeSecuritySchemes,
  );
  assertBucketSelfConflicts(
    "links",
    overlay.extendLinks,
    overlay.replaceLinks,
    overlay.removeLinks,
  );
  assertBucketSelfConflicts(
    "callbacks",
    overlay.extendCallbacks,
    overlay.replaceCallbacks,
    overlay.removeCallbacks,
  );
  assertBucketSelfConflicts(
    "examples",
    overlay.extendExamples,
    overlay.replaceExamples,
    overlay.removeExamples,
  );
}

function assertWholesaleVsAdditive(
  hasWholesale: boolean,
  hasAdditive: boolean,
  wholesaleName: string,
  additiveName: string,
): void {
  if (hasWholesale && hasAdditive) {
    throw new Error(
      `overlay self-conflict: ${wholesaleName} (wholesale) cannot combine with ${additiveName}`,
    );
  }
}

function assertBucketSelfConflicts(
  bucket: string,
  extend: Record<string, unknown> | undefined,
  replace: Record<string, unknown> | undefined,
  remove: string[] | undefined,
): void {
  if (replace && remove) {
    for (const n of remove) {
      if (n in replace) {
        throw new Error(
          `overlay self-conflict: replace${capitalize(bucket)} and remove${capitalize(bucket)} both name ${n}`,
        );
      }
    }
  }
  if (extend && remove) {
    for (const n of remove) {
      if (n in extend) {
        throw new Error(
          `overlay self-conflict: extend${capitalize(bucket)} and remove${capitalize(bucket)} both name ${n}`,
        );
      }
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function applyPathOverride(item: PathItem, override: PathOverride): PathItem {
  const next: PathItem = { ...item };
  // `Object.assign` would use [[Set]] and so fire the inherited
  // `__proto__` setter on an overlay carrying that key. Object spread
  // below and `setSpecKey` both create own data properties instead.
  if (override.pathItem) {
    for (const [key, value] of Object.entries(override.pathItem)) {
      setSpecKey(next as Record<string, unknown>, key, value);
    }
  }
  if (override.operations) {
    const methods =
      "*" in override.operations ? METHODS : (Object.keys(override.operations) as HttpMethod[]);
    for (const method of methods) {
      const opOverride = override.operations[method] ?? override.operations["*"];
      if (opOverride === undefined) continue;
      const op = next[method];
      if (op === undefined) continue;
      next[method] = applyOperationOverride(op, opOverride);
    }
  }
  return next;
}

const OPERATION_OVERRIDE_ADDITIVE_KEYS = [
  "upsertParameters",
  "removeParameters",
  "requestBody",
  "responses",
  "patchResponses",
  "removeResponses",
  "tags",
  "addTags",
  "removeTags",
  "security",
  "addSecurity",
  "removeSecurity",
  "servers",
  "callbacks",
  "externalDocs",
  "operationId",
  "summary",
  "description",
  "deprecated",
  "setExtensions",
] as const;

function applyOperationOverride(op: OperationObject, override: OperationOverride): OperationObject {
  if (override.replace !== undefined) {
    for (const key of OPERATION_OVERRIDE_ADDITIVE_KEYS) {
      if (override[key] !== undefined) {
        throw new Error(
          `overlay conflict: OperationOverride.replace cannot be combined with ${key}`,
        );
      }
    }
    return override.replace;
  }

  if (override.tags !== undefined && (override.addTags || override.removeTags)) {
    throw new Error(
      "overlay conflict: OperationOverride.tags (wholesale) cannot combine with addTags / removeTags",
    );
  }
  if (override.security !== undefined && (override.addSecurity || override.removeSecurity)) {
    throw new Error(
      "overlay conflict: OperationOverride.security (wholesale) cannot combine with addSecurity / removeSecurity",
    );
  }

  const next: OperationObject = { ...op };

  if (override.upsertParameters) {
    const existing = [...(op.parameters ?? [])];
    for (const newParam of override.upsertParameters) {
      // Reference-object entries (`{ $ref: … }`) can't be matched by
      // (name, in) without resolving them; overlays apply pre-resolve
      // so we just skip matching against refs and append / overwrite
      // against concrete entries.
      const idx = existing.findIndex(
        (p) => "name" in p && p.name === newParam.name && p.in === newParam.in,
      );
      if (idx >= 0) existing[idx] = newParam;
      else existing.push(newParam);
    }
    next.parameters = existing;
  }
  if (override.removeParameters) {
    const existing = next.parameters ?? op.parameters ?? [];
    const filtered = existing.filter(
      (p) =>
        !("name" in p) ||
        !override.removeParameters!.some((r) => r.name === p.name && r.in === p.in),
    );
    if (filtered.length !== existing.length) next.parameters = filtered;
  }
  if (override.requestBody) next.requestBody = override.requestBody;

  if (override.responses) {
    next.responses = { ...op.responses, ...override.responses };
  }
  if (override.patchResponses) {
    const responses = { ...(next.responses ?? op.responses) };
    for (const [status, patch] of Object.entries(override.patchResponses)) {
      const existing = responses[status];
      if (existing === undefined) {
        // Status not on the operation yet: treat the patch as the
        // initial response. Matches OpenAPI Overlay 1.0 merge
        // semantics, which create on missing rather than erroring.
        setSpecKey(responses, status, applyResponseOverride({}, patch));
        continue;
      }
      if ("$ref" in existing) {
        throw new Error(
          `overlay patchResponses cannot patch reference-object response (status ${status})`,
        );
      }
      setSpecKey(responses, status, applyResponseOverride(existing, patch));
    }
    next.responses = responses;
  }
  if (override.removeResponses) {
    const source = next.responses ?? op.responses ?? {};
    const copy: Record<string, (typeof source)[string]> = { ...source };
    let removed = false;
    for (const status of override.removeResponses) {
      if (status in copy) {
        delete copy[status];
        removed = true;
      }
    }
    if (removed) next.responses = copy;
  }

  if (override.tags !== undefined) {
    next.tags = [...override.tags];
  } else if (override.addTags || override.removeTags) {
    const existing = new Set(op.tags ?? []);
    for (const t of override.addTags ?? []) existing.add(t);
    for (const t of override.removeTags ?? []) existing.delete(t);
    next.tags = Array.from(existing);
  }

  if (override.security !== undefined) {
    next.security = [...override.security];
  } else if (override.addSecurity || override.removeSecurity) {
    let security = [...(op.security ?? [])];
    if (override.addSecurity) security = [...security, ...override.addSecurity];
    if (override.removeSecurity) {
      security = security.filter(
        (req) => !override.removeSecurity!.some((rm) => securityRequirementEquals(req, rm)),
      );
    }
    next.security = security;
  }

  if (override.servers !== undefined) next.servers = [...override.servers];

  if (override.callbacks) {
    next.callbacks = { ...op.callbacks, ...override.callbacks };
  }

  if (override.externalDocs) next.externalDocs = override.externalDocs;

  if (override.operationId !== undefined) next.operationId = override.operationId;
  if (override.summary !== undefined) next.summary = override.summary;
  if (override.description !== undefined) next.description = override.description;
  if (override.deprecated !== undefined) next.deprecated = override.deprecated;

  if (override.setExtensions) {
    for (const [key, value] of Object.entries(override.setExtensions) as Array<
      [`x-${string}`, JsonValue | undefined]
    >) {
      if (value === undefined) {
        delete (next as Record<string, unknown>)[key];
      } else {
        (next as Record<string, unknown>)[key] = value;
      }
    }
  }

  return next;
}

function applyResponseOverride(
  response: ResponseObject,
  override: ResponseOverride,
): ResponseObject {
  const next: ResponseObject = { ...response };
  if (override.description !== undefined) next.description = override.description;
  if (override.headers) {
    next.headers = { ...response.headers, ...override.headers };
  }
  if (override.content) {
    const content: Record<string, MediaTypeObject> = { ...response.content };
    for (const [mediaType, patch] of Object.entries(override.content)) {
      const existing = content[mediaType];
      if (existing === undefined) {
        setSpecKey(content, mediaType, patch);
        continue;
      }
      const merged: MediaTypeObject = { ...existing, ...patch };
      if (patch.schema !== undefined && existing.schema !== undefined) {
        merged.schema = { allOf: [existing.schema, patch.schema] };
      }
      setSpecKey(content, mediaType, merged);
    }
    next.content = content;
  }
  return next;
}

function securityRequirementEquals(
  a: SecurityRequirementObject,
  b: SecurityRequirementObject,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!(k in b)) return false;
    const av = a[k] ?? [];
    const bv = b[k] ?? [];
    if (av.length !== bv.length) return false;
    const aSorted = [...av].sort();
    const bSorted = [...bv].sort();
    for (let i = 0; i < aSorted.length; i++) {
      if (aSorted[i] !== bSorted[i]) return false;
    }
  }
  return true;
}
