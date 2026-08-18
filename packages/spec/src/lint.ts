import {
  escapePointerSegment,
  pointerFromFragment,
  resolveJsonPointer,
  type ComponentsObject,
  type OpenAPIDocument,
  type OperationObject,
  type ParameterObject,
  type PathItem,
  type ReferenceObject,
  type TagObject,
} from "@oaverify/internal-core";

/**
 * A single spec-hygiene finding from {@link lintResolvedSpec}.
 *
 * Findings are reported, never fatal: the spec is structurally valid, the
 * shape just looks like an authoring mistake (declared but unused,
 * referenced but undeclared).
 *
 * @public
 */
export interface SpecHygieneIssue {
  /**
   * - `"unused-component"`: a `components.{schemas,parameters,requestBodies,responses,headers,securitySchemes}`
   *   entry that no operation reaches.
   * - `"unused-tag"`: a `tags[]` entry whose name doesn't appear in any
   *   operation's `tags` array.
   * - `"unreachable-defs"`: a `$defs/<name>` entry inside a schema that no
   *   `$ref` in the document points to.
   * - `"path-param-undeclared"`: a `{name}` placeholder in a path template
   *   with no matching `parameters: [{ in: "path", name }]` declaration on
   *   the operation or its path-item.
   * - `"path-param-unused"`: a `parameters: [{ in: "path", name }]`
   *   declaration whose name doesn't appear as a placeholder in the path
   *   template.
   * - `"path-template-malformed"`: a path template whose literal text
   *   carries a percent escape that is not decodable (`/bad%zz`, a
   *   trailing `%`). The router keeps such a segment in its raw form, so
   *   the route only matches a request path that repeats the same broken
   *   escape.
   */
  code:
    | "unused-component"
    | "unused-tag"
    | "unreachable-defs"
    | "path-param-undeclared"
    | "path-param-unused"
    | "path-template-malformed";
  /** RFC 6901 JSON Pointer to the offending node in the resolved document. */
  pointer: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * What {@link lintResolvedSpec} cannot see in the document it is given.
 *
 * Resolution is lossy in one direction that matters to hygiene: a
 * non-schema component referenced across documents is inlined at the
 * use site, so its content survives and the component itself becomes
 * unreachable. Everything else the rules need is in the document.
 *
 * @public
 */
export interface LintOptions {
  /**
   * Components the resolver inlined at a use site, as pointers
   * (`/components/parameters/PageSize`). `unused-component` stays quiet
   * about these. Comes from {@link ResolvedSpec.inlinedComponents};
   * omitting it restores the pre-#612 behaviour, which reports them.
   */
  inlinedComponents?: readonly string[];
}

const COMPONENT_CATEGORIES = [
  "schemas",
  "parameters",
  "requestBodies",
  "responses",
  "headers",
  "securitySchemes",
] as const satisfies readonly (keyof ComponentsObject)[];

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

const PATH_TEMPLATE_RE = /\{([^{}]+)\}/g;
// Splitting form: the capture group keeps the placeholders in the output
// so a caller can tell them from the literal runs either side.
const PLACEHOLDER_SPLIT_RE = /(\{[^{}]+\})/g;
const PLACEHOLDER_RE = /^\{[^{}]+\}$/;

/**
 * Lint a resolved OpenAPI document for spec-hygiene issues.
 *
 * Pure: the document is not mutated. Run after
 * {@link resolveSpec | resolveSpec} so external `$ref`s are resolved:
 * schema targets hoisted into `components.schemas`, other objects
 * inlined, and a circular non-schema ref left under
 * `x-oaverify-externals`. Hoisted schemas are ordinary components and
 * are linted as such, so one referenced by nothing is reported unused
 * like any other.
 *
 * The lint walks the whole resolved document, the externals field
 * included: a `$defs` inside stitched content is reported exactly as one
 * anywhere else would be. That is deliberate rather than overlooked.
 * Those entries came from a file the author wrote, so a dead one is
 * still worth knowing about; only the resolver's own bookkeeping keys
 * are skipped.
 *
 * The five checks:
 *
 * - **unused-component**: components defined but not reached from any
 *   operation, security requirement, or `discriminator.mapping`.
 * - **unused-tag**: top-level `tags[]` entry with no operation referring to
 *   it.
 * - **unreachable-defs**: per-schema `$defs/<name>` that no `$ref`
 *   in the document points to.
 * - **path-param-undeclared / path-param-unused**: mismatch between the
 *   `{name}` placeholders in a path template and the path-parameter
 *   declarations on the operation + its path-item.
 * - **path-template-malformed**: a path template whose literal text
 *   carries a percent escape that does not decode, leaving the route
 *   matchable only by a request repeating the same broken escape.
 *
 * @param document - The resolved document to grade.
 * @param options - What the document alone cannot say. See
 *   {@link LintOptions}.
 * @returns Findings, in check order and then in the document's
 *   declaration order within each check. Empty array means clean spec.
 *
 * @public
 */
export function lintResolvedSpec(
  document: OpenAPIDocument,
  options: LintOptions = {},
): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  issues.push(...findUnusedComponents(document, options.inlinedComponents ?? []));
  issues.push(...findUnusedTags(document));
  issues.push(...findUnreachableDefs(document));
  issues.push(...findPathParamMismatches(document));
  issues.push(...findMalformedPathTemplates(document));
  return issues;
}

