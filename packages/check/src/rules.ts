/**
 * Per-rule metadata: what each code means, stated once.
 *
 * A finding's `message` is the fact about one occurrence. Anything true
 * of the rule whatever the occurrence belongs here instead, because the
 * consumers have a slot for it and the message does not: SARIF has
 * `reportingDescriptor.fullDescription`, LSP has
 * `Diagnostic.codeDescription`, and a terminal has a rule the reader
 * can look up. Repeating a rule's explanation in every finding of that
 * rule is what #773 measured: `format-not-validated` carried ~349
 * characters of it in each of sixteen findings.
 *
 * {@link CheckRule.title} is required for every code, so a new code
 * cannot ship describing itself as its own id; the `Record<CheckCode,
 * ...>` annotation below is what enforces that at compile time.
 * {@link CheckRule.explanation} is optional, because most rules have
 * nothing to say beyond their title: `unused-component`'s message
 * ("components.schemas.Foo is declared but no operation reaches it")
 * is complete on its own, and inventing rule prose for it would add
 * words without adding facts.
 *
 * @packageDocumentation
 */

import type { CheckCode } from "./codes.js";

/**
 * What one finding code means, independent of any occurrence.
 *
 * @public
 */
export interface CheckRule {
  /**
   * One line naming the defect, in the same voice a finding message
   * uses. Shown as SARIF's `shortDescription` and as a rule label in an
   * editor, so it is read without an occurrence beside it.
   */
  title: string;
  /**
   * Why the rule exists, what makes the defect legal or not, and what
   * to do about it. Absent where the title and the message already say
   * everything.
   *
   * Written to be read once rather than once per finding, so it may run
   * to several sentences where a message may not.
   */
  explanation?: string;
}

/**
 * Every code, with its rule metadata.
 *
 * Annotated rather than `satisfies`, so omitting a code from
 * {@link CheckCode} is a typecheck error here. That is the same drift
 * guard `codes.ts` applies to the code lists themselves, one link
 * further along: a keyword declares a code, `codes.ts` pins the list to
 * it, and this pins a description to the list.
 *
 * @public
 */
