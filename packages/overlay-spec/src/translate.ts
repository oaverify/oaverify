import type {
  HttpMethod,
  JsonValue,
  ParameterLocation,
  ParameterObject,
  ServerObject,
  TagObject,
} from "@oaverify/internal-core";
import type {
  ModifyOperationsEntry,
  OperationOverride,
  PathOverride,
  ResponseOverride,
  SpecOverlay,
} from "@oaverify/internal-spec";
import { HTTP_METHODS, getOwn, setSpecKey } from "@oaverify/internal-core";
import {
  type FilterExpr,
  type PathToken,
  UnrecognisedTargetError,
  parseTarget,
} from "./parse-target.js";

/**
 * Normalised view of one OpenAPI Overlay action: either an `update`
 * payload or a `remove: true` directive (never both). The translator
 * receives this and dispatches by target shape.
 */
export type NormalizedAction =
  | { kind: "update"; value: JsonValue | undefined }
  | { kind: "remove" };

/**
 * The HTTP methods that OpenAPI Overlay path targets are expected to
 * use. Mirrors `@oaverify/core`'s `HttpMethod` but kept local so the
 * recogniser doesn't depend on a runtime constant.
 */
const HTTP_METHOD_SET: ReadonlySet<HttpMethod> = new Set(HTTP_METHODS);

const COMPONENT_BUCKETS = [
  "schemas",
  "parameters",
  "requestBodies",
  "responses",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
  "examples",
] as const;
type ComponentBucket = (typeof COMPONENT_BUCKETS)[number];

/**
 * Dispatch one action against the accumulating `SpecOverlay`. Mutates
 * the overlay in place; the caller (`translateOverlay`) seeds an empty
 * overlay and walks every action.
 *
 * @throws {@link UnrecognisedTargetError} when the target's JSONPath
 *         shape doesn't map to a typed verb.
 * @throws `Error` with the offending target in the message when the
 *         action payload is malformed for the target's shape (e.g.
 *         non-object where an object is required).
 */
export function applyAction(target: string, action: NormalizedAction, overlay: SpecOverlay): void {
  const tokens = parseTarget(target);
  if (tokens.length === 0) {
    throw new UnrecognisedTargetError(target, "expected at least one segment after `$`");
  }
  const head = tokens[0]!;
  if (head.kind !== "name") {
    throw new UnrecognisedTargetError(target, "expected a named root segment");
  }
  switch (head.name) {
    case "info":
      return translateInfo(target, tokens, action, overlay);
    case "servers":
      return translateServers(target, tokens, action, overlay);
    case "tags":
      return translateTags(target, tokens, action, overlay);
    case "security":
      return translateSecurity(target, tokens, action, overlay);
    case "webhooks":
      return translateWebhooks(target, tokens, action, overlay);
    case "components":
      return translateComponents(target, tokens, action, overlay);
    case "paths":
      return translatePaths(target, tokens, action, overlay);
    default:
      throw new UnrecognisedTargetError(target, `unknown root field \`${head.name}\``);
  }
}

// ---------------------------------------------------------------- info

function translateInfo(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (tokens.length !== 1) {
    throw new UnrecognisedTargetError(target, "no path supported below `$.info`");
  }
  if (action.kind === "remove") {
    throw new UnrecognisedTargetError(target, "`remove` on `$.info` has no typed-verb equivalent");
  }
  const payload = asObject(target, action.value);
  overlay.info = { ...overlay.info, ...payload };
}

// ------------------------------------------------------------- servers

function translateServers(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (tokens.length === 1) {
    // `$.servers`: append to the servers list (update), or zero it out (remove).
    if (action.kind === "remove") {
      overlay.servers = [];
      return;
    }
    const items = asEntries(target, action.value).map(
      (s) => asObject(target, s) as unknown as ServerObject,
    );
    overlay.addServers = [...(overlay.addServers ?? []), ...items];
    return;
  }
  throw new UnrecognisedTargetError(target, "per-element `$.servers[*]` is not recognised");
}

// ---------------------------------------------------------------- tags