// ---------------------------------------------------------------------------
// unused-component
// ---------------------------------------------------------------------------

function findUnusedComponents(
  document: OpenAPIDocument,
  inlinedComponents: readonly string[],
): SpecHygieneIssue[] {
  const components = document.components;
  if (!components) return [];
  const inlined = new Set(inlinedComponents);

  const declared = new Set<string>();
  for (const category of COMPONENT_CATEGORIES) {
    const bucket = components[category];
    if (!bucket) continue;
    for (const name of Object.keys(bucket)) {
      declared.add(`${category}/${name}`);
    }
  }
  if (declared.size === 0) return [];

  const reached = collectReachableComponents(document);

  const issues: SpecHygieneIssue[] = [];
  for (const category of COMPONENT_CATEGORIES) {
    const bucket = components[category];
    if (!bucket) continue;
    for (const name of Object.keys(bucket)) {
      const key = `${category}/${name}`;
      if (reached.has(key)) continue;
      const pointer = `/components/${category}/${escapePointerSegment(name)}`;
      // Referenced from another document and inlined at the use site,
      // so the resolved document reaches its content without reaching
      // it. Say nothing rather than say "unused": the rule cannot tell
      // this apart from an orphan by looking at the document it has.
      if (inlined.has(pointer)) continue;
      issues.push({
        code: "unused-component",
        pointer,
        message: `components.${category}.${name} is declared but no operation reaches it`,
      });
    }
  }
  return issues;
}

/**
 * Walk roots (operations, top-level + per-op `security`,
 * `discriminator.mapping`), collect every `$ref` target into
 * `components/*` and every `securitySchemes` name referenced. Iterates
 * to a fixed point so component-to-component refs propagate.
 */
function collectReachableComponents(document: OpenAPIDocument): Set<string> {
  // Direct refs collected from non-component roots.
  const fromRoots = new Set<string>();
  // Map from a component key (e.g. "schemas/Pet") to refs it makes.
  const componentEdges = new Map<string, Set<string>>();

  // Index: every $ref / security-scheme reference in the document, paired
  // with a "source" path so we can attribute it to a containing component
  // (for transitive-closure) or to a non-component root.
  collectAllRefs(document, fromRoots, componentEdges);

  // Closure: anything reached from roots, plus anything reached from
  // already-reached components.
  const reached = new Set<string>(fromRoots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of reached) {
      const edges = componentEdges.get(key);
      if (!edges) continue;
      for (const target of edges) {
        if (!reached.has(target)) {
          reached.add(target);
          changed = true;
        }
      }
    }
  }
  return reached;
}

