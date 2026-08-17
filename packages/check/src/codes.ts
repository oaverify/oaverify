/**
 * Every finding code `check` can emit, so `--severity` has something to
 * validate a code or `family/*` key against (#632).
 *
 * A mirror of codes the emitting passes own. Where they declare a union,
 * the array is pinned to it and drift is a typecheck error; the three
 * single-literal classes are hand-written and covered by
 * `test/codes.test.ts`.
 *
 * @packageDocumentation
 */

import type { BuiltInErrorParams } from "@oaverify/internal-core";
import type { SchemaLintIssue } from "@oaverify/internal-schema";
import type { SpecHygieneIssue } from "@oaverify/internal-spec";

/** Union members the array omits. `satisfies` covers the other direction. */
type Missing<Union extends string, Listed extends string> = Exclude<Union, Listed>;

/** Schema-class codes. */
export const SCHEMA_CODES = [
  "partial-feature",
  "unknown-keyword",
  "annotation-value-type",
  "silent-rewrite/ref-siblings-oas30",
  "silent-rewrite/required-not-in-properties",
  "silent-rewrite/redundant-composition-branches",
  "silent-rewrite/discriminator-unroutable",
  "silent-rewrite/pattern-not-unicode-mode",
  "unsatisfiable/pattern-length",
  "unsatisfiable/enum-member-type",
] as const satisfies readonly SchemaLintIssue["code"][];
// Reads as: no SchemaLintIssue code is missing from the array above.
const _schemaComplete: Missing<SchemaLintIssue["code"], (typeof SCHEMA_CODES)[number]> extends never
  ? true
  : ["missing from SCHEMA_CODES", Missing<SchemaLintIssue["code"], (typeof SCHEMA_CODES)[number]>] =
  true;

/** Hygiene-class codes. */
export const HYGIENE_CODES = [
  "unused-component",
  "unused-tag",
  "unreachable-defs",
  "path-param-undeclared",
  "path-param-unused",
  "path-template-malformed",
] as const satisfies readonly SpecHygieneIssue["code"][];
const _hygieneComplete: Missing<
  SpecHygieneIssue["code"],
  (typeof HYGIENE_CODES)[number]
> extends never
  ? true
  : [
      "missing from HYGIENE_CODES",
      Missing<SpecHygieneIssue["code"], (typeof HYGIENE_CODES)[number]>,
    ] = true;

/**
 * The "HTTP-level wrappers" half of {@link BuiltInErrorParams}, excluded
 * from conformance: that pass validates a document and has no traffic.
 * Subtracting them lets a new keyword's code join the class on its own.
 */
const HTTP_LEVEL_CODES = [
  "route",
  "method",
  "body",
  // Emitted only by the Fetch reader draining a live body, so it can
  // never reach the conformance pass, which has a document and no
  // traffic. Unlike `depth`, which the compiler can raise while
  // validating an example.
  "body-too-large",
  "request",
  "response",
  "content-type",
  "status",
  "path-param",
  "query-param",
  "header-param",
  "cookie-param",
  "security",
] as const satisfies readonly (keyof BuiltInErrorParams)[];

/**
 * Conformance-class codes. `BuiltInErrorParams` is open to declaration
 * merging, but this pass compiles a metaschema the CLI ships, so no
 * consumer keyword can reach it.
 */
type ConformanceCode = Exclude<keyof BuiltInErrorParams, (typeof HTTP_LEVEL_CODES)[number]>;

export const CONFORMANCE_CODES = [
  "false",
  "type",
  "const",
  "enum",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "required",
  "items",
  "contains",
  "maxContains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "schema",
  "discriminator",
  "dependentRequired",
  "dependencies",
  "depth",
] as const satisfies readonly ConformanceCode[];
const _conformanceComplete: Missing<
  ConformanceCode,
  (typeof CONFORMANCE_CODES)[number]
> extends never
  ? true
  : [
      "missing from CONFORMANCE_CODES",
      Missing<ConformanceCode, (typeof CONFORMANCE_CODES)[number]>,
    ] = true;

/** Examples-class codes. */
export const EXAMPLES_CODES = ["example-invalid", "example-uncheckable"] as const;

/** ReDoS-class codes. */
export const REDOS_CODES = ["ambiguous-pattern"] as const;

/** Malformed-class codes. `--severity` refuses these before the lookup. */
export const MALFORMED_CODES = ["malformed-schema"] as const;

/**
 * Schema-class codes the CLI emits itself, so outside the union above.
 * `format-not-validated` is a document walk `check` owns (#644).
 */
const CLI_SCHEMA_CODES = ["format-not-validated"] as const;

/**
 * Hygiene codes `check` owns rather than reading off a
 * `SpecHygieneIssue`, on the same footing as `format-not-validated`
 * above.
 *
 * `unserved-parameter-location` is a fact about this validator, not
 * about the document: the location may be perfectly legal (3.2's
 * `querystring`) and still be one `createValidator` refuses to build
 * for. `@oaverify/internal-spec` has no business knowing that, so the
 * code is emitted here from the rule the validator publishes.
 */
const CHECK_HYGIENE_CODES = ["unserved-parameter-location"] as const;

/** Every code, by the class that emits it. */
export const CODES_BY_CLASS = {
  hygiene: [...HYGIENE_CODES, ...CHECK_HYGIENE_CODES],
  schema: [...SCHEMA_CODES, ...CLI_SCHEMA_CODES],
  conformance: CONFORMANCE_CODES,
  examples: EXAMPLES_CODES,
  redos: REDOS_CODES,
  malformed: MALFORMED_CODES,
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Every code a `check` run can emit, as a type.
 *
 * Derived from {@link CODES_BY_CLASS} rather than written out, so it
 * cannot disagree with the runtime set below. Most of that table is
 * already pinned to the emitting packages' unions in both directions
 * (#641), which makes this the last link in a chain running from a
 * keyword's declared code to what a consumer autocompletes.
 *
 * Consumers meet it through {@link CheckFinding.code}, which widens it
 * with `string` on purpose; the reasoning is on that field.
 *
 * @public
 */
export type CheckCode = (typeof CODES_BY_CLASS)[keyof typeof CODES_BY_CLASS][number];

/** Every code `check` can emit, flattened. */
export const CHECK_CODES: ReadonlySet<string> = new Set(
  Object.values(CODES_BY_CLASS).flatMap((codes) => [...codes]),
);

/** The families that exist, for a `family/*` key to be checked against. */
export const CHECK_FAMILIES: ReadonlySet<string> = new Set(
  [...CHECK_CODES].flatMap((code) => {
    const slash = code.indexOf("/");
    return slash === -1 ? [] : [code.slice(0, slash)];
  }),
);
