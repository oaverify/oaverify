/**
 * The error model shared by every layer of the @oaverify validator. All errors form
 * a tree: every node has a {@link ValidationError.children} array (possibly
 * empty) regardless of whether it is a leaf or a branch. Applicator keywords
 * (oneOf, allOf, etc.) and HTTP-level validators produce branch nodes; simple
 * keywords (type, required, maxLength, etc.) produce leaves.
 */

/**
 * A segment of a data or schema path. Property names are strings; array
 * indices are numbers. Paths are never pre-joined; consumers choose how
 * to render them.
 *
 * @public
 */
export type PathSegment = string | number;

/**
 * Machine-readable `params` shape, per built-in error {@link ValidationError.code}.
 *
 * Acts as the single contract that consumers can type-narrow against:
 *
 * ```ts
 * if (err.code === "type") {
 *   const p = err.params as BuiltInErrorParams["type"];
 *   console.log(p.expected); // typed as string[]
 * }
 * ```
 *
 * Extended via TypeScript interface declaration merging: a custom
 * consumer (or, internally, a new keyword) can augment the map by
 * re-declaring the interface in its own module:
 *
 * ```ts
 * declare module "@oaverify/internal-core" {
 *   interface BuiltInErrorParams {
 *     "my-custom": { reason: string };
 *   }
 * }
 * ```
 *
 * When adding a new built-in keyword, extend this interface with the
 * entry that describes its `params` shape. Contributors are asked to
 * keep this list in sync; the compiler cannot verify it because
 * errors are emitted from generated JS source.
 *
 * @public
 */
export interface BuiltInErrorParams {
  // --- JSON Schema keywords ---
  /** Schema-is-`false`: no data validates. */
  false: Record<string, never>;
  /** `type` mismatch. */
  type: { expected: string[]; actual: string };
  /** `const` mismatch. */
  const: { expected: unknown; actual: unknown };
  /** `enum` mismatch. */
  enum: { allowed: unknown[]; actual: unknown };
  /** `minimum` (optionally exclusive) violation. */
  minimum: { minimum: number; exclusive: boolean; actual: number };
  /** `maximum` (optionally exclusive) violation. */
  maximum: { maximum: number; exclusive: boolean; actual: number };
  /** `multipleOf` violation. */
  multipleOf: { multipleOf: number; actual: number };
  /** `minLength` violation. Length counted in code points. */
  minLength: { minLength: number; actual: number };
  /** `maxLength` violation. */
  maxLength: { maxLength: number; actual: number };
  /** `pattern` mismatch. */
  pattern: { pattern: string; actual: string };
  /** `format` assertion failure (requires format-assertion vocabulary). */
  format: { format: string; actual: string };
  /** `minItems` violation. */
  minItems: { minItems: number; actual: number };
  /** `maxItems` violation. */
  maxItems: { maxItems: number; actual: number };
  /** `uniqueItems` violation: indices of the first duplicate pair. */
  uniqueItems: { duplicates: [number, number] };
  /** `minProperties` violation. */
  minProperties: { minProperties: number; actual: number };
  /** `maxProperties` violation. */
  maxProperties: { maxProperties: number; actual: number };
  /** `required`: a required property is missing. */
  required: { missing: string };
  /** `items: false`: no items allowed past the prefix. */
  items: Record<string, never>;
  /** `contains` with `minContains` unmet. */
  contains: { minContains: number; actual: number };
  /** `contains` with `maxContains` exceeded. */
  maxContains: { maxContains: number; actual: number };
  /** `additionalProperties: false`: an unexpected property was found. */
  additionalProperties: { unexpected: string };
  /** `unevaluatedProperties`: a property isn't evaluated by the schema. */
  unevaluatedProperties: { unexpected: string };
  /** `unevaluatedItems`: an index isn't evaluated by the schema. */
  unevaluatedItems: { index: number };
  /** `not`: the schema matched when it shouldn't. */
  not: Record<string, never>;
  /** `allOf` branch: failing conjuncts listed in `children`. */
  allOf: { total: number; failed: number };
  /** `anyOf` branch: no branch matched. */
  anyOf: { total: number };
  /** `oneOf` branch: zero or >1 matched. */
  oneOf: { total: number; matchCount: number };
  /** Inline multi-keyword subschema wrapper: matches a compiled function's `wrapErrors` shape. */
  schema: Record<string, never>;
  /** `discriminator`: property absent/non-string, or value not in the mapping. */
  discriminator: { propertyName: string; value?: string };
  /** `dependentRequired`: a sibling required by the trigger key is missing. */
  dependentRequired: { trigger: string; missing: string };
  /** Draft-07 `dependencies` array form: same as dependentRequired. */
  dependencies: { trigger: string; missing: string };

