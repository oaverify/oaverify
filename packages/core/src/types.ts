/**
 * Shared structural types for OpenAPI 3.1 documents, JSON Schema objects, and
 * HTTP request/response envelopes. These types are intentionally permissive:
 * they describe the shape {@link @oaverify/internal-spec} and {@link @oaverify/internal-validator}
 * produce/consume, not a fully-checked schema.
 */

/**
 * A JSON value, as accepted/emitted by JSON.parse / JSON.stringify.
 *
 * @public
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON Schema reference object (`{ "$ref": "..." }`).
 *
 * @public
 */
export interface ReferenceObject {
  $ref: string;
  summary?: string;
  description?: string;
}

/**
 * A JSON Schema 2020-12 object. This is a loose structural type: fields are
 * all optional and the compiler validates them.
 *
 * @remarks
 * JSON Schema 2020-12 permits a boolean schema (`true` / `false`) in place of
 * a schema object. Functions that accept schemas use `SchemaOrBoolean`.
 *
 * @public
 */
export interface SchemaObject {
  $id?: string;
  $schema?: string;
  $ref?: string;
  $anchor?: string;
  $dynamicRef?: string;
  $dynamicAnchor?: string;
  $defs?: Record<string, SchemaOrBoolean>;
  $comment?: string;

  type?: string | string[];
  enum?: JsonValue[];
  const?: JsonValue;

  multipleOf?: number;
  maximum?: number;
  /**
   * In JSON Schema 2020-12 (OpenAPI 3.1/3.2): a number, and stands alone.
   * In OpenAPI 3.0: a boolean that modifies the sibling {@link SchemaObject.maximum}.
   * The dialect the compiler runs under decides which semantics apply.
   */
  exclusiveMaximum?: number | boolean;
  minimum?: number;
  /**
   * In JSON Schema 2020-12 (OpenAPI 3.1/3.2): a number, and stands alone.
   * In OpenAPI 3.0: a boolean that modifies the sibling {@link SchemaObject.minimum}.
   */
  exclusiveMinimum?: number | boolean;
  /**
   * OpenAPI 3.0 only. Combined with `type`, means "type OR null".
   * In 3.1+ use `type: ["…", "null"]` instead. Ignored outside the
   * 3.0 dialect.
   */
  nullable?: boolean;

  maxLength?: number;
  minLength?: number;
  pattern?: string;
  format?: string;

  items?: SchemaOrBoolean;
  prefixItems?: SchemaOrBoolean[];
  contains?: SchemaOrBoolean;
  maxContains?: number;
  minContains?: number;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  unevaluatedItems?: SchemaOrBoolean;

  properties?: Record<string, SchemaOrBoolean>;
  patternProperties?: Record<string, SchemaOrBoolean>;
  additionalProperties?: SchemaOrBoolean;
  propertyNames?: SchemaOrBoolean;
  required?: string[];
  maxProperties?: number;
  minProperties?: number;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, SchemaOrBoolean>;
  unevaluatedProperties?: SchemaOrBoolean;

  allOf?: SchemaOrBoolean[];
  anyOf?: SchemaOrBoolean[];
  oneOf?: SchemaOrBoolean[];
  not?: SchemaOrBoolean;
  if?: SchemaOrBoolean;
  then?: SchemaOrBoolean;
  else?: SchemaOrBoolean;

  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;

  discriminator?: DiscriminatorObject;

  [extension: `x-${string}`]: JsonValue | undefined;
}

/**
 * A schema value: either a schema object or a boolean (`true` accepts all,
 * `false` rejects all).
 *
 * @public
 */
export type SchemaOrBoolean = SchemaObject | boolean;

/**
 * OpenAPI 3.1 discriminator object.
 *
 * @public
 */
export interface DiscriminatorObject {
  propertyName: string;
  mapping?: Record<string, string>;
}

