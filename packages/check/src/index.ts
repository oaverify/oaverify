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
  CHECK_CLASSES,
  CHECK_SEVERITIES,
  type CheckClass,
  type CheckFinding,
  type CheckSeverity,
  type FindingAnchor,
  type FindingTarget,
} from "./finding.js";
