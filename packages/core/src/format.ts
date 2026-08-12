import {
  SELF_LOCATING_ERROR_CODES,
  collectLeaves,
  joinPath,
  walkErrors,
  type ValidationError,
} from "./errors.js";

const SELF_LOCATING = new Set<string>(SELF_LOCATING_ERROR_CODES);

/**
 * Options accepted by the text/flat formatters.
 *
 * @public
 */
export interface FormatOptions {
  /** Maximum depth to render; nodes deeper than this are truncated with `…`. Defaults to Infinity. */
  maxDepth?: number;
  /** String used for each level of indentation in `formatText`. Defaults to `"  "`. */
  indent?: string;
}

/**
 * Render validation errors as an indented human-readable string.
 * Accepts either a nested error tree (`output: "tree"`) or the flat leaf
 * list the default validator returns; a flat list renders one line per
 * leaf.
 *
 * @remarks
 * Every node renders as `<path> <message> [<code>]`. Children are indented
 * under their parent. The output is meant for terminals and logs, not
 * programmatic consumption; use {@link toJsonObject} or
 * {@link formatSummary} for that.
 *
 * @param error - Root of the error tree, or a flat list of leaves.
 * @param options - Optional rendering settings.
 * @returns A multi-line string ready to print.
 *
 * @example
 * ```ts
 * const r = validator.validateRequest(httpRequest);
 * if (!r.valid) console.error(formatText(r.errors));
 * ```
 *
 * @public
 */
export function formatText(
  error: ValidationError | readonly ValidationError[],
  options: FormatOptions = {},
): string {
  const indent = options.indent ?? "  ";
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  const render = (node: ValidationError, depth: number): void => {
    if (depth > maxDepth) {
      lines.push(`${indent.repeat(depth)}…`);
      return;
    }
    const prefix = indent.repeat(depth);
    const location = joinPath(node.path);
    const pathPart = location.length > 0 ? `${location} ` : "";
    lines.push(`${prefix}${pathPart}${node.message} [${node.code}]`);
    for (const child of node.children) render(child, depth + 1);
  };
  for (const root of Array.isArray(error) ? error : [error as ValidationError]) render(root, 0);
  return lines.join("\n");
}

/**
 * Return a {@link ValidationError} tree as a JSON-safe plain object.
 *
 * @remarks
 * The returned object has the same shape as the input but is freshly
 * constructed (deep-cloned `children`, `path`, and `params`), so it
 * round-trips losslessly through `JSON.stringify` / `JSON.parse`.
 *
 * Accepts either a single tree root or the flat leaf list the default
 * (flat-output) validator returns; a list round-trips to a list.
 *
 * @param error - Root of the error tree, or a flat list of errors.
 * @returns A structurally identical copy of the tree (or list), safe to hand to `JSON.stringify`.
 *
 * @example
 * ```ts
 * JSON.stringify(toJsonObject(rootError), null, 2);
 * JSON.stringify(toJsonObject(result.errors), null, 2); // flat output
 * ```
 *
 * @public
 */
export function toJsonObject(error: ValidationError): ValidationError;
export function toJsonObject(error: readonly ValidationError[]): ValidationError[];
export function toJsonObject(
  error: ValidationError | readonly ValidationError[],
): ValidationError | ValidationError[] {
  if (Array.isArray(error)) return error.map((e) => toJsonObject(e));
  const e = error as ValidationError;
  return {
    code: e.code,
    path: [...e.path],
    message: e.message,
    params: { ...e.params },
    children: e.children.map((c) => toJsonObject(c)),
  };
}

/**
 * Leaf-selection policy for {@link formatSummary}.
 *
 * - `"first"`: the first leaf in tree-traversal order. Matches
 *   `express-openapi-validator`'s top-level `message`. The default.
 * - `"deepest"`: the leaf with the longest path. More informative
 *   on `oneOf` / composition trees where the structural cause sits
 *   one or two levels in. Tiebreak: first encountered.
 * - `"all"`: every leaf, one per line, each prefixed with its path
 *   and suffixed with its `[code]`. Use this when you want a flat
 *   enumeration of every issue (e.g. eov-style flat error messages,
 *   `grep`-friendly logs, CI diffs).
 * - `{ byCode }`: priority list of error codes. Returns the first
 *   leaf whose `code` matches the highest-priority entry; if no leaf
 *   matches any listed code, falls back to the `"first"` policy.
 *
 * @public
 */