/**
 * Top-level OpenAPI document shape. Loose enough to accept 3.0, 3.1,
 * and 3.2: fields only present on newer versions (`webhooks`,
 * `jsonSchemaDialect`) are optional; the `openapi` string discriminates
 * at validator-construction time via
 * {@link detectOpenAPIVersion | detectOpenAPIVersion}.
 *
 * @public
 */
export interface OpenAPIDocument {
  openapi: string;
  info: InfoObject;
  servers?: ServerObject[];
  paths?: Record<string, PathItem>;
  components?: ComponentsObject;
  tags?: TagObject[];
  /**
   * Top-level security requirement. Each element is an alternative
   * (OR-connected); schemes within an element are AND-connected. Empty
   * array means "no authentication required"; operations can override
   * via their own `security` field. See
   * {@link SecurityRequirementObject}.
   */
  security?: SecurityRequirementObject[];
  /** 3.1+: declared webhooks. Absent in 3.0. */
  webhooks?: Record<string, PathItem | ReferenceObject>;
  /** 3.1+: overrides the default schema dialect URI. Absent in 3.0. */
  jsonSchemaDialect?: string;
  [extension: `x-${string}`]: JsonValue | undefined;
}

/**
 * A single security requirement, shared by top-level and operation-level
 * `security` fields. Maps scheme name (keyed into
 * `components.securitySchemes`) to required scopes (empty array for
 * non-OAuth2 schemes).
 *
 * An operation's `security` is an array of these; the operation passes
 * if **any** one of them is satisfied (OR semantics). Within a single
 * requirement, **all** listed schemes must be satisfied (AND).
 *
 * @public
 */
export type SecurityRequirementObject = Record<string, string[]>;

/**
 * A security scheme definition, declared in
 * {@link ComponentsObject.securitySchemes}. Referenced by name from a
 * {@link SecurityRequirementObject}.
 *
 * oaverify's validator performs shape-only checks on `http` (bearer / basic)
 * and `apiKey` schemes; it confirms the request carries the declared
 * credential location and format, but does not verify the credential
 * itself. `oauth2`, `openIdConnect`, and `mutualTLS` are accepted in
 * the spec but not shape-checked at the validator layer; credential
 * verification (and scope checking for oauth2) is the app's
 * responsibility.
 *
 * @public
 */
export interface SecuritySchemeObject {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  /** `http` schemes: e.g. `"bearer"` or `"basic"`. Required on `http`. */
  scheme?: string;
  /** `http` schemes: the token format hint (e.g. `"JWT"`). Informational. */
  bearerFormat?: string;
  /** `apiKey` schemes: the parameter name. Required on `apiKey`. */
  name?: string;
  /** `apiKey` schemes: where the parameter lives. Required on `apiKey`. */
  in?: "header" | "query" | "cookie";
  /** `oauth2` schemes: flow definitions. Not validated at the shape level. */
  flows?: unknown;
  /** `openIdConnect` schemes: discovery URL. Not validated at the shape level. */
  openIdConnectUrl?: string;
}

/**
 * OpenAPI `info` object (metadata).
 *
 * @public
 */
export interface InfoObject {
  title: string;
  version: string;
  description?: string;
  summary?: string;
}

/**
 * OpenAPI `server` entry.
 *
 * @public
 */
export interface ServerObject {
  url: string;
  description?: string;
}

/**
 * OpenAPI `tag` entry.
 *
 * @public
 */
export interface TagObject {
  name: string;
  description?: string;
}

/**
 * OpenAPI `externalDocumentationObject`.
 *
 * @public
 */
export interface ExternalDocumentationObject {
  url: string;
  description?: string;
}

/**
 * OpenAPI `exampleObject`. Either `value` or `externalValue` carries
 * the example data; `summary` / `description` are metadata. Not
 * validated by oaverify today.
 *
 * @public
 */
export interface ExampleObject {
  summary?: string;
  description?: string;
  value?: JsonValue;
  externalValue?: string;
}

/**
 * OpenAPI `linkObject`. The runtime payload (`parameters`, `requestBody`)
 * uses runtime-expression syntax that oaverify does not evaluate today, so
 * those slots are typed loosely.
 *
 * @public
 */