function translateTags(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (tokens.length === 1) {
    if (action.kind === "remove") {
      overlay.tags = [];
      return;
    }
    const items = asEntries(target, action.value).map(
      (t) => asObject(target, t) as unknown as TagObject,
    );
    overlay.extendTags = [...(overlay.extendTags ?? []), ...items];
    return;
  }
  // `$.tags[?(@.name=='X')]`: filter to one tag by name.
  if (tokens.length === 2 && tokens[1]?.kind === "filter") {
    const tagName = expectFieldEq(target, tokens[1].expr, "name");
    if (action.kind === "remove") {
      overlay.removeTags = [...(overlay.removeTags ?? []), tagName];
      return;
    }
    const patch = asObject(target, action.value);
    overlay.extendTags = [...(overlay.extendTags ?? []), { ...patch, name: tagName } as TagObject];
    return;
  }
  throw new UnrecognisedTargetError(
    target,
    "only `$.tags` or `$.tags[?(@.name=='X')]` is recognised",
  );
}

// ------------------------------------------------------------ security

function translateSecurity(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (tokens.length !== 1) {
    throw new UnrecognisedTargetError(target, "only the bare `$.security` target is recognised");
  }
  if (action.kind === "remove") {
    overlay.security = [];
    return;
  }
  const items = asEntries(target, action.value);
  overlay.addSecurity = [
    ...(overlay.addSecurity ?? []),
    ...items.map((r) => asObject(target, r) as Record<string, string[]>),
  ];
}

// ------------------------------------------------------------ webhooks

function translateWebhooks(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  // `$.webhooks['name']`: add or remove by name.
  if (tokens.length === 2 && tokens[1]?.kind === "key") {
    const name = tokens[1].key;
    if (action.kind === "remove") {
      overlay.removeWebhooks = [...(overlay.removeWebhooks ?? []), name];
      return;
    }
    const pathItem = asObject(target, action.value);
    overlay.addWebhooks = { ...overlay.addWebhooks, [name]: pathItem };
    return;
  }
  throw new UnrecognisedTargetError(
    target,
    "only `$.webhooks['name']` is recognised (whole-bucket targets are not)",
  );
}

// ---------------------------------------------------------- components

function translateComponents(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  // `$.components.<bucket>.<Name>` (or `['Name']`)
  if (tokens.length !== 3) {
    throw new UnrecognisedTargetError(target, "expected `$.components.<bucket>.<Name>`");
  }
  const bucketTok = tokens[1];
  const nameTok = tokens[2];
  if (bucketTok?.kind !== "name" || !isComponentBucket(bucketTok.name)) {
    throw new UnrecognisedTargetError(
      target,
      `expected one of ${COMPONENT_BUCKETS.join(" / ")} as the bucket name`,
    );
  }
  if (nameTok?.kind !== "name" && nameTok?.kind !== "key") {
    throw new UnrecognisedTargetError(target, "expected a component entry name");
  }
  const bucket = bucketTok.name;
  const name = nameTok.kind === "name" ? nameTok.name : nameTok.key;

  if (action.kind === "remove") {
    const field = REMOVE_VERB_BY_BUCKET[bucket];
    const existing = (overlay[field] as string[] | undefined) ?? [];
    (overlay as Record<string, unknown>)[field] = [...existing, name];
    return;
  }
  const payload = asObject(target, action.value);
  const field = EXTEND_VERB_BY_BUCKET[bucket];
  const existing = (overlay[field] as Record<string, unknown> | undefined) ?? {};
  (overlay as Record<string, unknown>)[field] = { ...existing, [name]: payload };
}

function isComponentBucket(name: string): name is ComponentBucket {
  return (COMPONENT_BUCKETS as readonly string[]).includes(name);
}

const EXTEND_VERB_BY_BUCKET: Record<ComponentBucket, keyof SpecOverlay> = {
  schemas: "extendSchemas",
  parameters: "extendParameters",
  requestBodies: "extendRequestBodies",
  responses: "extendComponentResponses",
  headers: "extendHeaders",
  securitySchemes: "extendSecuritySchemes",
  links: "extendLinks",
  callbacks: "extendCallbacks",
  examples: "extendExamples",
};