  // --- Compiler safety limits ---
  /**
   * The data nested deeper through a recursive schema than the
   * configured `maxDepth` allowed. `limit` is that configured cap.
   * Emitted at the recursion boundary instead of letting a deep
   * payload exhaust the call stack; semantically a client error (400).
   */
  depth: { limit: number };

  // --- HTTP-level wrappers (emitted by @oaverify/internal-validator) ---
  /** No path template matched `path`: semantically HTTP 404. */
  route: { method: string; path: string };
  /**
   * Path template matched but the requested method isn't declared on
   * it; semantically HTTP 405. `allowed` is the uppercase list of
   * methods the matched path(s) do accept, suitable for an RFC 9110
   * `Allow` response header.
   */
  method: { method: string; pathPattern: string; allowed: string[] };
  /**
   * Request body, leaf-only. Emitted when a `required: true` body is
   * absent on the request. When a present body fails schema validation,
   * the schema's own error (with a keyword-specific code) bubbles up
   * directly with path prefix `["body", ...]`; no `"body"` wrapper.
   */
  body: Record<string, never>;
  /** Request branch: children are parameter / body failures. */
  request: { method: string; pathPattern: string };
  /** Response branch: children are status / content-type / header / body failures. */
  response: { status: number };
  /** Content-Type negotiation failed. */
  "content-type": { contentType: string | undefined; accepted?: string[]; declared?: string[] };
  /** No declared response matches the status. */
  status: { status: number; declared?: string[] };
  /** Parameter validation failures, scoped by `in`. */
  "path-param": { name: string; in: "path" };
  "query-param": { name: string; in: "query" };
  "header-param": { name: string; in: "header" };
  "cookie-param": { name: string; in: "cookie" };
  /**
   * No declared security requirement was satisfied by the request
   * (shape-only check: presence / format of the declared credential
   * location, not credential verification). `declared` lists the
   * alternatives tried: each inner array is a single requirement
   * (AND across its scheme names), the outer array is the OR set.
   * Maps to HTTP 401.
   */
  security: { declared: string[][] };
}

/**
 * Params shape for codes that aren't documented in
 * {@link BuiltInErrorParams}: custom keywords, consumer-defined
 * HTTP-layer wrappers, or anything reached via a string variable the
 * compiler can't narrow.
 *
 * @public
 */
export type CustomErrorParams = Record<string, unknown>;

/**
 * The params shape for an arbitrary error `code`. Built-in codes narrow
 * to the documented {@link BuiltInErrorParams} entry; any other code
 * widens to {@link CustomErrorParams}. Lets downstream code narrow
 * through a variable (`ErrorParams<typeof err.code>`), not just a
 * string literal.
 *
 * @public
 */
export type ErrorParams<Code extends string> = Code extends keyof BuiltInErrorParams
  ? BuiltInErrorParams[Code]
  : CustomErrorParams;

/**
 * Runtime-visible list of every named code documented in
 * {@link BuiltInErrorParams}. Kept in-file alongside the interface so
 * the two drift together under review; cross-check tests assert that
 * the compiler / validator never emit a code outside this list.
 *
 * @public
 */
export const BUILT_IN_ERROR_CODES = [
  // --- JSON Schema keywords ---
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
  // --- Compiler safety limits ---
  "depth",
  // --- HTTP-level wrappers (emitted by @oaverify/internal-validator) ---
  "route",
  "method",
  "body",
  "request",
  "response",
  "content-type",
  "status",
  "path-param",
  "query-param",
  "header-param",
  "cookie-param",
  "security",
] as const satisfies ReadonlyArray<keyof BuiltInErrorParams>;

/**
 * The subset of {@link BUILT_IN_ERROR_CODES} whose leaves carry
 * self-locating messages: the message alone names what failed and
 * where (`missing required query parameter "persona"`, `missing
 * required request body`), so prefixing the leaf's path restates it.
 * {@link formatSummary} consults this set under `path: "auto"`.
 *
 * The contract renderers may rely on: a leaf with one of these codes
 * always locates the error in its message. In particular, parameter
 * VALUE failures (a query param failing `format` or `pattern`, a
 * mis-serialized deepObject) are never reported under a `*-param`
 * code; they surface as schema-keyword leaves (`type`, `format`, ...)
 * whose generic message needs the path prefix. The `*-param` codes
 * cover only the validator-emitted modes: missing-required, unknown
 * key under `strictQueryParameters`, and `content` media-type parse
 * failures, all of which quote the parameter name. `route`, `method`,
 * and `status` belong here trivially (their paths are empty).
 *
 * The branch codes `request` and `response` are excluded: they never
 * appear as leaves, so summary renderers never see them.
 *
 * Guarded by tests on both sides: this package asserts the subset
 * relation, and `@oaverify/internal-validator`'s error-codes suite asserts every
 * emitted leaf with one of these codes names its location in the
 * message.
 *
 * @public
 */
