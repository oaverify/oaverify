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
  /** RFC 6901 pointer to the offending example value within the document. */
  pointer: string;
  /** Human-readable explanation, including why the schema rejected it. */
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps a finding readable when the example is a large object. */
const VALUE_ECHO_LIMIT = 60;

function echoValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return "the value"; // circular or otherwise unserialisable
  }
  return text.length <= VALUE_ECHO_LIMIT ? text : `${text.slice(0, VALUE_ECHO_LIMIT)}...`;
}

/**
 * Validates one example value against a schema, returning a short
 * reason when it fails and `undefined` when it validates.
 */
type ExampleCheck = (value: unknown) => string | undefined;

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
        maxErrors: 1,
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
      const first = result.errors[0];
      if (first === undefined) return "does not validate";
      const where = first.path.length === 0 ? "" : `${first.path.join(".")}: `;
      return `${where}${first.message}`;
    };
    compiled.set(schema, check);
    return check;
  };

  const report = (pointer: string, what: string, value: unknown, reason: string): void => {
    issues.push({
      code: "example-invalid",
      pointer,
      // "oaverify rejects" rather than "does not satisfy": the finding
      // reports this validator's verdict. Usually that means the example
      // is wrong, and occasionally it means oaverify is (#553). Wording
      // it as settled spec truth would overstate the first case and
      // mislead on the second.
      message: `oaverify rejects ${what} against its schema: ${reason} (example: ${echoValue(value)})`,
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
      const reason = check(node["example"]);
      if (reason !== undefined) {
        report(`${pointer}/example`, '"example"', node["example"], reason);
      }
    }
    if (hasExamples) {
      for (const [index, value] of (examples as readonly unknown[]).entries()) {
        const reason = check(value);
        if (reason !== undefined) {
          report(`${pointer}/examples/${index}`, `"examples"[${index}]`, value, reason);
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
      const reason = check(host["example"]);
      if (reason !== undefined) {
        report(`${pointer}/example`, '"example"', host["example"], reason);
      }
    }

    const examples = host["examples"];
    if (!isObj(examples)) return;
    for (const [name, entry] of Object.entries(examples)) {
      if (!isObj(entry)) continue;
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) continue; // externalValue, or empty
      const reason = check(entry["value"]);
      if (reason !== undefined) {
        report(
          `${pointer}/examples/${escapePointer(name)}/value`,
          `"examples.${name}"`,
          entry["value"],
          reason,
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