const REMOVE_VERB_BY_BUCKET: Record<ComponentBucket, keyof SpecOverlay> = {
  schemas: "removeSchemas",
  parameters: "removeComponentParameters",
  requestBodies: "removeRequestBodies",
  responses: "removeComponentResponses",
  headers: "removeHeaders",
  securitySchemes: "removeSecuritySchemes",
  links: "removeLinks",
  callbacks: "removeCallbacks",
  examples: "removeExamples",
};

// --------------------------------------------------------------- paths

function translatePaths(
  target: string,
  tokens: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  // tokens[0] is `paths`; the rest depends on shape.
  // tokens[1] selects the path: `name` (dot form), `key` (bracket form), or `wildcard`.
  if (tokens.length < 2) {
    throw new UnrecognisedTargetError(target, "expected a path segment after `$.paths`");
  }

  const pathSel = tokens[1]!;
  const pathKey = pathSelectorKey(target, pathSel);

  if (tokens.length === 2) {
    return applyPathLevel(target, pathKey, pathSel.kind === "wildcard", action, overlay);
  }

  // tokens[2] selects the method (or its `*`).
  const methodSel = tokens[2]!;
  const method = methodSelector(target, methodSel);

  if (tokens.length === 3) {
    return applyOperationLevel(target, pathKey, method, action, overlay);
  }

  // tokens[3] selects an operation child: parameters / responses / etc.
  // Also: tokens[2] = `*` (any method) + tokens[3] = filter is the
  // modifyOperations entry shape.
  if (
    tokens.length === 4 &&
    method === "*" &&
    methodSel.kind === "wildcard" &&
    tokens[3]?.kind === "filter"
  ) {
    return applyModifyOperations(target, pathKey, pathSel, tokens[3].expr, action, overlay);
  }

  const childTok = tokens[3]!;
  if (childTok.kind !== "name") {
    throw new UnrecognisedTargetError(target, "expected `parameters` or `responses` here");
  }
  if (childTok.name === "parameters") {
    return applyOperationParameters(target, pathKey, method, tokens.slice(4), action, overlay);
  }
  if (childTok.name === "responses") {
    return applyOperationResponses(target, pathKey, method, tokens.slice(4), action, overlay);
  }
  throw new UnrecognisedTargetError(
    target,
    `unknown operation child \`${childTok.name}\` (expected \`parameters\` or \`responses\`)`,
  );
}

function pathSelectorKey(target: string, tok: PathToken): string {
  if (tok.kind === "name") return tok.name;
  if (tok.kind === "key") return tok.key;
  if (tok.kind === "wildcard") return "*";
  throw new UnrecognisedTargetError(target, "unexpected path selector");
}

function methodSelector(target: string, tok: PathToken): HttpMethod | "*" {
  if (tok.kind === "wildcard") return "*";
  if (tok.kind === "name" && HTTP_METHOD_SET.has(tok.name as HttpMethod))
    return tok.name as HttpMethod;
  if (tok.kind === "name") {
    throw new UnrecognisedTargetError(target, `unknown HTTP method \`${tok.name}\``);
  }
  throw new UnrecognisedTargetError(target, "expected an HTTP method name");
}

function applyPathLevel(
  target: string,
  pathKey: string,
  isWildcard: boolean,
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (action.kind === "remove") {
    if (isWildcard) {
      throw new UnrecognisedTargetError(target, "`remove` on `$.paths.*` is not supported");
    }
    overlay.removePaths = [...(overlay.removePaths ?? []), pathKey];
    return;
  }
  const payload = asObject(target, action.value);
  // Split the payload by what it targets: HTTP-method fields route to
  // operation overrides (so existing fields on the operation are preserved
  // by applyOperationOverride's per-field merge), everything else goes to
  // pathItem (which uses Object.assign and is safe for scalars and the
  // path-level `parameters` array).
  const pathItemFields: Record<string, JsonValue | undefined> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (HTTP_METHOD_SET.has(k as HttpMethod)) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new Error(
          `overlay action for target ${JSON.stringify(target)} has non-object payload for HTTP method \`${k}\``,
        );
      }
      const opOverride = mergeOperationOverride(
        getOperationOverride(overlay, pathKey, k as HttpMethod),
        v as Record<string, JsonValue | undefined>,
      );
      setOperationOverride(overlay, pathKey, k as HttpMethod, opOverride);
    } else {
      setSpecKey(pathItemFields, k, v);
    }
  }
  if (Object.keys(pathItemFields).length === 0) return;
  const overrides = ensureOverrides(overlay);
  const existing = getOwn(overrides, pathKey) ?? {};
  setSpecKey(overrides, pathKey, {
    ...existing,
    pathItem: { ...existing.pathItem, ...pathItemFields },
  });
}