export interface LinkObject {
  operationRef?: string;
  operationId?: string;
  parameters?: Record<string, JsonValue | undefined>;
  requestBody?: JsonValue;
  description?: string;
  server?: ServerObject;
}

/**
 * OpenAPI `callbackObject`: a map of runtime-expression strings to the
 * {@link PathItem} that should be invoked when the expression evaluates.
 * The expression dialect is documented in the OAS spec; oaverify does not
 * evaluate it.
 *
 * @public
 */
export type CallbackObject = Record<string, PathItem | ReferenceObject>;

/**
 * OpenAPI reusable `components` container.
 *
 * @public
 */
export interface ComponentsObject {
  schemas?: Record<string, SchemaOrBoolean>;
  parameters?: Record<string, ParameterObject | ReferenceObject>;
  requestBodies?: Record<string, RequestBodyObject | ReferenceObject>;
  responses?: Record<string, ResponseObject | ReferenceObject>;
  headers?: Record<string, HeaderObject | ReferenceObject>;
  securitySchemes?: Record<string, SecuritySchemeObject | ReferenceObject>;
  links?: Record<string, LinkObject | ReferenceObject>;
  callbacks?: Record<string, CallbackObject | ReferenceObject>;
  examples?: Record<string, ExampleObject | ReferenceObject>;
}

/**
 * OpenAPI `pathItem`: the collection of operations available at a path.
 * `query` is new in 3.2 (the HTTP QUERY method for read-side requests
 * with a body). Older specs just don't set it.
 *
 * @public
 */
export interface PathItem {
  summary?: string;
  description?: string;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
  /** 3.2+: HTTP QUERY method. */
  query?: OperationObject;
  parameters?: (ParameterObject | ReferenceObject)[];
}

/**
 * The HTTP method names that can appear on a {@link PathItem}. `query`
 * is added in OpenAPI 3.2; earlier documents may not use it. Routing
 * is case-insensitive; validators lower-case the request's method
 * before lookup.
 *
 * @public
 */
export type HttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch"
  | "trace"
  | "query";

/**
 * OpenAPI `operationObject` (a single method on a path).
 *
 * @public
 */
export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: (ParameterObject | ReferenceObject)[];
  requestBody?: RequestBodyObject | ReferenceObject;
  responses?: Record<string, ResponseObject | ReferenceObject>;
  /**
   * Per-operation security requirement. Overrides the document-level
   * {@link OpenAPIDocument.security}. An explicit empty array opts the
   * operation out of the top-level requirement. See
   * {@link SecurityRequirementObject}.
   */
  security?: SecurityRequirementObject[];
  /** Per-operation server overrides. Overrides the document-level servers. */
  servers?: ServerObject[];
  /** Per-operation callbacks, keyed by callback name. */
  callbacks?: Record<string, CallbackObject | ReferenceObject>;
  /** Additional external documentation. */
  externalDocs?: ExternalDocumentationObject;
  deprecated?: boolean;
}

/**
 * OpenAPI parameter location.
 *
 * @public
 */
export type ParameterLocation = "path" | "query" | "header" | "cookie";

/**
 * OpenAPI parameter serialization style.
 *
 * @public
 */
export type ParameterStyle =
  | "matrix"
  | "label"
  | "simple"
  | "form"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

/**
 * OpenAPI `parameterObject`.
 *
 * @public
 */
export interface ParameterObject {
  name: string;
  in: ParameterLocation;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  /**
   * Query-only. When `true`, an empty value (`?flag=`) is legitimate and
   * exempted from schema validation. OpenAPI 3.1 §4.8.12.1.
   */
  allowEmptyValue?: boolean;
  style?: ParameterStyle;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: SchemaOrBoolean;
  content?: Record<string, MediaTypeObject>;
  example?: JsonValue;
  examples?: Record<string, JsonValue>;
}

/**
 * OpenAPI `requestBodyObject`.
 *
 * @public
 */