export const SELF_LOCATING_ERROR_CODES = [
  "route",
  "method",
  "body",
  "content-type",
  "status",
  "path-param",
  "query-param",
  "header-param",
  "cookie-param",
  "security",
] as const satisfies ReadonlyArray<keyof BuiltInErrorParams>;

/**
 * Type helper that narrows `ValidationError.params` for a specific
 * `code`. The generic parameter must be a key of
 * {@link BuiltInErrorParams}.
 *
 * ```ts
 * function describe(err: ValidationError): string {
 *   if (err.code === "required") {
 *     const p = err.params as ErrorParamsFor<"required">;
 *     return `missing ${p.missing}`;
 *   }
 *   return err.message;
 * }
 * ```
 *
 * @public
 */
export type ErrorParamsFor<Code extends keyof BuiltInErrorParams> = BuiltInErrorParams[Code];

/**
 * A single validation error, always a node in a {@link ValidationError} tree.
 *
 * Every error has a `children` array; leaf errors have `children: []`,
 * branch errors produced by applicator keywords have one child per relevant
 * subschema. Consumers can traverse without null checks.
 *
 * @remarks
 * The `code` field is a stable identifier (e.g. `"type"`, `"required"`,
 * `"oneOf"`, `"body"`) suitable for programmatic matching. The `message`
 * field is free-form human-readable text and SHOULD NOT be pattern-matched.
 * Machine-readable details live in `params`.
 *
 * @public
 */
export interface ValidationError {
  /** Stable identifier of the keyword or validation layer that produced this error. */
  code: string;
  /**
   * Path segments pointing at the offending data location. Read-only: the
   * validator snapshots/freezes these at construction and never mutates them.
   */
  readonly path: readonly PathSegment[];
  /** Human-readable description of the failure. */
  message: string;
  /**
   * Keyword-specific machine-readable details. The shape per `code` is
   * documented in {@link BuiltInErrorParams}; consumers can use
   * {@link ErrorParamsFor} to narrow. Read-only after construction.
   */
  readonly params: Readonly<Record<string, unknown>>;
  /** Child errors; always an array, empty for leaf errors. Read-only after construction. */
  readonly children: readonly ValidationError[];
}

/**
 * Parameters accepted by {@link createError}.
 *
 * @public
 */
export interface CreateErrorParams {
  /** Stable identifier of the keyword/layer. */
  code: string;
  /** Path segments of the offending data. */
  path: readonly PathSegment[];
  /** Human-readable message. */
  message: string;
  /** Machine-readable details. Defaults to `{}`. */
  params?: Readonly<Record<string, unknown>>;
  /** Child errors. Defaults to `[]`. */
  children?: readonly ValidationError[];
}

/**
 * Construct a {@link ValidationError}, supplying defaults for `params` and
 * `children` so callers never have to write `params: {}, children: []`.
 *
 * @param params - Fields describing the error.
 * @returns A new {@link ValidationError} with `children` guaranteed to be an array.
 *
 * @example
 * ```ts
 * const err = createError({
 *   code: "type",
 *   path: ["body", "age"],
 *   message: "must be number",
 *   params: { expected: "number", actual: "string" },
 * });
 * // err.children === []
 * ```
 *
 * @public
 */
export function createError(params: CreateErrorParams): ValidationError {
  // Snapshot path: generated validators reuse a single mutable path array
  // across traversal (push/pop per depth), so freezing the segments here
  // protects the error from later mutations.
  return {
    code: params.code,
    path: [...params.path],
    message: params.message,
    params: params.params ?? EMPTY_PARAMS,
    children: params.children ?? [],
  };
}

/**
 * Construct a leaf error. Equivalent to {@link createError} with an empty
 * `children` array; exists to make intent explicit at call sites.
 *
 * @param code - Stable identifier (e.g. `"type"`, `"required"`).
 * @param path - Path segments to the offending data.
 * @param message - Human-readable description.
 * @param params - Optional machine-readable details.
 * @returns A new leaf {@link ValidationError}.
 *
 * @example
 * ```ts
 * createLeafError("type", ["body", "age"], "must be number", {
 *   expected: "number",
 * });
 * ```
 *
 * @public
 */