function applyOperationLevel(
  target: string,
  pathKey: string,
  method: HttpMethod | "*",
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (action.kind === "remove") {
    throw new UnrecognisedTargetError(
      target,
      "`remove` on an operation has no typed-verb equivalent; remove the parent path instead",
    );
  }
  const payload = asObject(target, action.value);
  const opOverride: OperationOverride = mergeOperationOverride(
    getOperationOverride(overlay, pathKey, method),
    payload,
  );
  setOperationOverride(overlay, pathKey, method, opOverride);
}

/**
 * Merge a spec-format payload into an existing OperationOverride. The
 * spec's update payload is a partial OperationObject (operationId,
 * tags, summary, responses, ...); each recognised OAS field maps onto
 * the typed verb that gives the spec's deep-merge semantics. Unknown
 * fields (other than `x-*`) error so the action isn't silently
 * dropped at apply time.
 */
function mergeOperationOverride(
  base: OperationOverride,
  payload: Record<string, JsonValue | undefined>,
): OperationOverride {
  const next: OperationOverride = { ...base };
  for (const [k, v] of Object.entries(payload)) {
    switch (k) {
      case "tags": {
        if (!Array.isArray(v)) {
          throw new Error(`overlay action payload field \`tags\` must be an array`);
        }
        next.addTags = [...(next.addTags ?? []), ...(v as string[])];
        break;
      }
      case "security": {
        if (!Array.isArray(v)) {
          throw new Error(`overlay action payload field \`security\` must be an array`);
        }
        next.addSecurity = [...(next.addSecurity ?? []), ...(v as Record<string, string[]>[])];
        break;
      }
      case "callbacks": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new Error(`overlay action payload field \`callbacks\` must be an object`);
        }
        next.callbacks = { ...next.callbacks, ...(v as Record<string, never>) };
        break;
      }
      case "responses": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new Error(`overlay action payload field \`responses\` must be an object`);
        }
        // Per-status patches via patchResponses (in-place merge), so
        // existing description/headers/content on each status survive
        // a partial update.
        const patches = next.patchResponses ?? {};
        for (const [status, r] of Object.entries(v as Record<string, JsonValue | undefined>)) {
          if (typeof r !== "object" || r === null || Array.isArray(r)) {
            throw new Error(
              `overlay action payload field \`responses["${status}"]\` must be an object`,
            );
          }
          setSpecKey(
            patches,
            status,
            mergeResponseOverride(
              getOwn(patches, status) ?? {},
              r as Record<string, JsonValue | undefined>,
            ),
          );
        }
        next.patchResponses = patches;
        break;
      }
      case "servers":
      case "externalDocs":
      case "requestBody": {
        // Scalar / atomic fields with a 1:1 typed verb. Last write wins.
        (next as Record<string, unknown>)[k] = v as JsonValue;
        break;
      }
      case "operationId":
      case "summary":
      case "description":
      case "deprecated": {
        // OperationOverride scalar pass-through; applied verbatim by
        // applyOperationOverride.
        (next as Record<string, unknown>)[k] = v as JsonValue;
        break;
      }
      case "parameters": {
        throw new Error(
          `overlay action targeting an operation cannot carry \`parameters\` directly; target the leaf path instead`,
        );
      }
      default: {
        if (k.startsWith("x-")) {
          next.setExtensions = {
            ...next.setExtensions,
            [k]: v as JsonValue,
          };
          break;
        }
        throw new Error(
          `overlay action payload field \`${k}\` is not supported for operation targets`,
        );
      }
    }
  }
  return next;
}