function collectAllRefs(
  document: OpenAPIDocument,
  fromRoots: Set<string>,
  componentEdges: Map<string, Set<string>>,
): void {
  // Top-level security scheme references.
  for (const req of document.security ?? []) {
    for (const schemeName of Object.keys(req)) {
      fromRoots.add(`securitySchemes/${schemeName}`);
    }
  }

  // Operations under paths.
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;
    walkPathItem(pathItem, fromRoots);
    walkAnyRefs(pathItem, fromRoots);
    void pathTemplate;
  }
  // Operations under webhooks (3.1+).
  for (const [, webhook] of Object.entries(document.webhooks ?? {})) {
    if (!webhook || isReference(webhook)) continue;
    walkPathItem(webhook, fromRoots);
    walkAnyRefs(webhook, fromRoots);
  }
  // Operations under components.pathItems would belong here too, but the
  // type doesn't expose pathItems; the generic walkAnyRefs over the whole
  // document below catches every $ref regardless.

  // Components: edges from each component to whatever it refs.
  const components = document.components;
  if (!components) return;
  for (const category of COMPONENT_CATEGORIES) {
    const bucket = components[category];
    if (!bucket) continue;
    for (const [name, value] of Object.entries(bucket)) {
      const key = `${category}/${name}`;
      const edges = new Set<string>();
      walkAnyRefs(value, edges);
      if (edges.size > 0) componentEdges.set(key, edges);
    }
  }
}

function walkPathItem(pathItem: PathItem, sink: Set<string>): void {
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    for (const req of op.security ?? []) {
      for (const schemeName of Object.keys(req)) {
        sink.add(`securitySchemes/${schemeName}`);
      }
    }
  }
}

/**
 * Recursive walk that captures every `$ref` whose target is
 * `#/components/<category>/<name>` and every `discriminator.mapping`
 * value pointing at the same shape. Adds to `sink` as
 * `<category>/<name>`.
 */
function walkAnyRefs(value: unknown, sink: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkAnyRefs(item, sink);
    return;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string") {
    const key = parseComponentRef(ref);
    if (key) sink.add(key);
  }
  const discriminator = obj.discriminator;
  if (discriminator && typeof discriminator === "object") {
    const mapping = (discriminator as { mapping?: unknown }).mapping;
    if (mapping && typeof mapping === "object") {
      for (const target of Object.values(mapping as Record<string, unknown>)) {
        if (typeof target === "string") {
          const key = parseComponentRef(target);
          if (key) sink.add(key);
        }
      }
    }
  }
  for (const v of Object.values(obj)) walkAnyRefs(v, sink);
}

function parseComponentRef(ref: string): string | null {
  // Match `#/components/<category>/<name>` exactly. Reject deeper
  // pointers (e.g. `#/components/schemas/Pet/properties/id`); those
  // still mark the component as reached, so accept the prefix too.
  const m = /^#\/components\/([^/]+)\/([^/]+)/.exec(ref);
  if (!m) return null;
  const category = decodePointerSegment(m[1]!);
  const name = decodePointerSegment(m[2]!);
  if (!(COMPONENT_CATEGORIES as readonly string[]).includes(category)) return null;
  return `${category}/${name}`;
}

// ---------------------------------------------------------------------------
// unused-tag
// ---------------------------------------------------------------------------

function findUnusedTags(document: OpenAPIDocument): SpecHygieneIssue[] {
  const declared: TagObject[] = document.tags ?? [];
  if (declared.length === 0) return [];
  const used = new Set<string>();
  const collect = (op: OperationObject | undefined): void => {
    if (!op) return;
    for (const tag of op.tags ?? []) used.add(tag);
  };
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) collect(pathItem[method]);
  }
  for (const webhook of Object.values(document.webhooks ?? {})) {
    if (!webhook || isReference(webhook)) continue;
    for (const method of HTTP_METHODS) collect(webhook[method]);
  }

  const issues: SpecHygieneIssue[] = [];
  for (let i = 0; i < declared.length; i += 1) {
    const tag = declared[i]!;
    if (used.has(tag.name)) continue;
    issues.push({
      code: "unused-tag",
      pointer: `/tags/${i}`,
      message: `tag "${tag.name}" is declared but no operation references it`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// unreachable-defs
// ---------------------------------------------------------------------------

function findUnreachableDefs(document: OpenAPIDocument): SpecHygieneIssue[] {
  // Find every $defs container with its location, then for each entry
  // see whether any $ref in the document points at that location.
  // Conservative: a ref from outside the containing schema also counts as
  // "reached", which avoids false positives when a $defs entry is genuinely
  // shared across schemas via absolute pointers.
  const allRefs = new Set<string>();
  collectEveryRefValue(document, allRefs);

  const issues: SpecHygieneIssue[] = [];
  walkForDefs(document, "", (defsPointer, name) => {
    // The resolver's own bookkeeping, not something an author wrote:
    // always referenced by construction. Kept for a document resolved by
    // an older oaverify, whose stitched externals sat under
    // `$defs.__ext__`; current output puts them in an `x-` field, which
    // is not a `$defs` map and so never produces a name here. Content
    // *inside* the externals field is still walked, and a dead `$defs`
    // there is reported like any other.
    if (name.startsWith("__ext__/")) return;
    const target = `${defsPointer}/${escapePointerSegment(name)}`;
    if (refsHit(allRefs, target)) return;
    issues.push({
      code: "unreachable-defs",
      pointer: target,
      message: `$defs entry "${name}" at ${defsPointer.slice(0, -"/$defs".length) || "/"} is not referenced by any $ref`,
    });
  });
  return issues;
}

function collectEveryRefValue(value: unknown, sink: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectEveryRefValue(item, sink);
    return;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#")) {
    sink.add(ref);
  }
  for (const v of Object.values(obj)) collectEveryRefValue(v, sink);
}

function walkForDefs(
  value: unknown,
  pointer: string,
  visit: (defsPointer: string, name: string) => void,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkForDefs(value[i], `${pointer}/${i}`, visit);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    const childPointer = `${pointer}/${escapePointerSegment(key)}`;
    if (key === "$defs" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const name of Object.keys(child as Record<string, unknown>)) {
        visit(childPointer, name);
      }
    }
    walkForDefs(child, childPointer, visit);
  }
}

