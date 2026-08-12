/**
 * Document-level example validation: the `example` / `examples` values
 * an OpenAPI document declares, checked against the schemas they
 * illustrate.
 *
 * Reached from `paths`, `webhooks`, callbacks (on an operation and under
 * `components.callbacks`), and the `schemas` / `parameters` / `headers`
 * / `requestBodies` / `responses` / `pathItems` sections of
 * `components`. Two surfaces within those:
 *
 * - **Schema Object** `example` (3.0, singular) and `examples` (3.1, an
 *   array of literal values), the JSON Schema annotations (#541).
 * - **Media Type Object** `example` and `examples` (a map of Example
 *   Objects), which sit beside `schema:` under a content entry (#552).
 *
 * Both are annotations: they emit no validation code, so nothing at
 * runtime ever looks at them. What ships instead is a documented
 * example contradicting the contract it illustrates, carried into
 * generated docs, SDK fixtures and mock servers as though it were
 * conformant.
 *
 * ## Why this is a document pass rather than a schema lint
 *
 * The first implementation hung this off `schemaLint` during the
 * validator's per-operation compiles, and inherited whichever artifact
 * happened to be compiled. Body schemas go through
 * {@link transformBodySchemaForDirection}, which rewrites `readOnly`
 * properties to `false` on the request leg and `writeOnly` on the
 * response leg, so a component example that is a perfectly good
 * response was reported as invalid against the request variant. An
 * example is a fact about the schema *as authored*, so it has to be
 * checked against the schema as authored. Walking the document is the
 * only place that is available.
 *
 * It also puts each finding at one document location. A shared
 * component is checked once, at its own definition, rather than once
 * per operation that reaches it.
 */

