export {
  BUILT_IN_ERROR_CODES,
  SELF_LOCATING_ERROR_CODES,
  collectLeaves,
  createBranchError,
  createError,
  createLeafError,
  joinPath,
  walkErrors,
  type BuiltInErrorParams,
  type CreateErrorParams,
  type CustomErrorParams,
  type ErrorParams,
  type ErrorParamsFor,
  type PathSegment,
  type RejectionReason,
  type ValidationError,
} from "./errors.js";

export {
  countErrors,
  formatSummary,
  formatText,
  toJsonObject,
  type FormatOptions,
  type FormatSummaryOptions,
  type FormatSummarySelect,
} from "./format.js";

export {
  formatError,
  isOutputFormat,
  KNOWN_OUTPUT_FORMATS,
  type ErrorRenderer,
  type OutputFormat,
} from "./format-output.js";

export {
  collectIssues,
  toProblemDetails,
  type ProblemDetails,
  type ProblemDetailsOptions,
  type ValidationIssue,
} from "./problem-details.js";

export {
  allowHeaderFor,
  DEFAULT_HTTP_STATUS_MAP,
  httpStatusFor,
  type HttpStatusMap,
} from "./http-status.js";

export { resolveJsonPointer } from "./json-pointer.js";

export {
  detectOpenAPIVersion,
  classifyUnknownVersion,
  type OpenAPIVersion,
  type UnknownVersionReason,
} from "./version.js";

export type {
  CallbackObject,
  ComponentsObject,
  DiscriminatorObject,
  ExampleObject,
  ExternalDocumentationObject,
  HeaderObject,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  InfoObject,
  JsonValue,
  LinkObject,
  MediaTypeObject,
  OpenAPIDocument,
  OperationObject,
  ParameterLocation,
  ParameterObject,
  ParameterStyle,
  PathItem,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SchemaOrBoolean,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from "./types.js";
export {
  isSubschemaKey,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "./subschema-positions.js";
export { getOwn, setSpecKey } from "./own-key.js";
