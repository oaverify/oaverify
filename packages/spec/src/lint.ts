import type { HoistedSchemaCopies } from "./schema-copies.js";
import { sourceOf, type SpecRegion } from "./provenance.js";
import {
  detectOpenAPIVersion,
  followsRef,
  pointerFromRefFragment,
  refPositionFor,
  type RefNodeKind,
  escapePointerSegment,
  pointerFromFragment,
  resolveJsonPointer,
  type ComponentsObject,
  type OpenAPIDocument,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type SecurityRequirementObject,
  type TagObject,
} from "@oaverify/internal-core";
import { subschemaEntries } from "@oaverify/internal-core/subschema-positions";
import { HTTP_METHODS } from "@oaverify/internal-core";

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
   * - `"duplicate-parameter"`: a `parameters` list declaring the same
   *   `name` and `in` twice, which OpenAPI forbids. An operation-level
   *   parameter overriding a path-level one is legal and not reported.
   * - `"duplicate-operation-id"`: two Operation Objects carrying the same
   *   `operationId`, which OpenAPI requires to be unique. One definition
   *   reached from several places is one operation and is not reported.
   * - `"security-scheme-undeclared"`: a security requirement naming a
   *   scheme that `components.securitySchemes` does not declare.
   * - `"server-variable-undeclared"`: a `{name}` in a server URL that the
   *   server's `variables` does not declare, which leaves the URL with no
   *   value to substitute.
   */
  code:
    | "unused-component"
    | "unused-tag"
    | "unreachable-defs"
    | "path-param-undeclared"
    | "path-param-unused"
    | "path-template-malformed"
    | "duplicate-parameter"
    | "duplicate-operation-id"
    | "security-scheme-undeclared"
    | "server-variable-undeclared";
  /** RFC 6901 JSON Pointer to the offending node in the resolved document. */
  pointer: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * What {@link lintResolvedSpec} cannot see in the document it is given.
 *
 * Resolution can inline a component or redirect a reference to a
 * hoisted schema, leaving the original declaration apparently unused.
 * These fields preserve the connections needed to grade those declarations.
 *
 * @public
 */
export interface LintOptions {
  /**
   * Components the resolver inlined at a use site, as pointers
   * (`/components/parameters/PageSize`). `unused-component` stays quiet
   * about these. Pass `inlinedComponents` returned by the resolver;
   * omit it and they are reported like any other unreached component.
   */
  inlinedComponents?: readonly string[];
  /**
   * Pass `hoistedSchemaCopies` returned by the resolver. See
   * {@link HoistedSchemaCopies} for the source identity contract.
   * Omit it to grade only references visible in the document.
   */
  hoistedSchemaCopies?: readonly HoistedSchemaCopies[];
  /**
   * Pass `regions` returned by the resolver, which it returns under
   * `provenance: true`. Resolution inlines a copy of an external
   * non-schema definition at each use site, and the regions say which
   * file each copy came from. `duplicate-operation-id` reads them to
   * tell copies of one definition from two definitions, and
   * `security-scheme-undeclared` to skip an OpenAPI 3.2 `#` name written
   * in another file. Omit it and copies of one external operation are
   * reported as duplicates, and such a name is looked up in this
   * document.
   */
  regions?: readonly SpecRegion[];
}

const COMPONENT_CATEGORIES = [
  "schemas",
  "parameters",
  "requestBodies",
  "responses",
  "headers",
  "securitySchemes",
] as const satisfies readonly (keyof ComponentsObject)[];