export const CHECK_RULES: Record<CheckCode, CheckRule> = {
  // hygiene
  "unused-component": { title: "a declared component no operation reaches" },
  "unused-tag": { title: "a declared tag no operation references" },
  "unreachable-defs": { title: "a $defs entry no $ref references" },
  "path-param-undeclared": { title: "a path template placeholder with no parameter declaring it" },
  "path-param-unused": { title: "a path parameter the path template does not name" },
  "path-template-malformed": { title: "a path template that does not parse" },
  "unserved-parameter-location": {
    title: "a parameter location this validator cannot read a value for",
  },

  // schema
  "partial-feature": { title: "a keyword this validator supports only in part" },
  "unknown-keyword": { title: "a keyword no dialect in use defines" },
  "annotation-value-type": { title: "an annotation keyword holding the wrong type" },
  "silent-rewrite/ref-siblings-oas30": {
    title: "keywords beside a $ref that OpenAPI 3.0 discards",
  },
  "silent-rewrite/required-not-in-properties": {
    title: "a required property name nothing at that position can produce",
  },
  "silent-rewrite/redundant-composition-branches": {
    title: "composition branches that assert the same thing",
  },
  "silent-rewrite/discriminator-unroutable": {
    title: "a discriminator whose branches cannot be told apart",
  },
  "silent-rewrite/pattern-not-unicode-mode": {
    title: "a pattern whose meaning changes outside Unicode mode",
  },
  "unsatisfiable/pattern-length": {
    title: "a pattern and a length bound no string satisfies together",
  },
  "unsatisfiable/enum-member-type": { title: "an enum member the declared type can never admit" },
  "format-not-validated": {
    title: "a format name with no validator behind it",
    explanation:
      'Values carrying this format are checked against "type" alone. That is ' +
      "legal: support for any given format is optional, and a validator may " +
      'fall back to "type" for one it does not recognise. Register a validator ' +
      "for the name through the formats option to enforce it, or read this " +
      "finding as confirmation that the name is documentation rather than a " +
      "constraint.",
  },

  // conformance
  false: { title: "a position the meta-schema forbids outright" },
  type: { title: "a field with the wrong JSON type" },
  const: { title: "a field that must equal a fixed value" },
  enum: { title: "a field outside its allowed values" },
  minimum: { title: "a number below its minimum" },
  maximum: { title: "a number above its maximum" },
  multipleOf: { title: "a number that is not a multiple of its divisor" },
  minLength: { title: "a string shorter than its minimum length" },
  maxLength: { title: "a string longer than its maximum length" },
  pattern: { title: "a string that does not match its required pattern" },
  format: { title: "a string that does not match its declared format" },
  minItems: { title: "an array with too few items" },
  maxItems: { title: "an array with too many items" },
  uniqueItems: { title: "an array with repeated items where each must be distinct" },
  minProperties: { title: "an object with too few properties" },
  maxProperties: { title: "an object with too many properties" },
  required: { title: "a required field that is missing" },
  items: { title: "an array item the item schema rejects" },
  contains: { title: "an array with no item the contains schema accepts" },
  maxContains: { title: "an array with more matching items than contains permits" },
  additionalProperties: { title: "a property the schema does not allow here" },
  unevaluatedProperties: { title: "a property no branch of the schema evaluated" },
  unevaluatedItems: { title: "an array item no branch of the schema evaluated" },
  not: { title: "a value the not schema forbids" },
  allOf: { title: "a value at least one allOf branch rejects" },
  anyOf: { title: "a value every anyOf branch rejects" },
  oneOf: { title: "a value that does not match exactly one oneOf branch" },
  schema: { title: "a value the schema rejects" },
  discriminator: { title: "a value whose discriminator names no branch" },
  dependentRequired: { title: "a property present without the properties it requires" },
  dependencies: { title: "a property present without the properties it requires" },
  depth: { title: "a value nested deeper than the configured limit" },

  // examples
  "example-invalid": {
    title: "an example the schema it illustrates rejects",
    explanation:
      "Every example in the document is validated against the schema it sits " +
      "in. An example reached through a $ref is checked once at the component " +
      "that declares it rather than at each use site, so one finding can stand " +
      "for many references. The message names up to five distinct reasons and " +
      "then counts the rest; the finding's reasons field carries every " +
      "rejected leaf, uncapped and unabbreviated.",
  },
  "example-uncheckable": {
    title: "an example nothing is known about either way",
    explanation:
      "Validating this example was attempted and did not produce a verdict: " +
      "either compiling or running the schema threw, or executing it was " +
      "refused because the schema reaches a pattern flagged as unsafe to run " +
      "against non-matching input. The example is neither accepted nor " +
      "rejected. Fixing whatever the message names restores a real verdict " +
      "for it.",
  },

  // redos
  "ambiguous-pattern": {
    title: "a pattern whose matching can blow up on crafted input",
    explanation:
      "A backtracking engine can be made to explore every way an ambiguous " +
      "pattern matches, so an input crafted against it can take superlinear " +
      "time. Whether a given pattern actually costs that depends on the engine " +
      "running it, which is not known here. Rewrite the pattern to remove the " +
      "ambiguity, or compile patterns with a linear-time engine through the " +
      "regexCompiler option.",
  },

  // malformed
  "malformed-schema": { title: "a schema that could not be compiled" },
};

/**
 * The rule for a code, or nothing.
 *
 * Nothing rather than a synthesized placeholder, because
 * {@link CheckFinding.code} is widened with `string` so a caller pinned
 * at one version meets codes from a later one. A consumer that renders
 * a missing rule as the bare code is doing the honest thing; one handed
 * an invented title could not tell it apart from a real one.
 *
 * @public
 */
export function ruleFor(code: string): CheckRule | undefined {
  return Object.prototype.hasOwnProperty.call(CHECK_RULES, code)
    ? CHECK_RULES[code as CheckCode]
    : undefined;
}