function refsHit(allRefs: Set<string>, targetPointer: string): boolean {
  // `targetPointer` is like `/components/schemas/Pet/$defs/Inner`.
  // A ref hits if some `#`-prefixed value matches `#<targetPointer>` or
  // extends it (`#<targetPointer>/...`).
  const exact = `#${targetPointer}`;
  if (allRefs.has(exact)) return true;
  const prefix = `${exact}/`;
  for (const ref of allRefs) {
    if (ref.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// path-param-undeclared / path-param-unused
// ---------------------------------------------------------------------------

function findPathParamMismatches(document: OpenAPIDocument): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;
    const inTemplate = extractPathTemplateNames(pathTemplate);
    const pathItemPointer = `/paths/${escapePointerSegment(pathTemplate)}`;
    const itemLevelDeclared = collectPathParams(pathItem.parameters ?? [], document);
    // A `parameters` that is not a list is unreadable rather than empty,
    // so what it declares is unknown. Claiming a template name is
    // undeclared would be a false statement about a document whose
    // author did write it, one missing `- ` away. The conformance pass
    // reports `must be array` at the pointer, and this rule stays quiet
    // for that operation (#837).
    const itemListUnreadable = !isParameterList(pathItem.parameters);
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const opPointer = `${pathItemPointer}/${method}`;
      const opLevelDeclared = collectPathParams(op.parameters ?? [], document);
      if (itemListUnreadable || !isParameterList(op.parameters)) continue;

      // OpenAPI: operation-level parameters with same (name, in) override
      // path-item-level. Compute the effective set by name.
      const effective = new Map<string, "item" | "op">();
      for (const name of itemLevelDeclared) effective.set(name, "item");
      for (const name of opLevelDeclared) effective.set(name, "op");

      for (const name of inTemplate) {
        if (effective.has(name)) continue;
        issues.push({
          code: "path-param-undeclared",
          pointer: opPointer,
          message: `path template "${pathTemplate}" references "{${name}}" but neither the operation nor its path item declares a path parameter named "${name}"`,
        });
      }
      for (const [name, source] of effective) {
        if (inTemplate.has(name)) continue;
        issues.push({
          code: "path-param-unused",
          pointer: source === "op" ? `${opPointer}/parameters` : `${pathItemPointer}/parameters`,
          message: `path parameter "${name}" is declared on ${source === "op" ? "the operation" : "the path item"} but does not appear in the path template "${pathTemplate}"`,
        });
      }
    }
  }
  return issues;
}

/**
 * Path templates carrying a segment whose percent-encoding does not
 * decode. Only literal text is checked, the runs around a placeholder
 * included: a `{name}` placeholder itself is matched as a captured
 * token, never decoded as spec text.
 *
 * The router tolerates these, falling back to the raw segment rather
 * than throwing `URIError` out of `createValidator`. That leaves the
 * route unreachable except by a client repeating the same broken
 * escape. Reporting it here is what gives that a location and a remedy.
 */