const REFERENCE_CONTAINERS = [
  ...COMPONENT_CATEGORIES,
  "pathItems",
  "callbacks",
  "mediaTypes",
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
 * Definition findings are restricted to schema positions. Example values
 * and vendor extensions are data unless a schema reference targets them.
 * Local references preserve the context of stitched external content, so
 * a schema reached there is checked at its physical document pointer.
 * If following a fragment reveals an enclosing `$id`, discovery repeats
 * using that resource. A cycle can make a target alternately resolve inside
 * that resource and at the document root; findings are then restricted to
 * schema positions present throughout the cycle. Definition-shaped data
 * reached under only one interpretation is omitted. The resolver's own
 * bookkeeping keys are skipped.
 *
 * The checks:
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
 * - **duplicate-parameter**: a Path Item or Operation `parameters` list
 *   repeating a `name` and `in` pair, in every Path Item the document
 *   defines (callbacks, webhooks and `components.pathItems` included).
 * - **duplicate-operation-id**: two operation definitions sharing an
 *   `operationId`, across the Path Items `duplicate-parameter` reads.
 * - **security-scheme-undeclared**: a document- or operation-level
 *   security requirement naming no declared scheme.
 * - **server-variable-undeclared**: a server URL placeholder with no
 *   entry in that server's `variables`, wherever a Server Object occurs.
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
  issues.push(...findUnreachableDefs(document, options.hoistedSchemaCopies ?? []));
  issues.push(...findPathParamMismatches(document));
  issues.push(...findMalformedPathTemplates(document));
  issues.push(...findDuplicateParameters(document));
  issues.push(...findDuplicateOperationIds(document, options.regions));
  issues.push(...findUndeclaredSecuritySchemes(document, options.regions));
  issues.push(...findUndeclaredServerVariables(document));
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
  for (const req of asSecurityList(document.security)) {
    for (const schemeName of Object.keys(req)) {
      fromRoots.add(`securitySchemes/${schemeName}`);
    }
  }

  // Operations under paths.
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (!pathItem) continue;
    walkPathItem(pathItem, fromRoots);
    walkAnyRefs(pathItem, fromRoots);
  }
  // Operations under webhooks (3.1+).
  for (const webhook of Object.values(document.webhooks ?? {})) {
    if (!webhook) continue;
    walkPathItem(webhook, fromRoots);
    walkAnyRefs(webhook, fromRoots);
  }
  // Components: edges from each component to whatever it refs.
  const components = document.components;
  if (!components) return;
  for (const category of REFERENCE_CONTAINERS) {
    // Document checks read newer containers before ComponentsObject exposes them.
    const bucket = (components as Record<string, unknown>)[category];
    if (!isObject(bucket)) continue;
    for (const [name, value] of Object.entries(bucket)) {
      const key = `${category}/${name}`;
      const edges = new Set<string>();
      walkAnyRefs(value, edges);
      if (category === "pathItems") walkPathItem(value, edges);
      if (category === "callbacks") walkCallback(value, edges);
      if (edges.size > 0) componentEdges.set(key, edges);
    }
  }
}

/**
 * A document's or an operation's `security` as a list to iterate.
 *
 * OpenAPI declares the field as an array, and a document writing one
 * requirement as a mapping is a missing `- `. Iterating that throws
 * `object is not iterable` out of the whole lint, taking `oaverify
 * check` to exit 3 naming nothing, which is the same shape an unreadable
 * `parameters` has (#837). Reading it as no requirements lets the run
 * reach the conformance pass, which reports `must be array` at the
 * offending pointer (#883).
 *
 * The lint's own subject here is which schemes are referenced, so an
 * unreadable requirement contributes none and `unused-component` may
 * then call a scheme unused. That is the same trade `path-param-mismatch`
 * takes for an unreadable `parameters`, and the conformance finding that
 * names the real defect sits alongside it.
 *
 * The request-time answer is deliberately different: an unreadable
 * `security` compiles to a failing requirement rather than to none, so a
 * document that meant to require auth does not serve anonymous traffic
 * while it is being fixed. See `compileOperationSecurity` in
 * `@oaverify/internal-validator`.
 */
function asSecurityList(security: unknown): readonly SecurityRequirementObject[] {
  if (!Array.isArray(security)) return [];
  // A list item written with nothing under it parses as `null`, which is
  // an element rather than a malformed container, so it survives the
  // array test and reached `Object.keys(null)`. Same throw, same exit 3
  // (#883).
  return (security as readonly unknown[]).filter(
    (req): req is SecurityRequirementObject =>
      req !== null && typeof req === "object" && !Array.isArray(req),
  );
}

// Unreadable containers contribute no edges; conformance reports their shape.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walkCallback(callback: unknown, sink: Set<string>): void {
  if (!isObject(callback)) return;
  for (const [expression, item] of Object.entries(callback)) {
    if (expression.startsWith("x-")) continue;
    walkPathItem(item, sink);
  }
}

/** Operation Objects and their pointer suffixes, including OAS 3.2 method tokens. */
function* operationEntries(item: unknown): Generator<[string, OperationObject]> {
  if (!isObject(item)) return;
  for (const method of HTTP_METHODS) {
    if (isObject(item[method])) yield [method, item[method] as OperationObject];
  }
  if (isObject(item.additionalOperations)) {
    for (const [method, operation] of Object.entries(item.additionalOperations)) {
      if (isObject(operation)) {
        yield [
          `additionalOperations/${escapePointerSegment(method)}`,
          operation as OperationObject,
        ];
      }
    }
  }
}