function mergeResponseOverride(
  base: ResponseOverride,
  payload: Record<string, JsonValue | undefined>,
): ResponseOverride {
  const next: ResponseOverride = { ...base };
  for (const [k, v] of Object.entries(payload)) {
    switch (k) {
      case "description": {
        if (typeof v !== "string") {
          throw new Error(`overlay action payload field \`description\` must be a string`);
        }
        next.description = v;
        break;
      }
      case "headers": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new Error(`overlay action payload field \`headers\` must be an object`);
        }
        next.headers = {
          ...next.headers,
          ...(v as Record<string, never>),
        };
        break;
      }
      case "content": {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new Error(`overlay action payload field \`content\` must be an object`);
        }
        next.content = {
          ...next.content,
          ...(v as Record<string, never>),
        };
        break;
      }
      default: {
        throw new Error(
          `overlay action payload field \`responses[<status>].${k}\` is not supported`,
        );
      }
    }
  }
  return next;
}

function applyOperationParameters(
  target: string,
  pathKey: string,
  method: HttpMethod | "*",
  rest: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  // Recognised forms:
  //   .parameters[?(@.name=='X' && @.in=='Y')]
  if (rest.length !== 1 || rest[0]?.kind !== "filter") {
    throw new UnrecognisedTargetError(
      target,
      "only `.parameters[?(@.name=='X' && @.in=='Y')]` is recognised",
    );
  }
  const filter = rest[0].expr;
  if (filter.kind !== "field-eq-and") {
    throw new UnrecognisedTargetError(
      target,
      "parameter filter must be `@.name=='X' && @.in=='Y'`",
    );
  }
  const fields = { [filter.a.field]: filter.a.value, [filter.b.field]: filter.b.value };
  const name = fields["name"];
  const inField = fields["in"];
  if (name === undefined || inField === undefined) {
    throw new UnrecognisedTargetError(target, "parameter filter must name `@.name` and `@.in`");
  }

  const opOverride = getOperationOverride(overlay, pathKey, method);
  if (action.kind === "remove") {
    opOverride.removeParameters = [
      ...(opOverride.removeParameters ?? []),
      { name, in: inField as ParameterLocation },
    ];
  } else {
    const payload = asObject(target, action.value);
    const param: ParameterObject = {
      name,
      in: inField as ParameterLocation,
      ...(payload as Omit<ParameterObject, "name" | "in">),
    };
    opOverride.upsertParameters = [...(opOverride.upsertParameters ?? []), param];
  }
  setOperationOverride(overlay, pathKey, method, opOverride);
}

function applyOperationResponses(
  target: string,
  pathKey: string,
  method: HttpMethod | "*",
  rest: PathToken[],
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  // Recognised: `.responses['200']` or `.responses['200']` via dot too.
  if (rest.length !== 1) {
    throw new UnrecognisedTargetError(
      target,
      "only single-status response targets are recognised (no `*`, no deeper paths)",
    );
  }
  const sel = rest[0]!;
  if (sel.kind === "wildcard") {
    throw new UnrecognisedTargetError(
      target,
      "`.responses.*` is not recognised (use one per status)",
    );
  }
  if (sel.kind !== "key" && sel.kind !== "name") {
    throw new UnrecognisedTargetError(target, "expected a status code after `.responses`");
  }
  const status = sel.kind === "key" ? sel.key : sel.name;

  const opOverride = getOperationOverride(overlay, pathKey, method);
  if (action.kind === "remove") {
    opOverride.removeResponses = [...(opOverride.removeResponses ?? []), status];
  } else {
    // patchResponses (in-place merge) so existing fields on the
    // response object (description, headers, content) survive a
    // partial update. Wholesale-replace-per-status would drop them.
    const payload = asObject(target, action.value);
    const patches = opOverride.patchResponses ?? {};
    setSpecKey(patches, status, mergeResponseOverride(getOwn(patches, status) ?? {}, payload));
    opOverride.patchResponses = patches;
  }
  setOperationOverride(overlay, pathKey, method, opOverride);
}

