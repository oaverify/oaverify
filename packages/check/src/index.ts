/**
 * `@oaverify/check`: the composed OpenAPI document check.
 *
 * `oaverify check` runs several passes over a resolved spec and grades
 * what they find. This package is that logic, so a build script or a
 * test can reach it without shelling out to the CLI and parsing JSON.
 *
 * The CLI is a renderer over this package. Anything it prints, a caller
 * here can compute.
 *
 * @packageDocumentation
 */

export {
  CHECK_CODES,
  CHECK_FAMILIES,
  CODES_BY_CLASS,
  CONFORMANCE_CODES,
  EXAMPLES_CODES,
  HYGIENE_CODES,
  MALFORMED_CODES,
  REDOS_CODES,
  SCHEMA_CODES,
  type CheckCode,
} from "./codes.js";
export { CheckAbortedError, checkSpec, type CheckOptions } from "./check.js";
export { parseFindingKey, type FindingKey, type FindingKeyResult } from "./finding-key.js";
export { checkDocumentFormats, KNOWN_FORMATS } from "./format-check.js";
export { checkDocumentRedos } from "./redos-check.js";
export { renderSarif } from "./sarif.js";
export { spanFor, spanRequestsFor, spanTargetFor } from "./span-target.js";
export { applySkip, parseSkipKeys, SkipKeyError, type SkipReportEntry } from "./skip.js";
export {
  FindingTermError,
  FULL_SELECTION,
  parseFindingTerms,
  resolveFindingSelection,
  selectionForClasses,
  SELECTABLE_CODES,
  type FindingSelection,
  type FindingTerm,
  type TermReport,
} from "./selection.js";
export {
  defaultSeverityFor,
  DEFAULT_SEVERITY,
  EMPTY_SEVERITY_MAP,
  parseSeverityMap,
  severityFor,
  SeverityMapError,
  type SeverityMap,
} from "./severity.js";
export {
  CHECK_CLASSES,
  CHECK_SEVERITIES,
  type CheckClass,
  type CheckFinding,
  type CheckSeverity,
  type FindingAnchor,
  type FindingTarget,
} from "./finding.js";