export function createLeafError(
  code: string,
  path: PathSegment[],
  message: string,
  params: Record<string, unknown> = EMPTY_PARAMS,
  extraSegment?: PathSegment,
  extraSegment2?: PathSegment,
): ValidationError {
  // Children: a shared frozen empty array rather than a fresh `[]` on
  // every leaf. Saves one allocation per failure on hot invalid paths.
  // Leaves never accumulate children; the type is
  // `ValidationError[]` (mutable) for branch uses, but readers should
  // treat a leaf's array as read-only, which is the existing contract.
  //
  // The `extraSegment` / `extraSegment2` tail parameters let generated
  // validators append up to two path segments without allocating an
  // intermediate array at the call site: we pass the base `path` plus
  // the extras and build the final path here in one allocation. The
  // two-slot form supports inlined-with-segment subschemas whose
  // leaves themselves append another segment (e.g. an inlined
  // `required` under a `properties` entry). Deeper nesting (>2
  // trailing segments) is rare enough that callers pre-materialize the
  // full path rather than burn more runtime params on it.
  const finalPath =
    extraSegment2 !== undefined
      ? [...path, extraSegment!, extraSegment2]
      : extraSegment !== undefined
        ? [...path, extraSegment]
        : [...path];
  return { code, path: finalPath, message, params, children: EMPTY_CHILDREN };
}

// Shared frozen empty array so leaf errors reuse one `children` value
// instead of allocating a fresh `[]` per failure. `children` is
// `readonly ValidationError[]`, so the frozen empty array assigns
// directly; the freeze is a runtime safety net against accidental mutation.
const EMPTY_CHILDREN: readonly ValidationError[] = Object.freeze([]);

// Shared frozen empty params for the common no-details case (branch
// wrappers like the "schema" node, leaves whose `code` carries no
// params). Mirrors EMPTY_CHILDREN: one value instead of a fresh `{}`
// per error. `params` is `readonly` by type, so the frozen object
// assigns directly; the freeze is the runtime safety net. Call sites
// that do carry details pass their own object and never see this.
const EMPTY_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Construct a branch error that wraps a list of child errors (e.g. the
 * per-branch failures of an `oneOf` keyword).
 *
 * @param code - Stable identifier (e.g. `"oneOf"`, `"allOf"`, `"body"`).
 * @param path - Path segments to the offending data.
 * @param message - Human-readable description.
 * @param children - Child errors.
 * @param params - Optional machine-readable details.
 * @returns A new branch {@link ValidationError}.
 *
 * @example
 * ```ts
 * createBranchError(
 *   "oneOf",
 *   ["body"],
 *   "must match exactly one of 2 schemas",
 *   [branch0Error, branch1Error],
 *   { matchCount: 0 },
 * );
 * ```
 *
 * @public
 */
export function createBranchError(
  code: string,
  path: PathSegment[],
  message: string,
  children: ValidationError[],
  params: Record<string, unknown> = EMPTY_PARAMS,
  extraSegment?: PathSegment,
  extraSegment2?: PathSegment,
): ValidationError {
  // See note in {@link createLeafError} on `extraSegment` / `extraSegment2`.
  const finalPath =
    extraSegment2 !== undefined
      ? [...path, extraSegment!, extraSegment2]
      : extraSegment !== undefined
        ? [...path, extraSegment]
        : [...path];
  return { code, path: finalPath, message, params, children };
}

/**
 * Walk a {@link ValidationError} tree in pre-order, visiting every node
 * (branch and leaf).
 *
 * @param error - Root of the error tree.
 * @param visit - Callback invoked once per node with the node and its depth.
 *
 * @example
 * ```ts
 * walkErrors(root, (err, depth) => {
 *   console.log(" ".repeat(depth) + err.code);
 * });
 * ```
 *
 * @public
 */
export function walkErrors(
  error: ValidationError,
  visit: (error: ValidationError, depth: number) => void,
): void {
  const stack: Array<{ node: ValidationError; depth: number }> = [{ node: error, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    visit(entry.node, entry.depth);
    for (let i = entry.node.children.length - 1; i >= 0; i -= 1) {
      const child = entry.node.children[i];
      if (child !== undefined) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
}

/**
 * Collect every leaf error (any node with `children.length === 0`) in a
 * {@link ValidationError} tree. Order is a pre-order traversal.
 *
 * @param error - Root of the error tree.
 * @returns The flat list of leaves in traversal order.
 *
 * @example
 * ```ts
 * const leaves = collectLeaves(rootError);
 * leaves.forEach((leaf) => console.log(leaf.code));
 * ```
 *
 * @public
 */
export function collectLeaves(error: ValidationError): ValidationError[] {
  const leaves: ValidationError[] = [];
  walkErrors(error, (node) => {
    if (node.children.length === 0) leaves.push(node);
  });
  return leaves;
}

/**
 * Format a path as a JSON-Pointer-ish dotted string, e.g.
 * `body.users[3].email`. Intended for human consumption; not a spec-conformant
 * JSON Pointer.
 *
 * @param path - Path segments.
 * @returns A dotted path string, or `""` if empty.
 *
 * @example
 * ```ts
 * joinPath(["body", "users", 3, "email"]); // "body.users[3].email"
 * ```
 *
 * @public
 */
export function joinPath(path: readonly PathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (out.length === 0) {
      out = segment;
    } else {
      out += `.${segment}`;
    }
  }
  return out;
}
