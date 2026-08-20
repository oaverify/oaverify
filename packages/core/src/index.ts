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
  formatLeafDetail,
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

export {
  escapePointerSegment,
  pointerFromFragment,
  pointerFromRefFragment,
  resolveJsonPointer,
} from "./json-pointer.js";

export {
  detectOpenAPIVersion,
  classifyUnknownVersion,
  type OpenAPIVersion,
  type UnknownVersionReason,
} from "./version.js";

export { HTTP_METHODS } from "./types.js";

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
// The subschema-position tables are deliberately absent from this
// entry. They are `@internal`, and everything here reaches
// `@oaverify/core`'s public surface, so exporting them put four
// compiler-shaped tables in the published `.d.ts` under a tag saying
// they are unsupported. Internal consumers import
// `@oaverify/internal-core/subschema-positions`; plugin authors get them
// from `@oaverify/core/schema/internals`, which is outside semver and
// where the docs already point. Same arrangement as
// `./prototype-properties`.
export { followsRef, refablePositionsFor, refPositionFor } from "./ref-positions.js";
export type { RefNodeKind, RefPosition } from "./ref-positions.js";
export { getOwn, hasLowercaseKeys, markLowercaseKeys, setSpecKey } from "./own-key.js";
export { normalizeFormat } from "./format-definition.js";
export type { FormatDefinition, NormalizedFormat } from "./format-definition.js";