export interface RequestBodyObject {
  description?: string;
  content: Record<string, MediaTypeObject>;
  required?: boolean;
}

/**
 * OpenAPI `responseObject`.
 *
 * @public
 */
export interface ResponseObject {
  description?: string;
  headers?: Record<string, HeaderObject | ReferenceObject>;
  content?: Record<string, MediaTypeObject>;
}

/**
 * OpenAPI `mediaTypeObject`.
 *
 * @public
 */
export interface MediaTypeObject {
  schema?: SchemaOrBoolean;
  example?: JsonValue;
  examples?: Record<string, JsonValue>;
}

/**
 * OpenAPI `headerObject` (like a parameter, but with `in` fixed to `header`).
 *
 * @public
 */
export interface HeaderObject {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  style?: ParameterStyle;
  explode?: boolean;
  schema?: SchemaOrBoolean;
  content?: Record<string, MediaTypeObject>;
}

/**
 * An abstract HTTP request used by the validator. Values are pre-parsed
 * where convenient (e.g. `query` is a record, `headers` is a record); raw
 * strings are still accepted for parameter deserialization.
 *
 * @public
 */
export interface HttpRequest {
  method: string;
  /**
   * The request path (`"/pets/42"`). A query string left in it
   * (`"/pets?limit=5"`) is parsed into {@link HttpRequest.query} when
   * that field is unset, since a combined string is what every HTTP
   * framework hands the caller. When both are present the explicit
   * `query` field wins and the embedded string is ignored, so there is
   * one deliberate source rather than two that can disagree.
   */
  path: string;
  query?: Record<string, string | string[]>;
  /**
   * HTTP headers. Header names are matched case-insensitively; adapter
   * helpers normalize keys to lowercase at the framework boundary for the
   * fastest lookup path.
   */
  headers?: Record<string, string | string[]>;
  cookies?: Record<string, string>;
  /**
   * The request's media type, `"; charset=utf-8"` and all. Matched
   * against the operation's `requestBody.content` keys.
   *
   * **The only place the validator looks for the media type.** It is not
   * read from {@link HttpRequest.headers}, even though `Content-Type` is
   * a header and even though header *parameters* are matched there
   * case-insensitively. One explicit field beats two sources that can
   * disagree, and the adapters all populate it
   * (`req.get("content-type")`, `request.headers.get("content-type")`).
   *
   * A hand-built request therefore has to set it. Filling in
   * `headers["content-type"]` and leaving this unset yields a
   * `content-type` error that says so.
   */
  contentType?: string;
  /**
   * Already-parsed request body. Typed as `unknown` because the shape
   * depends on the `Content-Type` and the spec: JSON gives a plain
   * object / array / primitive; multipart bodies arrive as
   * `{ [fieldname]: string | Uint8Array }`; `application/octet-stream`
   * as raw bytes. The validator's `format: "binary"` body-schema
   * bypass accepts `Buffer` / `Uint8Array` for fields declared that way.
   *
   * Only `undefined` means "no body was sent". `null` is a value: it is
   * what `JSON.parse("null")` yields, so it reaches the schema and is
   * accepted or rejected on its merits. A caller that means "absent"
   * has to leave this unset rather than pass `null`; every shipped
   * adapter does. The same rule governs {@link HttpResponse.body}.
   */
  body?: unknown;
  rawBody?: string | undefined;
}

/**
 * An abstract HTTP response used by the validator.
 *
 * @public
 */
export interface HttpResponse {
  status: number;
  /**
   * HTTP response headers. Header names are matched case-insensitively;
   * adapter helpers normalize keys to lowercase at the framework boundary
   * for the fastest lookup path.
   */
  headers?: Record<string, string | string[]>;
  /** See {@link HttpRequest.contentType}: this is not read from {@link HttpResponse.headers} either. */
  contentType?: string;
  /** See {@link HttpRequest.body}. */
  body?: unknown;
  rawBody?: string | undefined;
}
