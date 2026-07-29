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
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-schema/internals";

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

/** HTTP methods that hold an Operation Object under a Path Item. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 6901: `~` becomes `~0`, `/` becomes `~1`. */
function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

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
 * @param document - A resolved document (external `$ref`s already
 *   inlined). Internal `$ref`s are resolved through the document.
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
   * Walk a schema and its subschemas, checking examples at each node.
   *
   * `$ref` is not followed: the target is walked at its own definition,
   * so following it here would report the same defect once per
   * reference. Uses the compiler's own position constants so the walk
   * cannot drift from what counts as a subschema.
   */
  const walkSchema = (schema: unknown, pointer: string, seen: Set<unknown>): void => {
    if (!isObj(schema) || seen.has(schema)) return;
    seen.add(schema);

    checkSchemaNodeExamples(schema, pointer);

    for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
      if (key in schema) walkSchema(schema[key], `${pointer}/${key}`, seen);
    }
    for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
      const arr = schema[key];
      if (!Array.isArray(arr)) continue;
      for (const [i, sub] of arr.entries()) walkSchema(sub, `${pointer}/${key}/${i}`, seen);
    }
    for (const key of SUBSCHEMA_MAP_POSITIONS) {
      const map = schema[key];
      if (!isObj(map)) continue;
      for (const [name, sub] of Object.entries(map)) {
        walkSchema(sub, `${pointer}/${key}/${escapePointer(name)}`, seen);
      }
    }
  };

  const seenSchemas = new Set<unknown>();
  const walkSchemaRoot = (schema: unknown, pointer: string): void => {
    walkSchema(schema, pointer, seenSchemas);
  };

  /**
   * Media Type Object `example` / `examples`, validated against the
   * sibling `schema`.
   *
   * `examples` here is a map of Example Objects, not an array of
   * literals. An entry carrying `externalValue` names a payload
   * oaverify does not fetch, so it is skipped rather than reported
   * against a value nobody read.
   */
  const checkMediaTypeExamples = (mediaType: Record<string, unknown>, pointer: string): void => {
    const schema = mediaType["schema"];
    if (schema === undefined) return;
    const check = checkerFor(schema);
    if (check === null) return;

    if (Object.prototype.hasOwnProperty.call(mediaType, "example")) {
      const reason = check(mediaType["example"]);
      if (reason !== undefined) {
        report(`${pointer}/example`, '"example"', mediaType["example"], reason);
      }
    }

    const examples = mediaType["examples"];
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

  const walkContent = (content: unknown, pointer: string): void => {
    if (!isObj(content)) return;
    for (const [mediaTypeName, mediaType] of Object.entries(content)) {
      if (!isObj(mediaType)) continue;
      const at = `${pointer}/${escapePointer(mediaTypeName)}`;
      if (mediaType["schema"] !== undefined) walkSchemaRoot(mediaType["schema"], `${at}/schema`);
      checkMediaTypeExamples(mediaType, at);
    }
  };

  /** Parameter and Header Objects have the same shape here. */
  const walkParameterLike = (param: unknown, pointer: string): void => {
    if (!isObj(param)) return;
    if (param["schema"] !== undefined) walkSchemaRoot(param["schema"], `${pointer}/schema`);
    if (param["content"] !== undefined) walkContent(param["content"], `${pointer}/content`);
  };

  const walkParameterList = (params: unknown, pointer: string): void => {
    if (!Array.isArray(params)) return;
    for (const [i, p] of params.entries()) walkParameterLike(p, `${pointer}/${i}`);
  };

  const walkResponse = (response: unknown, pointer: string): void => {
    if (!isObj(response)) return;
    if (response["content"] !== undefined) walkContent(response["content"], `${pointer}/content`);
    const headers = response["headers"];
    if (isObj(headers)) {
      for (const [name, header] of Object.entries(headers)) {
        walkParameterLike(header, `${pointer}/headers/${escapePointer(name)}`);
      }
    }
  };

  const walkRequestBody = (body: unknown, pointer: string): void => {
    if (!isObj(body)) return;
    if (body["content"] !== undefined) walkContent(body["content"], `${pointer}/content`);
  };

  const walkOperation = (operation: unknown, pointer: string): void => {
    if (!isObj(operation)) return;
    walkParameterList(operation["parameters"], `${pointer}/parameters`);
    if (operation["requestBody"] !== undefined) {
      walkRequestBody(operation["requestBody"], `${pointer}/requestBody`);
    }
    const responses = operation["responses"];
    if (isObj(responses)) {
      for (const [status, response] of Object.entries(responses)) {
        walkResponse(response, `${pointer}/responses/${escapePointer(status)}`);
      }
    }
    // A callback is a map of runtime expressions to Path Items, so its
    // request and response content carries examples like any other
    // operation's.
    walkCallbacks(operation["callbacks"], `${pointer}/callbacks`);
  };

  const walkCallbacks = (callbacks: unknown, pointer: string): void => {
    if (!isObj(callbacks)) return;
    for (const [name, callback] of Object.entries(callbacks)) {
      if (!isObj(callback)) continue;
      const at = `${pointer}/${escapePointer(name)}`;
      for (const [expression, item] of Object.entries(callback)) {
        walkPathItem(item, `${at}/${escapePointer(expression)}`);
      }
    }
  };

  const walkPathItem = (item: unknown, pointer: string): void => {
    if (!isObj(item)) return;
    walkParameterList(item["parameters"], `${pointer}/parameters`);
    for (const method of METHODS) {
      if (item[method] !== undefined) walkOperation(item[method], `${pointer}/${method}`);
    }
  };

  const doc = document as unknown as Record<string, unknown>;

  for (const container of ["paths", "webhooks"] as const) {
    const entries = doc[container];
    if (!isObj(entries)) continue;
    for (const [name, item] of Object.entries(entries)) {
      walkPathItem(item, `/${container}/${escapePointer(name)}`);
    }
  }

  const components = doc["components"];
  if (isObj(components)) {
    const schemas = components["schemas"];
    if (isObj(schemas)) {
      for (const [name, schema] of Object.entries(schemas)) {
        walkSchemaRoot(schema, `/components/schemas/${escapePointer(name)}`);
      }
    }
    for (const section of ["parameters", "headers"] as const) {
      const entries = components[section];
      if (!isObj(entries)) continue;
      for (const [name, entry] of Object.entries(entries)) {
        walkParameterLike(entry, `/components/${section}/${escapePointer(name)}`);
      }
    }
    const requestBodies = components["requestBodies"];
    if (isObj(requestBodies)) {
      for (const [name, entry] of Object.entries(requestBodies)) {
        walkRequestBody(entry, `/components/requestBodies/${escapePointer(name)}`);
      }
    }
    const responses = components["responses"];
    if (isObj(responses)) {
      for (const [name, entry] of Object.entries(responses)) {
        walkResponse(entry, `/components/responses/${escapePointer(name)}`);
      }
    }
    const pathItems = components["pathItems"];
    if (isObj(pathItems)) {
      for (const [name, entry] of Object.entries(pathItems)) {
        walkPathItem(entry, `/components/pathItems/${escapePointer(name)}`);
      }
    }
    const callbacks = components["callbacks"];
    if (isObj(callbacks)) {
      for (const [name, entry] of Object.entries(callbacks)) {
        if (!isObj(entry)) continue;
        for (const [expression, item] of Object.entries(entry)) {
          walkPathItem(
            item,
            `/components/callbacks/${escapePointer(name)}/${escapePointer(expression)}`,
          );
        }
      }
    }
  }

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