export type FormatSummarySelect = "first" | "deepest" | "all" | { byCode: readonly string[] };

/**
 * Options for {@link formatSummary}.
 *
 * @public
 */
export interface FormatSummaryOptions {
  /** How to pick which leaf (or leaves) to summarise. Defaults to `"first"`. */
  select?: FormatSummarySelect;
  /**
   * Separator between leaves under `select: "all"`. Defaults to `"\n"`.
   * Set to `", "` for `eov`-style flat output. No effect on single-leaf
   * modes (`"first"`, `"deepest"`, `{ byCode }`).
   */
  separator?: string;
  /**
   * Whether to suffix each leaf with ` [<code>]` under `select: "all"`.
   * Defaults to `true`. Set to `false` for `eov`-style output. No effect
   * on single-leaf modes (which never include the code).
   */
  includeCode?: boolean;
  /**
   * Path-prefix policy. `"always"` (the default) prefixes every leaf
   * with its dotted path. `"auto"` drops the prefix for leaves whose
   * code is in {@link SELF_LOCATING_ERROR_CODES}, the HTTP-level codes
   * whose message already names the failing parameter / body / check,
   * so `query.persona missing required query parameter "persona"`
   * renders as `missing required query parameter "persona"`.
   * Schema-keyword leaves (`type`, `enum`, ...) keep the prefix; their
   * generic messages need it. Applies to single-leaf modes and to each
   * line under `select: "all"`.
   */
  path?: "always" | "auto";
}

/**
 * Render validation errors as a one-line string. The workhorse for
 * HTTP response-body `message` fields, log lines, error-monitoring
 * titles, and `Error.message`. Accepts either a nested error tree
 * (`output: "tree"`) or the flat leaf list the default validator
 * returns.
 *
 * Two output shapes depending on {@link FormatSummaryOptions.select}:
 *
 * - **Single-leaf modes** (`"first"`, `"deepest"`, `{ byCode }`) pick one
 *   leaf and render it as `<dotted-path> <message>` (or just `<message>`
 *   when the path is empty). One line.
 * - **All-leaves mode** (`"all"`) enumerates every leaf, one entry per leaf,
 *   joined by {@link FormatSummaryOptions.separator} (default `"\n"`),
 *   each rendered as `<dotted-path> <message> [<code>]`. The trailing
 *   ` [<code>]` is suppressed when {@link FormatSummaryOptions.includeCode}
 *   is `false`. Tune both for `eov`-style flat output.
 *
 * In both shapes, {@link FormatSummaryOptions.path} `: "auto"` drops the
 * dotted-path prefix on leaves whose message already names its location
 * (the {@link SELF_LOCATING_ERROR_CODES} family), avoiding renderings
 * like `query.persona missing required query parameter "persona"`.
 *
 * For the indented full-tree view, use {@link formatText}; for the raw
 * JSON-safe object, use {@link toJsonObject}.
 *
 * @example
 * ```ts
 * formatSummary(rootError);
 * // "body.users[0].email must match format \"email\""
 *
 * formatSummary(rootError, { select: "deepest" });
 * // The leaf with the longest path. Useful on oneOf trees.
 *
 * formatSummary(rootError, { select: "all" });
 * // Every leaf, one per line:
 * //   body.users[0].email must match format "email" [format]
 * //   body.users[1].age must be >= 0 [minimum]
 *
 * formatSummary(rootError, { select: "all", separator: ", ", includeCode: false });
 * // eov-shaped flat output. (Path style still differs: eov uses
 * // slash-separated paths.)
 * //   body.users[0].email must match format "email", body.users[1].age must be >= 0
 *
 * formatSummary(rootError, { select: { byCode: ["content-type", "required"] } });
 * // The first content-type leaf if any, else the first required leaf,
 * // else the first leaf overall.
 *
 * formatSummary(missingParamError, { path: "auto" });
 * // "missing required query parameter \"persona\"" (no `query.persona`
 * // prefix; the message locates itself). Value errors keep the prefix:
 * // "body.users[0].email must match format \"email\"".
 * ```
 *
 * @public
 */