function findMalformedPathTemplates(document: OpenAPIDocument): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  for (const pathTemplate of Object.keys(document.paths ?? {})) {
    const bad = firstUndecodableSegment(pathTemplate);
    if (bad === undefined) continue;
    issues.push({
      code: "path-template-malformed",
      pointer: `/paths/${escapePointerSegment(pathTemplate)}`,
      message: `path template "${pathTemplate}" has a segment "${bad}" whose percent-encoding does not decode; percent-encode a literal "%" as "%25"`,
    });
  }
  return issues;
}

/**
 * The first path segment whose percent-encoding `decodeURIComponent`
 * rejects, or `undefined` when every segment decodes.
 *
 * Asks the same question of the same text as the router. `parseTemplate`
 * splits on `/` and hands each segment to `parseSegment`, which decodes
 * a placeholder-free segment whole and decodes each literal run of a
 * segment that also carries a `{name}`. Both are checked here, so the
 * two agree run for run.
 *
 * Decoding whole runs rather than individual `%XX` escapes is what keeps
 * a valid multi-byte sequence legal: `%C3%A9` is one two-byte UTF-8
 * character, and each half throws on its own.
 */
function firstUndecodableSegment(template: string): string | undefined {
  for (const segment of template.split("/")) {
    if (!segment.includes("%")) continue;
    for (const run of decodedRuns(segment)) {
      if (!run.includes("%")) continue;
      try {
        decodeURIComponent(run);
      } catch {
        return segment;
      }
    }
  }
  return undefined;
}

/**
 * The parts of a segment that `parseSegment` decodes.
 *
 * A `{name}` is captured from the request rather than read as spec text,
 * so it is not one of them. Everything else in the segment is, including
 * the literal runs either side of a placeholder, and including a lone
 * `{` with no closing brace, which `parseSegment` falls back to
 * treating as literal text.
 */
function decodedRuns(segment: string): string[] {
  if (!holdsPlaceholder(segment)) return [segment];
  return segment.split(PLACEHOLDER_SPLIT_RE).filter((part) => !PLACEHOLDER_RE.test(part));
}

/**
 * Whether `parseSegment` reads this segment as a template or compound
 * rather than a literal.
 *
 * The condition is a `{` with a `}` somewhere after it: that is what
 * makes `parseSegment`'s scan record a name. A `{` with no closing brace
 * is the degenerate case it falls back to a literal decode for, so a
 * segment like `x%zz{` is spec text end to end.
 */
function holdsPlaceholder(segment: string): boolean {
  const open = segment.indexOf("{");
  return open !== -1 && segment.indexOf("}", open) !== -1;
}

function extractPathTemplateNames(template: string): Set<string> {
  const names = new Set<string>();
  for (const match of template.matchAll(PATH_TEMPLATE_RE)) {
    names.add(match[1]!);
  }
  return names;
}

/** `parameters` is absent or a list, so what it declares is readable. */
function isParameterList(parameters: unknown): boolean {
  return parameters === undefined || Array.isArray(parameters);
}

function collectPathParams(parameters: unknown, document: OpenAPIDocument): Set<string> {
  const names = new Set<string>();
  // OpenAPI declares `parameters` as an array. A document writing one
  // parameter as a mapping is a missing `- `, and iterating it threw
  // `parameters is not iterable` out of the whole lint, which took
  // `oaverify check` to exit 3 naming nothing. Reading it as no
  // parameters lets the run reach the conformance pass, which reports
  // `must be array` at the offending pointer (#837).
  if (!Array.isArray(parameters)) return names;
  for (const entry of parameters as readonly (ParameterObject | ReferenceObject)[]) {
    const param = isReference(entry) ? resolveParamRef(entry, document) : entry;
    if (!param) continue;
    if (param.in === "path") names.add(param.name);
  }
  return names;
}

function resolveParamRef(ref: ReferenceObject, document: OpenAPIDocument): ParameterObject | null {
  // A `$ref` carries a URI fragment, so it is percent-decoded into a
  // pointer before evaluation; `resolveJsonPointer` does none itself.
  const pointer = pointerFromFragment(ref.$ref.startsWith("#") ? ref.$ref.slice(1) : ref.$ref);
  try {
    const target = resolveJsonPointer(document, pointer);
    if (target && typeof target === "object" && "in" in target && "name" in target) {
      return target as unknown as ParameterObject;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isReference(value: unknown): value is ReferenceObject {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
