/**
 * Validate an OpenAPI document against the published meta-schema for the
 * version it declares.
 *
 * This is the pass; {@link ./index.js} holds the documents it runs
 * against. Kept separate so a consumer that only needs dispatch does not
 * pull the compiler, and so the ~100KB of vendored JSON is reached only
 * from here.
 *
 * @packageDocumentation
 */

import type { ValidationError } from "@oaverify/internal-core";
import {
  compileSchema,
  jsonSchemaDialect,
  type CompiledTreeSchema,
} from "@oaverify/internal-schema";

import { metaschemaFor, metaschemaVersionOf, type MetaschemaVersion } from "./index.js";

/**
 * One way in which a document fails the meta-schema for its version.
 *
 * @public
 */
export interface ConformanceIssue {
  /**
   * The failing keyword, straight from the validator: `type`,
   * `required`, `enum`, `unevaluatedProperties`, `oneOf`, `pattern`.
   *
   * Deliberately the JSON Schema keyword rather than a name of our own.
   * A hand-written rule set would say "response-description-required";
   * this pass has no such vocabulary, because it did not write the
   * rules. The keyword plus the location is the whole diagnosis.
   */
  code: string;
  /**
   * RFC 6901 pointer to the offending node in the document, e.g.
   * `/paths/~1things/get/responses/202/description`.
   */
  location: string;
  message: string;
}

/**
 * Outcome of {@link checkDocumentConformance}.
 *
 * @public
 */
export interface ConformanceResult {
  /**
   * The version dispatched on, or `undefined` when the document declares
   * nothing we hold a schema for. `issues` is empty in that case: a
   * document is not non-conformant merely because we cannot check it,
   * and reporting failures against a guessed schema would be worse than
   * reporting nothing.
   */
  version: MetaschemaVersion | undefined;
  issues: readonly ConformanceIssue[];
}

/**
 * Compiled meta-schemas, memoised per version.
 *
 * Compiling is ~14ms and produces ~200KB of source, which is cheap once
 * and wasteful per call. A process checking several documents (a
 * watcher, a test suite) should pay it once.
 */
const compiled = new Map<MetaschemaVersion, CompiledTreeSchema>();

/**
 * Why 3.0 documents get Schema Object findings and 3.1 / 3.2 do not.
 *
 * 3.1 aligned the Schema Object with JSON Schema 2020-12, so its
 * meta-schema stubs the slot (`$dynamicRef` to a swappable dialect) and
 * validates none of it. 3.2 inherits that. 3.0's Schema Object is a
 * bespoke subset, so OpenAPI had to spell out all 35 fields, and this
 * pass therefore checks them.
 *
 * The consequence for callers: on 3.0 this overlaps the compiler's
 * well-formedness pass, and both will have an opinion about
 * `type: Boolean` or an array-valued `items`. On 3.1 / 3.2 they are
 * disjoint.
 *
 * Stubbing 3.0's Schema Object to match, so that all three versions
 * behaved alike, was tried and does not work. 3.0 discriminates a Schema
 * Object from a Reference Object with `oneOf: [Schema, Reference]`, and
 * that only resolves because `Schema` is restrictive enough to reject a
 * `$ref`-bearing object. Replace it with a permissive stub and every
 * `$ref` matches both branches: `twilio.json` went from clean to 220
 * `oneOf ... matched 2` errors, `stripe.json` to 2062. The uniformity
 * would have to be bought by writing a discriminating stub ourselves,
 * which means writing OpenAPI's rules for it, which is the property this
 * whole approach exists to avoid.
 *
 * So the overlap stands, and it is documented rather than engineered
 * around. In practice it costs little: every real-world 3.0 spec in
 * `conformance/real-world` reports no conformance findings at all, so
 * the duplication only appears on a 3.0 document that is already broken
 * in a way the compiler also refuses. Deduplicating properly needs both
 * passes to address findings the same way, which is #517.
 */

function compiledFor(version: MetaschemaVersion): CompiledTreeSchema {
  const already = compiled.get(version);
  if (already !== undefined) return already;
  const validator = compileSchema(metaschemaFor(version) as never, {
    dialect: jsonSchemaDialect,
    output: "tree",
    // The meta-schemas use `unevaluatedProperties` heavily (28 times in
    // 3.1), and evaluated-key tracking disables the budget short-circuit
    // anyway (see CompileState.gated). Asking for everything is honest
    // about what we get rather than implying a cap that cannot hold.
    maxErrors: Infinity,
    label: `OpenAPI ${version} meta-schema`,
  });
  compiled.set(version, validator);
  return validator;
}

/** RFC 6901: `~` becomes `~0`, `/` becomes `~1`. Order matters. */
function pointerSegment(segment: string | number): string {
  return typeof segment === "number"
    ? String(segment)
    : segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function toPointer(path: readonly (string | number)[]): string {
  return path.length === 0 ? "" : `/${path.map(pointerSegment).join("/")}`;
}

/**
 * Flatten an error tree to the nodes worth reporting.
 *
 * The frontier, not every node: a `required` failure nested under an
 * `allOf` is reported once, at the leaf, because the leaf is where the
 * edit is. The intermediate nodes restate the same defect one level
 * further from the fix.
 *
 * A branch node with no children is itself a leaf, and this is where the
 * approach is weakest rather than a bug in this function. `oneOf` that
 * matched too many branches, and `not` that matched when it should not
 * have, report the composition keyword with nothing underneath: there is
 * no failing subschema to point at, because the failure is that they
 * *succeeded*. Those surface as `oneOf` / `not` at the composition's own
 * location, which is honest but much less useful than the `type` and
 * `required` leaves that make up almost all real findings.
 */
function collectLeaves(error: ValidationError, into: ConformanceIssue[]): void {
  const children = error.children ?? [];
  if (children.length > 0) {
    for (const child of children) collectLeaves(child, into);
    return;
  }
  into.push({
    code: error.code,
    location: toPointer(error.path as readonly (string | number)[]),
    message: error.message,
  });
}

/**
 * Check a document against the meta-schema for the version it declares.
 *
 * Structural conformance only. This cannot answer questions that need a
 * graph walk, because a schema validates a node against a subschema and
 * cannot ask whether a name resolves: a dangling `$ref`, a `{param}`
 * with no declaration, a duplicate `operationId`, a discriminator
 * mapping pointing at nothing, an undeclared server variable, or a
 * security requirement naming a scheme that does not exist all pass
 * here. Some are covered by other passes; the rest are out of scope.
 *
 * How much of the Schema Object is covered depends on the version, and
 * callers reporting alongside the compiler's well-formedness pass need
 * to know: 3.1 and 3.2 stub it and are disjoint from that pass, while
 * 3.0 describes it in full and overlaps. See the package TSDoc.
 *
 * @param document - A parsed OpenAPI document.
 *
 * @example
 * ```ts
 * checkDocumentConformance({ openapi: "3.1.0", info: { title: "t" }, paths: {} });
 * // { version: "3.1", issues: [
 * //   { code: "required", location: "/info/version", message: "..." },
 * // ] }
 * ```
 *
 * @public
 */
export function checkDocumentConformance(document: unknown): ConformanceResult {
  const version = metaschemaVersionOf(document);
  if (version === undefined) return { version: undefined, issues: [] };

  const result = compiledFor(version).validate(document);
  if (result.valid) return { version, issues: [] };

  const issues: ConformanceIssue[] = [];
  collectLeaves(result.error, issues);
  return { version, issues };
}