export function formatSummary(
  error: ValidationError | readonly ValidationError[],
  options: FormatSummaryOptions = {},
): string {
  const select = options.select ?? "first";
  const path = options.path ?? "always";
  const locationOf = (leaf: ValidationError): string =>
    path === "auto" && SELF_LOCATING.has(leaf.code) ? "" : joinPath(leaf.path);
  // Accept either a single tree root or the flat leaf list the default
  // (flat-output) validator returns. collectLeaves defines a leaf as any
  // node with no children, so a single-leaf root yields one entry; an
  // empty list yields none, hence the guard below before `leaves[0]`.
  const leaves = Array.isArray(error) ? error : collectLeaves(error as ValidationError);

  if (leaves.length === 0) return "";

  if (select === "all") {
    const separator = options.separator ?? "\n";
    const includeCode = options.includeCode ?? true;
    const lines: string[] = [];
    for (const leaf of leaves) {
      const location = locationOf(leaf);
      const pathPart = location.length > 0 ? `${location} ` : "";
      const codePart = includeCode ? ` [${leaf.code}]` : "";
      lines.push(`${pathPart}${leaf.message}${codePart}`);
    }
    return lines.join(separator);
  }

  let chosen: ValidationError = leaves[0]!;
  if (select === "deepest") {
    for (const leaf of leaves) {
      if (leaf.path.length > chosen.path.length) chosen = leaf;
    }
  } else if (select !== "first") {
    for (const code of select.byCode) {
      const match = leaves.find((l) => l.code === code);
      if (match !== undefined) {
        chosen = match;
        break;
      }
    }
  }

  const location = locationOf(chosen);
  return location.length > 0 ? `${location} ${chosen.message}` : chosen.message;
}

/**
 * Count the nodes in a {@link ValidationError} tree (branches + leaves).
 * Accepts a flat list too, in which case it sums the node count of each
 * root.
 *
 * @param error - Root of the error tree, or a flat list of errors.
 * @returns The total node count.
 *
 * @example
 * ```ts
 * countErrors(rootError); // 7
 * countErrors(result.errors); // flat output: one node per leaf
 * ```
 *
 * @public
 */
export function countErrors(error: ValidationError | readonly ValidationError[]): number {
  let n = 0;
  const roots = Array.isArray(error) ? error : [error as ValidationError];
  for (const root of roots) {
    walkErrors(root, () => {
      n += 1;
    });
  }
  return n;
}

/**
 * How much of a value a rendered detail shows before eliding.
 *
 * Sized for the two places this is read: a terminal line and a
 * diagnostic tooltip. The uncapped values travel as structured data
 * beside the message (`ExampleIssue.reasons`, SARIF's
 * `oaverify:reasons`), so the cap costs a reader nothing they cannot
 * get, and the message stays one line.
 */
const VALUE_ECHO_LIMIT = 60;

/** An enum worth naming in full is longer than one value. */
const ALLOWED_ECHO_LIMIT = 120;

/** A value as JSON, elided past `limit`. */
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
 * What the value was, and what was permitted, for the leaves whose
 * message alone cannot say.
 *
 * `must be one of the allowed values` is unactionable on its own: it
 * names neither the offending value nor the set, and recovering them
 * means opening the schema and following the `$ref` chain to the enum.
 * A consumer keying on the value cannot see it at all (#580).
 *
 * Confined to `enum`, `const` and `type`, the three whose message is a
 * bare assertion. The bounded keywords (`minLength`, `maximum`, ...)
 * already name their bound, and their `actual` is a count rather than a
 * value, so appending it would read as a second bound.
 *
 * Returns `""` for every other code, and for a `type` leaf whose
 * `actual` is not a type name, so a caller appends it unconditionally.
 *
 * ## Where this may be used, which is narrower than it looks
 *
 * Rendering a rejected value back to whoever wrote it. That is true of
 * a document's own examples and of a spec-conformance failure, where
 * the value is text the author typed. It is **not** true of a rejected
 * request body: echoing a request value into a 400 tells a caller what
 * their own input was, which is a decision the caller owns rather than
 * one this library takes for them. That is why the shared keyword
 * messages do not carry this and why it is applied at the call site.
 *
 * Lives here, beside the other renderers, because two call sites need
 * one answer: an example finding's summary and the located item a SARIF
 * related location carries for the same leaf. They rendered the same
 * leaf differently while this was private to one of them (#777).
 *
 * @param code - The leaf's error code.
 * @param params - The leaf's `params`.
 * @returns A leading-space suffix ready to append to a message, or `""`.
 *
 * @public
 */
export function formatLeafDetail(code: string, params: Readonly<Record<string, unknown>>): string {
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