function walkPathItem(pathItem: unknown, sink: Set<string>): void {
  if (!isObject(pathItem)) return;
  for (const [, op] of operationEntries(pathItem)) {
    if (isObject(op.callbacks)) {
      for (const callback of Object.values(op.callbacks)) walkCallback(callback, sink);
    }
    for (const req of asSecurityList(op.security)) {
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
  if (!(REFERENCE_CONTAINERS as readonly string[]).includes(category)) return null;
  return `${category}/${name}`;
}

// ---------------------------------------------------------------------------
// unused-tag
// ---------------------------------------------------------------------------

function isNamedTag(tag: unknown): tag is TagObject {
  return (
    tag !== null && typeof tag === "object" && typeof (tag as { name?: unknown }).name === "string"
  );
}

function findUnusedTags(document: OpenAPIDocument): SpecHygieneIssue[] {
  // Unreadable lists and entries (`tags:\n  -` is `[null]`) contribute
  // nothing; conformance reports their shape.
  const declared: readonly unknown[] = Array.isArray(document.tags) ? document.tags : [];
  if (declared.length === 0) return [];
  const used = new Set<string>();
  const collect = (op: OperationObject | undefined): void => {
    if (!op || !Array.isArray(op.tags)) return;
    for (const tag of op.tags) used.add(tag);
  };
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (!pathItem) continue;
    for (const [, op] of operationEntries(pathItem)) collect(op);
  }
  for (const webhook of Object.values(document.webhooks ?? {})) {
    if (!webhook || isReference(webhook)) continue;
    for (const [, op] of operationEntries(webhook)) collect(op);
  }

  const issues: SpecHygieneIssue[] = [];
  for (let i = 0; i < declared.length; i += 1) {
    const tag = declared[i];
    if (!isNamedTag(tag) || used.has(tag.name)) continue;
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

function findUnreachableDefs(
  document: OpenAPIDocument,
  hoistedSchemaCopies: readonly HoistedSchemaCopies[],
): SpecHygieneIssue[] {
  // Find every $defs container with its location, then for each entry
  // see whether any $ref in the document points at that location.
  // Conservative: a ref from outside the containing schema also counts as
  // "reached", which avoids false positives when a $defs entry is genuinely
  // shared across schemas via absolute pointers.
  const allRefs = new Set<string>();
  collectEveryRefValue(document, allRefs);
  const reachedTargets = new Set<string>();
  if (hoistedSchemaCopies.length > 0) {
    for (const ref of allRefs) {
      let pointer = pointerFromFragment(ref.slice(1));
      while (pointer.startsWith("/")) {
        reachedTargets.add(pointer);
        pointer = pointer.slice(0, pointer.lastIndexOf("/"));
      }
    }
  }
  const copyRefs = new Set<string>();
  for (const { target, copies } of hoistedSchemaCopies) {
    if (!reachedTargets.has(target)) continue;
    // Source identity applies to the copied node. Descendants may have
    // been replaced by a sibling override during non-schema inlining.
    for (const copy of copies) copyRefs.add(`#${copy}`);
  }

  const issues: SpecHygieneIssue[] = [];
  walkForDefs(document, "", collectSchemaPointers(document), (defsPointer, name) => {
    // Older oaverify releases stored stitched externals under $defs with
    // __ext__/ keys. Those generated keys stay exempt; authored definitions
    // inside reached stitched schemas remain eligible.
    if (name.startsWith("__ext__/")) return;
    const target = `${defsPointer}/${escapePointerSegment(name)}`;
    if (refsHit(copyRefs, target) || refsHit(allRefs, target)) return;
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

type SchemaResource = { value: unknown; pointer: string };

/**
 * Discover positions again when references reveal an enclosing resource.
 * A target visited before that resource can otherwise resolve its own
 * fragment against the document and turn unrelated data into a schema.
 */
function collectSchemaPointers(document: OpenAPIDocument): Set<string> {
  let resources = new Map<string, SchemaResource>();
  const rounds = new Map<string, Set<string>>();
  while (true) {
    const key = JSON.stringify([...resources.keys()].sort());
    const previous = rounds.get(key);
    if (previous !== undefined) {
      // Mutually dependent resource discoveries have no stable scope.
      // Only positions present throughout that cycle justify a finding.
      const common = new Set(previous);
      let inCycle = false;
      for (const [round, schemas] of rounds) {
        if (round === key) inCycle = true;
        if (inCycle)
          for (const pointer of common) if (!schemas.has(pointer)) common.delete(pointer);
      }
      return common;
    }
    const result = discoverSchemaPointers(document, resources);
    if (result.stable) return result.schemas;
    rounds.set(key, result.schemas);
    resources = result.resources;
  }
}

function discoverSchemaPointers(
  document: OpenAPIDocument,
  knownResources: ReadonlyMap<string, SchemaResource>,
): { schemas: Set<string>; resources: Map<string, SchemaResource>; stable: boolean } {
  // Match resolveSpec's unknown-version position table. This identifies
  // known schema locations without asserting that the document is 3.1.
  const version = detectOpenAPIVersion(document) ?? "3.1";
  const schemas = new Set<string>();
  const visited = new Set<string>();
  const documentResource: SchemaResource = { value: document, pointer: "" };
  const resources = new Map<string, SchemaResource>();
  const references: Array<{ ref: string; kind: RefNodeKind; refable: boolean; from: string }> = [];
  const walk = (value: unknown, pointer: string, kind: RefNodeKind, refable: boolean): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const identity = `${kind}:${pointer}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const obj = value as Record<string, unknown>;
    if (kind === "schema") {
      schemas.add(pointer);
      if (version !== "3.0" && typeof obj.$id === "string")
        resources.set(pointer, { value, pointer });
    }
    const refs =
      kind === "schema"
        ? [obj.$ref, ...(version === "3.0" ? [] : [obj.$dynamicRef])]
        : followsRef(kind, refable)
          ? [obj.$ref]
          : [];
    for (const ref of refs) {
      if (typeof ref === "string" && ref.startsWith("#"))
        references.push({ ref, kind, refable, from: pointer });
    }
    if (kind === "schema") {
      for (const { value: child, key, at } of subschemaEntries(obj)) {
        const suffix = at === undefined ? "" : `/${escapePointerSegment(String(at))}`;
        walk(child, `${pointer}/${escapePointerSegment(key)}${suffix}`, "schema", true);
      }
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      if (kind !== "content" && key.startsWith("x-")) continue;
      const position = refPositionFor(version, kind, key);
      if (position === undefined) continue;
      const childPointer = `${pointer}/${escapePointerSegment(key)}`;
      if (position.arity === "one") {
        walk(child, childPointer, position.kind, position.refable);
      } else if (position.arity === "array") {
        if (!Array.isArray(child)) continue;
        child.forEach((entry, index) =>
          walk(entry, `${childPointer}/${index}`, position.kind, position.refable),
        );
      } else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        for (const [name, entry] of Object.entries(child)) {
          if (kind === "document" && key === "paths" && name.startsWith("x-")) continue;
          walk(
            entry,
            `${childPointer}/${escapePointerSegment(name)}`,
            position.kind,
            position.refable,
          );
        }
      }
    }
  };
  walk(document, "", "document", false);
  const lexicalResources = new Set(resources.keys());
  for (let i = 0; i < references.length; i += 1) {
    const { ref, kind, refable, from } = references[i]!;
    let resource = documentResource;
    if (kind === "schema") {
      let ancestor = from;
      while (ancestor !== "") {
        const found = resources.get(ancestor) ?? knownResources.get(ancestor);
        if (found !== undefined) {
          resource = found;
          break;
        }
        ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      }
    }
    let fragment: string;
    let target: unknown;
    try {
      fragment = pointerFromFragment(ref.slice(1));
      target = resolveJsonPointer(resource.value, fragment);
    } catch {
      // An unresolved reference supplies no schema position.
      continue;
    }
    walk(target, resource.pointer + fragment, kind, refable);
  }
  // Lexical roots are all known before any reference is followed. Only
  // reference-discovered scope changes require another discovery round.
  const stable =
    [...resources.keys()].every((p) => lexicalResources.has(p) || knownResources.has(p)) &&
    [...knownResources.keys()].every((p) => resources.has(p));
  return { schemas, resources, stable };
}

function walkForDefs(
  value: unknown,
  pointer: string,
  schemaPointers: ReadonlySet<string>,
  visit: (defsPointer: string, name: string) => void,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkForDefs(value[i], `${pointer}/${i}`, schemaPointers, visit);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    const childPointer = `${pointer}/${escapePointerSegment(key)}`;
    if (
      schemaPointers.has(pointer) &&
      key === "$defs" &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      for (const name of Object.keys(child as Record<string, unknown>)) {
        visit(childPointer, name);
      }
    }
    walkForDefs(child, childPointer, schemaPointers, visit);
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

    // Each declaration is judged where it is written, so an item-level
    // one is reported once. Reporting it inside the method loop below
    // gave one identical finding per operation, every one carrying this
    // same pointer (#891). Shadowing does not enter into it: a name
    // absent from the template is unused wherever it is declared, and an
    // operation that overrides it has an unused declaration of its own.
    for (const name of itemLevelDeclared) {
      if (inTemplate.has(name)) continue;
      issues.push({
        code: "path-param-unused",
        pointer: `${pathItemPointer}/parameters`,
        message: `path parameter "${name}" is declared on the path item but does not appear in the path template "${pathTemplate}"`,
      });
    }

    for (const [suffix, op] of operationEntries(pathItem)) {
      const opPointer = `${pathItemPointer}/${suffix}`;
      const opLevelDeclared = collectPathParams(op.parameters ?? [], document);
      // Only the undeclared rule is blinded by an unreadable list, since
      // it asks what the document declares in total. `path-param-unused`
      // reads the declarations it can see and is unaffected, so it keeps
      // reporting for whichever level is readable.
      const declarationsUnknown = itemListUnreadable || !isParameterList(op.parameters);

      // OpenAPI: operation-level parameters with same (name, in) override
      // path-item-level. Compute the effective set by name.
      const effective = new Map<string, "item" | "op">();
      for (const name of itemLevelDeclared) effective.set(name, "item");
      for (const name of opLevelDeclared) effective.set(name, "op");

      // Skipped whole when a declaration cannot be read: the rule asks
      // what the document declares in total, and an unreadable list
      // makes that unknown.
      if (!declarationsUnknown)
        for (const name of inTemplate) {
          if (effective.has(name)) continue;
          issues.push({
            code: "path-param-undeclared",
            pointer: opPointer,
            message: `path template "${pathTemplate}" references "{${name}}" but neither the operation nor its path item declares a path parameter named "${name}"`,
          });
        }
      // The item-level half is reported above, once for the path item.
      for (const name of opLevelDeclared) {
        if (inTemplate.has(name)) continue;
        issues.push({
          code: "path-param-unused",
          pointer: `${opPointer}/parameters`,
          message: `path parameter "${name}" is declared on the operation but does not appear in the path template "${pathTemplate}"`,
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

/**
 * `parameters` is readable: absent, or a list.
 *
 * `parameters:` written with nothing under it parses as `null`, which
 * says nothing is declared rather than that the declaration cannot be
 * read. Treating it as unreadable silenced a true `path-param-undeclared`
 * for a common YAML slip.
 */
function isParameterList(parameters: unknown): boolean {
  return parameters == null || Array.isArray(parameters);
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
// duplicate-parameter
// ---------------------------------------------------------------------------

/**
 * Parameter lists repeating a `name` and `in` pair. Each list is judged
 * on its own, so a path-level parameter that an operation redeclares is
 * the override OpenAPI allows. Names compare exactly: the specification
 * makes them case-sensitive, and the validator keys its merge the same
 * way. The repeat is reported at its own index, so a list repeating one
 * pair three times gives two findings.
 */
function findDuplicateParameters(document: OpenAPIDocument): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  for (const [pointer, item] of definedPathItems(document)) {
    issues.push(...duplicatesIn(item.parameters, `${pointer}/parameters`, document));
    for (const [suffix, op] of operationEntries(item)) {
      issues.push(...duplicatesIn(op.parameters, `${pointer}/${suffix}/parameters`, document));
    }
  }
  return issues;
}

function duplicatesIn(
  parameters: unknown,
  listPointer: string,
  document: OpenAPIDocument,
): SpecHygieneIssue[] {
  // An unreadable list or entry declares nothing; conformance reports its shape.
  if (!Array.isArray(parameters)) return [];
  const issues: SpecHygieneIssue[] = [];
  const firstIndex = new Map<string, number>();
  for (const [index, entry] of (parameters as unknown[]).entries()) {
    const param = followLocal(entry, document)?.target;
    if (!isObject(param)) continue;
    const { name, in: location } = param;
    if (typeof name !== "string" || typeof location !== "string") continue;
    const key = `${location}\0${name}`;
    const earlier = firstIndex.get(key);
    if (earlier === undefined) {
      firstIndex.set(key, index);
      continue;
    }
    issues.push({
      code: "duplicate-parameter",
      pointer: `${listPointer}/${index}`,
      message: `${location} parameter "${name}" is declared again at index ${index} of a list that declares it at index ${earlier}; a parameter list must not repeat a name and location`,
    });
  }
  return issues;
}

/**
 * Every Path Item the document defines, with the pointer where it is
 * written: `paths`, `webhooks`, `components.pathItems`,
 * `components.callbacks`, the callbacks of every operation reached on
 * the way, and the target of every local Path Item or Callback `$ref`
 * among them, wherever it is written. Each object is yielded once, at
 * the pointer it is first reached by; a `$ref` target outside the named
 * containers is reached last, at its own pointer. Keys written beside a
 * `$ref` are yielded with the referring object.
 *
 * A definition that resolution inlined from another file is a separate
 * object at each use site, so it is yielded once per copy and a defect
 * in it is reported at each. `duplicate-operation-id` alone reads the
 * resolution regions to treat the copies as one.
 */
function* definedPathItems(
  document: OpenAPIDocument,
): Generator<[string, Record<string, unknown>]> {
  const doc = document as unknown as Record<string, unknown>;
  const components = isObject(doc.components) ? doc.components : {};
  const seen = new Set<object>();
  const pending: ["item" | "callback", string, unknown][] = [];
  const follow = (ref: object, kind: "item" | "callback"): void => {
    const resolved = followLocal(ref, document);
    if (resolved?.pointer !== undefined) pending.push([kind, resolved.pointer, resolved.target]);
  };

  function* pathItem(item: unknown, pointer: string): Generator<[string, Record<string, unknown>]> {
    if (!isObject(item) || seen.has(item)) return;
    seen.add(item);
    yield [pointer, item];
    if (isReference(item)) follow(item, "item");
    for (const [suffix, op] of operationEntries(item)) {
      if (!isObject(op.callbacks)) continue;
      for (const [name, cb] of Object.entries(op.callbacks)) {
        yield* callback(cb, `${pointer}/${suffix}/callbacks/${escapePointerSegment(name)}`);
      }
    }
  }

  function* callback(
    value: unknown,
    pointer: string,
  ): Generator<[string, Record<string, unknown>]> {
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);
    if (isReference(value)) {
      follow(value, "callback");
      return;
    }
    for (const [expression, item] of Object.entries(value)) {
      if (expression.startsWith("x-")) continue;
      yield* pathItem(item, `${pointer}/${escapePointerSegment(expression)}`);
    }
  }

  for (const [container, at] of [
    [doc.paths, "/paths"],
    [doc.webhooks, "/webhooks"],
    [components.pathItems, "/components/pathItems"],
  ] as const) {
    if (!isObject(container)) continue;
    for (const [name, item] of Object.entries(container)) {
      // `webhooks` and `components.pathItems` are maps of names, where
      // any key is an entry; under `paths` an `x-` key is an extension.
      if (at === "/paths" && name.startsWith("x-")) continue;
      yield* pathItem(item, `${at}/${escapePointerSegment(name)}`);
    }
  }
  if (isObject(components.callbacks)) {
    for (const [name, cb] of Object.entries(components.callbacks)) {
      yield* callback(cb, `/components/callbacks/${escapePointerSegment(name)}`);
    }
  }
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const [kind, pointer, target] = next;
    yield* kind === "item" ? pathItem(target, pointer) : callback(target, pointer);
  }
}

/**
 * The value a local `$ref` chain ends at, with the pointer of its last
 * hop, or the value itself when it is not a reference. `undefined` when
 * a hop is not a local pointer, does not resolve, or the chain runs past
 * 32 hops. Conformance and the resolver report those.
 */
function followLocal(
  value: unknown,
  document: OpenAPIDocument,
): { target: unknown; pointer?: string } | undefined {
  let current = value;
  let pointer: string | undefined;
  for (let hops = 0; hops <= 32; hops++) {
    if (!isReference(current))
      return pointer === undefined ? { target: current } : { target: current, pointer };
    const next = pointerFromRefFragment(current.$ref);
    if (next === undefined || hops === 32) return undefined;
    try {
      current = resolveJsonPointer(document, next);
    } catch {
      return undefined;
    }
    pointer = next;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// duplicate-operation-id
// ---------------------------------------------------------------------------

/**
 * Operation definitions sharing an `operationId`. Each definition counts
 * once wherever it is reached from: two paths referencing one Path Item,
 * or two operations referencing one callback, reuse a definition rather
 * than repeat an id. With `regions`, copies the resolver inlined from
 * one external definition are recognised as that one definition too.
 * Ids compare exactly, as the specification makes them case-sensitive.
 *
 * @specCites OpenAPI 3.2.0 Operation Object, https://spec.openapis.org/oas/v3.2.0.html#operation-object
 * @specBoundary resolves https://spec.openapis.org/oas/v3.2.0.html#operation-object
 * OpenAPI says an `operationId` "MUST be unique among all operations
 * described in the API" and does not say whether one Operation Object
 * reached from several places describes one operation or several. This
 * check counts it as one. Two paths whose Path Item is the same `$ref`
 * target, such as `/v1/pets` and `/pets` both referencing
 * `#/components/pathItems/Pets`, expose one `operationId` on two routes
 * and are not reported. Two Operation Objects written separately with
 * the same `operationId` are reported, even when their content is
 * identical.
 */
function findDuplicateOperationIds(
  document: OpenAPIDocument,
  regions: readonly SpecRegion[] | undefined,
): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  const firstById = new Map<string, { pointer: string; source: string }>();
  for (const [itemPointer, item] of definedPathItems(document)) {
    for (const [suffix, op] of operationEntries(item)) {
      const id: unknown = op.operationId;
      if (typeof id !== "string") continue;
      const pointer = `${itemPointer}/${suffix}/operationId`;
      const address = regions === undefined ? undefined : sourceOf(regions, pointer);
      const source = address === undefined ? pointer : `${address.uri}#${address.pointer}`;
      const first = firstById.get(id);
      if (first === undefined) {
        firstById.set(id, { pointer, source });
        continue;
      }
      if (first.source === source) continue;
      issues.push({
        code: "duplicate-operation-id",
        pointer,
        message: `operationId "${id}" is already used at ${first.pointer}; an operationId must be unique among all operations`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// security-scheme-undeclared
// ---------------------------------------------------------------------------

/**
 * Security requirements naming a scheme nothing declares. A name matches
 * an own key of `components.securitySchemes`, whatever that entry holds.
 *
 * @specCites OpenAPI 3.2.0 Security Requirement Object, https://spec.openapis.org/oas/v3.2.0.html#security-requirement-object
 * @specBoundary under-asserts https://spec.openapis.org/oas/v3.2.0.html#security-requirement-object
 * In an OpenAPI 3.2 document, `check` reports a security requirement
 * name that is not a component name only when it starts with `#`.
 * OpenAPI 3.2 lets a requirement name a scheme by URI instead of by
 * component name, so such a name may be legal. A name starting with `#`
 * is read as a location in the same document: it is reported when it is
 * not a JSON Pointer, as in `#key`, or when the pointer reaches nothing,
 * and accepted when it reaches any object, even one that is not a
 * Security Scheme. A `#` name written in a separate file that resolution
 * copied into this document refers to that file, so it is not checked
 * either. Any other name, such as `./other.yaml#/key` or a bare `key`
 * matching no component, is not checked, because `check` does not
 * retrieve the documents a URI names. Earlier OpenAPI versions allow
 * component names only, and every unmatched name is reported there. The
 * request validator also reads component names only, so a request to an
 * operation requiring a scheme named by URI fails its security check.
 */
function findUndeclaredSecuritySchemes(
  document: OpenAPIDocument,
  regions: readonly SpecRegion[] | undefined,
): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  const entryUri = regions === undefined ? undefined : sourceOf(regions, "")?.uri;
  const declared = isObject(document.components?.securitySchemes)
    ? document.components.securitySchemes
    : {};
  const byUri = detectOpenAPIVersion(document) === "3.2";
  const check = (security: unknown, at: string): void => {
    if (!Array.isArray(security)) return;
    for (const [index, requirement] of (security as unknown[]).entries()) {
      if (!isObject(requirement)) continue;
      for (const name of Object.keys(requirement)) {
        if (Object.hasOwn(declared, name)) continue;
        const pointer = `${at}/security/${index}/${escapePointerSegment(name)}`;
        if (byUri) {
          if (!namesNothingHere(name, document)) continue;
          // A fragment refers to the file it is written in.
          // Skipped only when another file is known to have written it;
          // a node without a source, such as one an overlay added, is
          // read as this document's.
          const written = regions === undefined ? undefined : sourceOf(regions, pointer)?.uri;
          if (written !== undefined && written !== entryUri) continue;
        }
        issues.push({
          code: "security-scheme-undeclared",
          pointer,
          message: `security requirement names "${name}", which components.securitySchemes does not declare`,
        });
      }
    }
  };
  check(document.security, "");
  for (const [itemPointer, item] of definedPathItems(document)) {
    for (const [suffix, op] of operationEntries(item)) {
      check(op.security, `${itemPointer}/${suffix}`);
    }
  }
  return issues;
}

/**
 * A 3.2 security requirement name that can be read as naming nothing:
 * a fragment of this document that does not resolve to an object. A
 * name of any other form is a URI this check does not retrieve.
 */
function namesNothingHere(name: string, document: OpenAPIDocument): boolean {
  if (!name.startsWith("#")) return false;
  const pointer = pointerFromRefFragment(name);
  if (pointer === undefined) return true;
  try {
    return !isObject(resolveJsonPointer(document, pointer));
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// server-variable-undeclared
// ---------------------------------------------------------------------------

/**
 * Server URL placeholders the server's `variables` does not declare.
 * Each name is reported once per server, at the `url`. A `variables`
 * that is not an object is unreadable rather than empty, so that server
 * is skipped and conformance reports the shape.
 *
 * @specCites OpenAPI 3.2.0 Server Object, https://spec.openapis.org/oas/v3.2.0.html#server-object
 * @specBoundary resolves https://spec.openapis.org/oas/v3.2.0.html#server-object
 * A server URL such as `https://{region}.example.com` whose server
 * declares no `region` under `variables` is reported as an error.
 * OpenAPI says substitutions are made for variables named in braces and
 * that each Server Variable carries the default to substitute, but no
 * version states a requirement that every placeholder be declared. The
 * check reads that as one: an undeclared placeholder has no value, so
 * the URL cannot be built.
 */
function findUndeclaredServerVariables(document: OpenAPIDocument): SpecHygieneIssue[] {
  const issues: SpecHygieneIssue[] = [];
  for (const [pointer, server] of definedServers(document)) {
    const { url, variables } = server;
    if (typeof url !== "string") continue;
    if (variables !== undefined && !isObject(variables)) continue;
    const reported = new Set<string>();
    for (const match of url.matchAll(PATH_TEMPLATE_RE)) {
      const name = match[1]!;
      if (reported.has(name)) continue;
      if (variables !== undefined && Object.hasOwn(variables, name)) continue;
      reported.add(name);
      issues.push({
        code: "server-variable-undeclared",
        pointer: `${pointer}/url`,
        message: `server url "${url}" uses "{${name}}" but the server's variables do not declare "${name}", so it has no value to substitute`,
      });
    }
  }
  return issues;
}

/**
 * Every Server Object the document defines, with the pointer where it is
 * written: the document's, each Path Item's and each operation's
 * `servers`, and the `server` of each Link Object, whether written under
 * a response or in `components.links`. A local `$ref` to a Response or
 * Link is followed, and the definition is read once, at its own pointer.
 * Inlined copies are read once each, as in {@link definedPathItems}.
 */
function* definedServers(document: OpenAPIDocument): Generator<[string, Record<string, unknown>]> {
  const seen = new Set<object>();
  // The definition a possibly-referenced Response or Link stands for,
  // once per object.
  const definition = (
    value: unknown,
    pointer: string,
  ): [string, Record<string, unknown>] | undefined => {
    const resolved = followLocal(value, document);
    if (resolved === undefined || !isObject(resolved.target) || seen.has(resolved.target)) {
      return undefined;
    }
    seen.add(resolved.target);
    return [resolved.pointer ?? pointer, resolved.target];
  };
  function* linkServer(
    link: unknown,
    pointer: string,
  ): Generator<[string, Record<string, unknown>]> {
    const found = definition(link, pointer);
    if (found === undefined || !isObject(found[1].server)) return;
    yield [`${found[0]}/server`, found[1].server];
  }
  function* responseLinkServers(
    response: unknown,
    pointer: string,
  ): Generator<[string, Record<string, unknown>]> {
    const found = definition(response, pointer);
    if (found === undefined || !isObject(found[1].links)) return;
    for (const [name, link] of Object.entries(found[1].links)) {
      yield* linkServer(link, `${found[0]}/links/${escapePointerSegment(name)}`);
    }
  }

  yield* serverList(document.servers, "/servers");
  for (const [itemPointer, item] of definedPathItems(document)) {
    yield* serverList(item.servers, `${itemPointer}/servers`);
    for (const [suffix, op] of operationEntries(item)) {
      const opPointer = `${itemPointer}/${suffix}`;
      yield* serverList(op.servers, `${opPointer}/servers`);
      if (!isObject(op.responses)) continue;
      for (const [status, response] of Object.entries(op.responses)) {
        yield* responseLinkServers(
          response,
          `${opPointer}/responses/${escapePointerSegment(status)}`,
        );
      }
    }
  }
  const components = isObject(document.components)
    ? (document.components as Record<string, unknown>)
    : {};
  if (isObject(components.responses)) {
    for (const [name, response] of Object.entries(components.responses)) {
      yield* responseLinkServers(response, `/components/responses/${escapePointerSegment(name)}`);
    }
  }
  if (isObject(components.links)) {
    for (const [name, link] of Object.entries(components.links)) {
      yield* linkServer(link, `/components/links/${escapePointerSegment(name)}`);
    }
  }
}

function* serverList(
  servers: unknown,
  pointer: string,
): Generator<[string, Record<string, unknown>]> {
  if (!Array.isArray(servers)) return;
  for (const [index, server] of (servers as unknown[]).entries()) {
    if (isObject(server)) yield [`${pointer}/${index}`, server];
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
