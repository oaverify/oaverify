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
  type OpenAPIDocument,
  type RejectionReason,
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
  type Dialect,
  type RefResolver,
} from "@oaverify/internal-schema";
import { escapePointer, walkDocumentSchemas } from "./document-walk.js";

/**
 * One example that its schema rejects.
 *
 * @public
 */
export interface ExampleIssue {
  /** Always `"example-invalid"`; the field exists so findings read uniformly. */
  code: "example-invalid";
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
   * Uncapped and undeduplicated, which is deliberately not what
   * `message` does. Truncation there serves a terminal, and a consumer
   * has no such constraint; deduplication needs a key, and only the
   * consumer knows which one it cares about (a composition keyword
   * reports the same leaf once per branch it tried, and those entries
   * differ in `params` even where their `message` matches).
   */
  reasons: readonly RejectionReason[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps a finding readable when the example is a large object. */
const VALUE_ECHO_LIMIT = 60;

/** An enum worth naming in full is longer than one value. */
const ALLOWED_ECHO_LIMIT = 120;

function echoValue(value: unknown, limit = VALUE_ECHO_LIMIT): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return "the value"; // circular or otherwise unserialisable
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * What the value was, and what was permitted, for the failures where
 * the message alone cannot say.
 *
 * `must be one of the allowed values` is unactionable from a report: it
 * names neither the offending value nor the set, and recovering them
 * means opening the spec and following the `$ref` chain to the enum. A
 * consumer keying on the value cannot see it at all (#580).
 *
 * Confined to `enum`, `const` and `type`, the three whose message is a
 * bare assertion. The bounded keywords (`minLength`, `maximum`, ...)
 * already name their bound, and their `actual` is a count rather than a
 * value.
 *
 * Interpolated here rather than in the shared keyword message, which is
 * also what a rejected request body renders through: an example is spec
 * text, and echoing it back to its author is free, while echoing a
 * request value into a 400 is a decision the caller owns.
 */
function detailOf(code: string, params: Readonly<Record<string, unknown>>): string {
  switch (code) {
    case "enum":
      return ` (actual: ${echoValue(params["actual"])}, allowed: ${echoValue(params["allowed"], ALLOWED_ECHO_LIMIT)})`;
    case "const":
      return ` (actual: ${echoValue(params["actual"])}, expected: ${echoValue(params["expected"])})`;
    case "type":
      // A type name, not a value: "must be string (actual: number)".
      return typeof params["actual"] === "string" ? ` (actual: ${params["actual"]})` : "";
    default:
      return "";
  }
}

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
    seen.add(`${where}${error.message}${detailOf(error.code, error.params)}`);
  }
  if (seen.size === 0) return "does not validate";
  const reasons = [...seen];
  const shown = reasons.slice(0, REASON_LIMIT).join("; ");
  const dropped = reasons.length - REASON_LIMIT;
  return dropped > 0 ? `${shown}; and ${dropped} more` : shown;
}

/**
 * What one rejected example yields: the rendered summary that goes in
 * the message, and the structured leaves behind it. Kept together so
 * the two can never be assembled from different validation runs.
 */
interface Rejection {
  summary: string;
  reasons: readonly RejectionReason[];
}

/**
 * Validates one example value against a schema, returning the rejection
 * when it fails and `undefined` when it validates.
 */
type ExampleCheck = (value: unknown) => Rejection | undefined;

export interface CheckDocumentExamplesOptions {
  /**
   * Override the dialect. Defaults to the one implied by the document's
   * `openapi` version, matching what `createValidator` would compile
   * these schemas under.
   */
  dialect?: Dialect;
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
  let refResolver: RefResolver;
  try {
    refResolver = createRefResolver(resolve(document as unknown as SchemaOrBoolean));
  } catch {
    // A document whose ref graph will not build is not this pass's
    // problem to report; the schema and conformance classes own it.
    return [];
  }

  const issues: ExampleIssue[] = [];
  // Identity-keyed, so a component shared by 60 operations compiles
  // once. `null` records "this one will not compile", which is asked
  // again for every example on the same schema.
  const compiled = new Map<unknown, ExampleCheck | null>();

  const checkerFor = (schema: unknown): ExampleCheck | null => {
    const cached = compiled.get(schema);
    if (cached !== undefined) return cached;

    let built: CompiledSchema;
    try {
      built = compileSchema(schema as SchemaOrBoolean, {
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
      });
    } catch {
      compiled.set(schema, null);
      return null;
    }

    const check: ExampleCheck = (value) => {
      let result: ReturnType<CompiledSchema["validate"]>;
      try {
        result = built.validate(value);
      } catch {
        // A validator that throws on this value says nothing about the
        // example being wrong.
        return undefined;
      }
      if (result.valid) return undefined;
      return {
        summary: joinReasons(result.errors),
        // Rebuilt rather than passed through: `output: "flat"` already
        // yields leaves, and copying the four contract fields keeps a
        // finding from retaining the validator's error tree, and keeps
        // an always-empty `children: []` out of the JSON report.
        reasons: result.errors.map((e) => ({
          code: e.code,
          path: e.path,
          message: e.message,
          params: e.params,
        })),
      };
    };
    compiled.set(schema, check);
    return check;
  };

  const report = (pointer: string, what: string, value: unknown, rejection: Rejection): void => {
    issues.push({
      code: "example-invalid",
      pointer,
      reasons: rejection.reasons,
      // "oaverify rejects" rather than "does not satisfy": the finding
      // reports this validator's verdict. Usually that means the example
      // is wrong, and occasionally it means oaverify is (#553). Wording
      // it as settled spec truth would overstate the first case and
      // mislead on the second.
      message: `oaverify rejects ${what} against its schema: ${rejection.summary} (example: ${echoValue(value)})`,
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

    const check = checkerFor(node);
    if (check === null) return;

    if (hasExample) {
      const rejection = check(node["example"]);
      if (rejection !== undefined) {
        report(`${pointer}/example`, '"example"', node["example"], rejection);
      }
    }
    if (hasExamples) {
      for (const [index, value] of (examples as readonly unknown[]).entries()) {
        const rejection = check(value);
        if (rejection !== undefined) {
          report(`${pointer}/examples/${index}`, `"examples"[${index}]`, value, rejection);
        }
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
    const check = checkerFor(schema);
    if (check === null) return;

    if (Object.prototype.hasOwnProperty.call(host, "example")) {
      const rejection = check(host["example"]);
      if (rejection !== undefined) {
        report(`${pointer}/example`, '"example"', host["example"], rejection);
      }
    }

    const examples = host["examples"];
    if (!isObj(examples)) return;
    for (const [name, entry] of Object.entries(examples)) {
      if (!isObj(entry)) continue;
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) continue; // externalValue, or empty
      const rejection = check(entry["value"]);
      if (rejection !== undefined) {
        report(
          `${pointer}/examples/${escapePointer(name)}/value`,
          `"examples.${name}"`,
          entry["value"],
          rejection,
        );
      }
    }
  };

  // One traversal, shared with the CLI's ReDoS check so a container
  // cannot be covered by one and missed by the other.
  walkDocumentSchemas(document, {
    onSchemaNode: checkSchemaNodeExamples,
    onMediaType: checkExamplesBesideSchema,
    onParameterLike: checkExamplesBesideSchema,
  });

  return issues;
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