function applyModifyOperations(
  target: string,
  pathKey: string,
  pathSel: PathToken,
  filter: FilterExpr,
  action: NormalizedAction,
  overlay: SpecOverlay,
): void {
  if (action.kind === "remove") {
    throw new UnrecognisedTargetError(
      target,
      "`remove` on `$.paths.*.*[?(...)]` has no typed-verb equivalent",
    );
  }
  if (filter.kind !== "field-contains" || filter.field !== "tags") {
    throw new UnrecognisedTargetError(
      target,
      "only `[?(@.tags contains 'X')]` is recognised at the all-operations level",
    );
  }
  const payload = asObject(target, action.value);
  const entry: ModifyOperationsEntry = {
    where: { tags: [filter.value] },
    apply: payloadToOperationOverride(target, payload),
  };
  // Path filter: if the user supplied a literal path key, narrow further.
  if (pathSel.kind === "key" || pathSel.kind === "name") {
    entry.where = { ...entry.where, pathPattern: new RegExp(`^${escapeRegex(pathKey)}$`) };
  }
  overlay.modifyOperations = [...(overlay.modifyOperations ?? []), entry];
}

function payloadToOperationOverride(
  _target: string,
  payload: Record<string, JsonValue | undefined>,
): OperationOverride {
  // Reuse the operation-level merger against an empty base.
  return mergeOperationOverride({}, payload);
}

// ----------------------------------------------------------- overlay helpers

function ensureOverrides(overlay: SpecOverlay): Record<string, PathOverride> {
  overlay.overrides ??= {};
  return overlay.overrides;
}

/**
 * The path override for `pathKey`, created if absent, with its
 * `operations` map present.
 *
 * `pathKey` is a path template taken from the overlay's target string,
 * so both the read and the write go through the own-key helpers: `??=`
 * on a raw index reads `Object.prototype` for `__proto__`, finds it
 * non-nullish, assigns nothing, and then writes `operations` onto the
 * prototype every object in the process shares.
 */
function ensurePathOverride(overlay: SpecOverlay, pathKey: string): PathOverride {
  const overrides = ensureOverrides(overlay);
  let pathOverride = getOwn(overrides, pathKey);
  if (pathOverride === undefined) {
    pathOverride = {};
    setSpecKey(overrides, pathKey, pathOverride);
  }
  pathOverride.operations ??= {};
  return pathOverride;
}

function getOperationOverride(
  overlay: SpecOverlay,
  pathKey: string,
  method: HttpMethod | "*",
): OperationOverride {
  const ops = ensurePathOverride(overlay, pathKey).operations as Record<string, OperationOverride>;
  ops[method] ??= {};
  return ops[method];
}

function setOperationOverride(
  overlay: SpecOverlay,
  pathKey: string,
  method: HttpMethod | "*",
  op: OperationOverride,
): void {
  const ops = ensurePathOverride(overlay, pathKey).operations as Record<string, OperationOverride>;
  ops[method] = op;
}

// --------------------------------------------------------- payload helpers

function asObject(
  target: string,
  value: JsonValue | undefined,
): Record<string, JsonValue | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `overlay action for target ${JSON.stringify(target)} expects an object \`update\` payload`,
    );
  }
  return value as Record<string, JsonValue | undefined>;
}

/**
 * Normalize an array-target's `update` payload into a list of entries
 * to append. Per OpenAPI Overlay 1.0, when `target` selects an array
 * the `update` value is a single entry; the spec uses
 * `target: $.paths.*.get.parameters` with a single parameter object as
 * `update`. We also accept an array of entries for callers that batch.
 */
function asEntries(target: string, value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) return [value];
  throw new Error(
    `overlay action for target ${JSON.stringify(target)} expects an object or array of objects as \`update\``,
  );
}

function expectFieldEq(target: string, filter: FilterExpr, field: string): string {
  if (filter.kind !== "field-eq" || filter.field !== field) {
    throw new UnrecognisedTargetError(target, `expected filter \`@.${field}=='...'\``);
  }
  return filter.value;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