import {
  detectOpenAPIVersion,
  formatLeafDetail,
  pointerFromFragment,
  type OpenAPIDocument,
  type PathSegment,
  type RejectionReason,
  resolveJsonPointer,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { builtInFormats } from "@oaverify/internal-formats";
import {
  compileSchema,
  createRefResolver,
  oas30Dialect,
  openapi31Dialect,
  resolve,
  type CompiledSchema,
  type CompiledPredicate,
  type Dialect,
  type RefResolver,
} from "@oaverify/internal-schema";
import { escapePointer, walkDocumentSchemas } from "./document-walk.js";

/**
 * One example its schema rejects, or one this pass could not check.
 *
 * @public
 */
export interface ExampleIssue {
  /**
   * - `"example-invalid"`: the schema rejects the example.
   * - `"example-uncheckable"`: nothing is known about the example
   *   either way: the validator threw, or executing it was refused
   *   because the schema reaches a pattern the caller's
   *   {@link CheckDocumentExamplesOptions.patternGuard} marked unsafe
   *   to run (#687).
   *
   * A guard refusal is a decision about risk, not a measurement of
   * cost. The guard `check` supplies asks whether a pattern is
   * *ambiguous*, which is necessary for catastrophic backtracking and
   * nowhere near sufficient: on the published-spec corpus most refused
   * patterns match in microseconds on V8. Read it as "this was not
   * checked", never as "this pattern is slow". Recovering those checks
   * needs a caller-side linear-time engine; see #798.
   */
  code: "example-invalid" | "example-uncheckable";
  /**
   * RFC 6901 pointer to the offending example value within the
   * document, percent-decoded with `~0` / `~1` retained.
   */
  pointer: string;
  /**
   * Human-readable explanation, including why the schema rejected it.
   *
   * A summary. It deduplicates by rendered text and stops at
   * `REASON_LIMIT` distinct reasons (naming how many it dropped), so it
   * can be shorter than {@link ExampleIssue.reasons}. Read `reasons` for
   * the complete set; do not pattern-match this.
   */
  message: string;
  /**
   * Every leaf the schema rejected this value on, in machine-readable
   * form. Always present, possibly empty.
   *
   * Uncapped, where `message` caps: truncation there serves a terminal
   * and a consumer has no such constraint, so this can be longer.
   *
   * Distinct, in the strict sense that no two entries are equal on all
   * four fields. A composition keyword runs every branch, so branches
   * carrying the same constraint report byte-identical leaves, and
   * counting this array to say "N problems with this example" counted
   * those twice (#604). Only an exact repeat is dropped: two branches
   * rejecting one position with different detail stay as two entries,
   * because `anyOf: [{enum: [1, 2]}, {enum: [3, 4]}]` against `9` gives
   * two `enum` leaves whose `params.allowed` differ and which the author
   * may act on separately.
   *
   * So this is longer than `message` where `message` truncated, and
   * never longer for having replayed a branch. A consumer wanting a
   * coarser grouping (per `code`, per `path`) still applies its own key;
   * what it no longer has to do is undo a duplication it did not ask
   * for.
   */
  reasons: readonly RejectionReason[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Keeps an uncheckable finding readable when the guarded pattern is a
 * long one. Distinct from the value cap in `formatLeafDetail`: this
 * elides a regex source rather than a JSON value, so it does not go
 * through the same helper.
 */
const PATTERN_ECHO_LIMIT = 60;

/**
 * How many distinct reasons one finding spells out before summarising
 * the rest as a count. Five fits a terminal line and covers most bad
 * examples whole; past that the author has enough to work with.
 */
const REASON_LIMIT = 5;

/**
 * One reason per failing leaf, deduplicated and capped.
 *
 * Deduplication is by rendered text rather than by error identity. A
 * composition keyword reports the same leaf once per branch it tried,
 * so `anyOf: [{type: string}, {type: string, format: date}]` against a
 * number yields two identical `must be string` lines. Those are one
 * defect to the author.
 *
 * The tail names how many were dropped, so a cap is visible rather than
 * silent truncation.
 */
function joinReasons(
  errors: readonly {
    code: string;
    path: readonly (string | number)[];
    message: string;
    params: Readonly<Record<string, unknown>>;
  }[],
) {
  const seen = new Set<string>();
  for (const error of errors) {
    const where = error.path.length === 0 ? "" : `${error.path.join(".")}: `;
    seen.add(`${where}${error.message}${formatLeafDetail(error.code, error.params)}`);
  }
  if (seen.size === 0) return "does not validate";
  const reasons = [...seen];
  const shown = reasons.slice(0, REASON_LIMIT).join("; ");
  const dropped = reasons.length - REASON_LIMIT;
  return dropped > 0 ? `${shown}; and ${dropped} more` : shown;
}

/**
 * The leaves behind one rejection, with exact duplicates removed.
 *
 * A composition keyword runs every branch, so two branches carrying the
 * same constraint report the same leaf twice: `anyOf: [A, B]` where both
 * declare `required: [parts]` yields two identical `required` errors at
 * one path. They are one defect and one edit, and a consumer counting
 * this array to say "N problems with this example" counted them twice.
 * {@link joinReasons} has always collapsed them in the rendered summary,
 * so before this the message and the array disagreed on how many things
 * were wrong.
 *
 * Deduplication is on the whole leaf rather than on `code` plus `path`,
 * because two branches can reject the same position for the same reason
 * with different detail: `anyOf: [{enum: [1, 2]}, {enum: [3, 4]}]`
 * against `9` gives two `enum` leaves at the root whose `params.allowed`
 * differ, and those are two things the author may act on. Only an exact
 * repeat is dropped, which is what a branch replay produces.
 *
 * Rebuilt rather than passed through: `output: "flat"` already yields
 * leaves, and copying the four contract fields keeps a finding from
 * retaining the validator's error tree, and keeps an always-empty
 * `children: []` out of the JSON report.
 */
function distinctReasons(
  errors: readonly {
    code: string;
    path: readonly PathSegment[];
    message: string;
    params: Readonly<Record<string, unknown>>;
  }[],
): readonly RejectionReason[] {
  const seen = new Set<string>();
  const reasons: RejectionReason[] = [];
  for (const error of errors) {
    // Serialised whole rather than joined with separators, so no
    // property name can forge a key boundary. Two leaves from one
    // validation run are built by the same generated code, so equal
    // params serialise equally; a key that missed would keep a duplicate
    // rather than drop a distinct leaf, the safe direction to be wrong in.
    const key = JSON.stringify([error.code, error.path, error.message, error.params]);
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({
      code: error.code,
      path: error.path,
      message: error.message,
      params: error.params,
    });
  }
  return reasons;
}

/**
 * Depth cap for the two compiles below.
 *
 * Recursion runs on the native call stack, so a self-`$ref` schema and a
 * deeply nested example throw `RangeError` (empirically around 5k
 * frames). `maxDepth` turns that into a `depth` error leaf, so the
 * example is reported as invalid with a true reason rather than passing
 * silently (#625).
 *
 * 500 against a measured crash at ~7.7k, so the margin absorbs a
 * smaller stack (another platform, another Node, a deeper caller)
 * rather than tracking the ceiling. Far over any real example: 500
 * levels of nesting is not a value anyone writes into a spec.
 */
const EXAMPLE_MAX_DEPTH = 500;

/**
 * What one rejected example yields: the rendered summary that goes in
 * the message, and the structured leaves behind it. Kept together so
 * the two can never be assembled from different validation runs.
 */
interface Rejection {
  code: ExampleIssue["code"];
  summary: string;
  reasons: readonly RejectionReason[];
}

/**
 * A validator that threw says nothing about the example. Reporting it
 * as a finding keeps "I could not check this" distinct from "this is
 * fine", which returning `undefined` did not (#625).
 */
function uncheckable(err: unknown): Rejection {
  return {
    code: "example-uncheckable",
    summary: err instanceof Error ? err.message : String(err),
    reasons: [],
  };
}

/**
 * Validates one example value against a schema, returning the rejection
 * when it fails and `undefined` when it validates.
 */
type ExampleCheck = (value: unknown) => Rejection | undefined;

interface ExampleJob {
  schema: unknown;
  pointer: string;
  value: unknown;
}

interface ExampleCheckers {
  predicate: CompiledPredicate;
  detail?: CompiledSchema;
}

export interface CheckDocumentExamplesOptions {
  /**
   * Override the dialect. Defaults to the one implied by the document's
   * `openapi` version, matching what `createValidator` would compile
   * these schemas under.
   */
  dialect?: Dialect;
  /**
   * Screen for `pattern` sources that must not be executed. Called once
   * per distinct pattern reachable from an example's schema ($refs
   * followed); returning `true` reports the example as
   * `example-uncheckable` instead of validating it.
   *
   * This is the ReDoS guard (#687): validating an example runs its
   * schema's patterns against the example value, and a catastrophic
   * pattern paired with a non-matching example hangs the process. The
   * caller supplies the verdict (the `check` package backs it with the
   * same analysis its redos pass uses) so this package does not grow an
   * analyser dependency. Unset, nothing is screened, which matches the
   * pre-guard behavior.
   */
  patternGuard?: (pattern: string) => boolean;
}

/**
 * Walk a resolved OpenAPI document and validate every example against
 * the schema it illustrates.
 *
 * Compiles each distinct schema once, keyed by identity, so a component
 * reached from many operations costs one compile and yields one finding
 * per bad example rather than one per reference.
 *
 * @param document - A resolved document: external `$ref`s already
 *   resolved, with schema targets hoisted into `components.schemas`.
 *   Internal `$ref`s are resolved through the document, so a hoisted
 *   schema is checked once at its component rather than at each use.
 *
 * @public
 */
export function checkDocumentExamples(
  document: OpenAPIDocument,
  options: CheckDocumentExamplesOptions = {},
): ExampleIssue[] {
  const dialect = options.dialect ?? dialectForDocument(document);
  const jobs: ExampleJob[] = [];
  const issues: ExampleIssue[] = [];

  // The value is not echoed back into the message (#773). It was the
  // second truncation in a line that already had one, and for the
  // failures where knowing the value matters the reasons carry it per
  // path: an `enum` leaf renders `(actual: ..., allowed: ...)`, so
  // echoing the whole example repeated the same string a few words
  // later. The finding is located at the example, so a reader who wants
  // it whole follows the pointer.
  const report = (pointer: string, rejection: Rejection): void => {
    issues.push({
      code: rejection.code,
      pointer,
      reasons: rejection.reasons,
      // No "oaverify" prefix: SARIF names the tool at
      // `runs[].tool.driver.name`, LSP renders `Diagnostic.source`, and
      // a terminal reader typed the command. Every consumer has already
      // attributed this before reading the sentence.
      message:
        rejection.code === "example-uncheckable"
          ? `example could not be checked against its schema: ${rejection.summary}`
          : `example does not match its schema: ${rejection.summary}`,
    });
  };

  /**
   * Schema Object `example` / `examples` on one node.
   *
   * `examples` is checked only when it is an array. Under 3.1 it must
   * be an array of literal values; the 3.0 Example Object map shape
   * turns up anyway under a 3.1 `openapi:`, and its wrapper objects
   * cannot satisfy the schema they sit in, so validating them would
   * report a confusing type error rather than the real problem, which
   * is that the keyword is the wrong type.
   *
   * That is reported by the `annotation-value-type` schema lint, which
   * names the actual defect. Two findings for one mistake would be
   * worse than one, and this would be the less useful of the two.
   */
  const checkSchemaNodeExamples = (node: Record<string, unknown>, pointer: string): void => {
    const hasExample = Object.prototype.hasOwnProperty.call(node, "example");
    const examples = node["examples"];
    const hasExamples = Array.isArray(examples);
    if (!hasExample && !hasExamples) return;

    if (hasExample) {
      jobs.push({
        schema: node,
        pointer: `${pointer}/example`,
        value: node["example"],
      });
    }
    if (hasExamples) {
      for (const [index, value] of (examples as readonly unknown[]).entries()) {
        jobs.push({
          schema: node,
          pointer: `${pointer}/examples/${index}`,
          value,
        });
      }
    }
  };

  /**
   * `example` / `examples` sitting *beside* a `schema` rather than
   * inside it, validated against that schema.
   *
   * Three OpenAPI objects have this shape and share this code: Media
   * Type, Parameter and Header. `examples` here is a map of Example
   * Objects, not the array of literals a Schema Object takes. An entry
   * carrying `externalValue` names a payload oaverify does not fetch, so
   * it is skipped rather than reported against a value nobody read.
   *
   * A Parameter or Header Object carries either `schema` or `content`,
   * never both. With `content`, the examples belong to the media type
   * objects beneath it and are checked there, which is why this returns
   * early when there is no sibling `schema`.
   */
  const checkExamplesBesideSchema = (host: Record<string, unknown>, pointer: string): void => {
    const schema = host["schema"];
    if (schema === undefined) return;

    if (Object.prototype.hasOwnProperty.call(host, "example")) {
      jobs.push({
        schema,
        pointer: `${pointer}/example`,
        value: host["example"],
      });
    }

    const examples = host["examples"];
    if (!isObj(examples)) return;
    for (const [name, entry] of Object.entries(examples)) {
      if (!isObj(entry)) continue;
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) continue; // externalValue, or empty
      jobs.push({
        schema,
        pointer: `${pointer}/examples/${escapePointer(name)}/value`,
        value: entry["value"],
      });
    }
  };

  // One traversal, shared with the CLI's ReDoS check so a container
  // cannot be covered by one and missed by the other.
  walkDocumentSchemas(document, {
    onSchemaNode: checkSchemaNodeExamples,
    onMediaType: checkExamplesBesideSchema,
    onParameterLike: checkExamplesBesideSchema,
  });

  if (jobs.length === 0) return [];

  const refResolver = lazyDocumentRefResolver(document);

  // Identity-keyed, so a component shared by 60 operations compiles
  // once. `null` records "this one will not compile", which is asked
  // again for every example on the same schema.
  const compiled = new Map<unknown, ExampleCheck | null>();

  const checkerFor = (schema: unknown): ExampleCheck | null => {
    const cached = compiled.get(schema);
    if (cached !== undefined) return cached;

    // The ReDoS guard, ahead of the compile: executing a validator runs
    // its patterns against the example value, so a schema that reaches
    // a guarded pattern is never executed at all. The example is
    // reported as uncheckable, which is the truth: nothing is known
    // about it either way, and running the check is not safe (#687).
    if (options.patternGuard !== undefined) {
      const guarded = findGuardedPattern(schema, refResolver, options.patternGuard);
      if (guarded !== undefined) {
        const echoed =
          guarded.length <= PATTERN_ECHO_LIMIT
            ? guarded
            : `${guarded.slice(0, PATTERN_ECHO_LIMIT)}...`;
        const check: ExampleCheck = () => ({
          code: "example-uncheckable",
          summary:
            `its schema reaches the pattern "${echoed}", whose worst-case matching ` +
            `time may be superlinear, so the example was not run against it ` +
            `(the redos class reports the pattern itself). This is a refusal ` +
            `on the safe side rather than a measurement: many patterns that ` +
            `reach it cost nothing on a given engine`,
          reasons: [],
        });
        compiled.set(schema, check);
        return check;
      }
    }

    let checkers: ExampleCheckers;
    try {
      checkers = {
        predicate: compileSchema(schema as SchemaOrBoolean, {
          dialect,
          formats: builtInFormats,
          refResolver,
          schemaLint: "off",
          output: "predicate",
          maxDepth: EXAMPLE_MAX_DEPTH,
        }),
      };
    } catch {
      compiled.set(schema, null);
      return null;
    }

    const detail = (): CompiledSchema => {
      if (checkers.detail !== undefined) return checkers.detail;
      checkers.detail = compileSchema(schema as SchemaOrBoolean, {
        dialect,
        formats: builtInFormats,
        refResolver,
        // Load-bearing rather than an optimisation: this pass is the
        // only lint over these schemas, and leaving it on would collect
        // issues nobody reads on every compile.
        schemaLint: "off",
        output: "flat",
        // Uncapped, against the zero-config default of 1. An example is
        // usually wrong in several independent ways, and a budget of 1
        // costs the author one fix-and-recheck round per defect with no
        // sign of how many remain (#579). Rendering is capped instead,
        // at REASON_LIMIT, so the finding stays readable and the count
        // of what was dropped is exact.
        maxErrors: Number.POSITIVE_INFINITY,
        maxDepth: EXAMPLE_MAX_DEPTH,
      });
      return checkers.detail;
    };

    const check: ExampleCheck = (value) => {
      let valid: boolean;
      try {
        valid = checkers.predicate.validate(value);
      } catch (err) {
        return uncheckable(err);
      }
      if (valid) return undefined;

      let result: ReturnType<CompiledSchema["validate"]>;
      try {
        result = detail().validate(value);
      } catch (err) {
        return uncheckable(err);
      }
      if (result.valid) return undefined;
      return {
        code: "example-invalid",
        summary: joinReasons(result.errors),
        reasons: distinctReasons(result.errors),
      };
    };
    compiled.set(schema, check);
    return check;
  };

  for (const job of jobs) {
    const check = checkerFor(job.schema);
    if (check === null) continue;
    const rejection = check(job.value);
    if (rejection !== undefined) report(job.pointer, rejection);
  }

  return issues;
}

function lazyDocumentRefResolver(document: OpenAPIDocument): RefResolver {
  let fallback: RefResolver | undefined;
  const full = (): RefResolver => {
    if (fallback !== undefined) return fallback;
    fallback = createRefResolver(resolve(document as unknown as SchemaOrBoolean));
    return fallback;
  };

  return {
    resolve(ref: string, fromBaseUri = ""): SchemaOrBoolean {
      if (fromBaseUri === "" && ref.startsWith("#/")) {
        return resolveJsonPointer(
          document,
          pointerFromFragment(ref.slice(1)),
        ) as unknown as SchemaOrBoolean;
      }
      return full().resolve(ref, fromBaseUri);
    },
  };
}

/**
 * Dialect implied by the document's `openapi` version, so examples are
 * judged under the same semantics `createValidator` would compile these
 * schemas with. Falls back to 3.1 when the version cannot be read: this
 * pass reports advice, and refusing to run over an unreadable version
 * would be a worse answer than checking under the current dialect.
 */
function dialectForDocument(document: OpenAPIDocument): Dialect {
  return detectOpenAPIVersion(document) === "3.0" ? oas30Dialect : openapi31Dialect;
}

/**
 * Literal-value keywords whose contents are data, not subschemas; the
 * guard walk does not descend into them, so a `pattern` key inside an
 * example object is not mistaken for a constraint.
 */
const LITERAL_KEYWORDS = new Set(["enum", "const", "default", "example", "examples"]);

/**
 * First guarded `pattern` reachable from `schema`, following `$ref`
 * through the document resolver with a cycle guard.
 *
 * The walk is deliberately over-approximate: it recurses into every
 * nested object and array outside {@link LITERAL_KEYWORDS}, collecting
 * `pattern` string values and `patternProperties` keys, without
 * modelling which keyword each node sits under. A false hit skips a
 * validation that would have been safe, which is the cheap direction
 * to be wrong in; a miss hangs the process (#687).
 */
function findGuardedPattern(
  node: unknown,
  refResolver: RefResolver,
  guard: (pattern: string) => boolean,
  visited: Set<unknown> = new Set(),
): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  if (visited.has(node)) return undefined;
  visited.add(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const hit = findGuardedPattern(entry, refResolver, guard, visited);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  const pattern = obj["pattern"];
  if (typeof pattern === "string" && guard(pattern)) return pattern;
  const patternProperties = obj["patternProperties"];
  if (isObj(patternProperties)) {
    for (const key of Object.keys(patternProperties)) {
      if (guard(key)) return key;
    }
  }
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    let target: unknown;
    try {
      target = refResolver.resolve(ref);
    } catch {
      // Unresolvable here means uncompilable later; the existing
      // uncheckable path reports that with the real error.
      target = undefined;
    }
    const hit = findGuardedPattern(target, refResolver, guard, visited);
    if (hit !== undefined) return hit;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (LITERAL_KEYWORDS.has(key)) continue;
    const hit = findGuardedPattern(value, refResolver, guard, visited);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
