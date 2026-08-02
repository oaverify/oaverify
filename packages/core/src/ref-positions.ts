/**
 * Where OpenAPI permits a `$ref`, as pure data, per version.
 *
 * A Reference Object is legal only at the positions the specification
 * types as `X | Reference`. Everything else is author data: `description`
 * holds a string, `example` holds whatever the payload looks like, an
 * `x-` extension holds whatever its vendor decided. A resolver that
 * follows any `$ref`-shaped object anywhere will hand a documentation
 * file to the reader chain and fail on the first byte of it, naming a
 * parse error rather than the spec defect that caused it.
 *
 * Lives in `core` beside {@link isSubschemaKey} for the same reason that
 * does: the walk that needs it (the spec resolver) already imports its
 * other position table from here, and the alternative home, the
 * meta-schema package, would put ~100KB on every resolve.
 *
 * The tables are hand-written so they stay readable and greppable, and
 * they are pinned to the published meta-schemas by a derivation test in
 * `@oaverify/internal-metaschema` (that direction keeps the dependency
 * graph acyclic; the reverse would not). The test re-derives each
 * version's positions from the vendored document and asserts equality,
 * so a table that drifts from the specification fails the build.
 *
 * @packageDocumentation
 */

import type { OpenAPIVersion } from "./version.js";

/**
 * The kind of OpenAPI object a walk is standing on.
 *
 * `"unknown"` covers author data and vendor extensions: positions the
 * specification does not type as an OpenAPI object. A `$ref` inside one
 * is data, and is never followed.
 *
 * @internal
 */
export type RefNodeKind =
  | "unknown"
  | "document"
  | "components"
  | "pathItem"
  | "operation"
  | "responses"
  | "response"
  | "requestBody"
  | "parameter"
  | "header"
  | "content"
  | "mediaType"
  | "encoding"
  | "example"
  | "link"
  | "callback"
  | "securityScheme"
  | "schema";

/**
 * What sits at a child position: the kind of node, how many, and whether
 * the specification permits a Reference Object there.
 *
 * @internal
 */
export interface RefPosition {
  /** Kind of the node(s) held at this position. */
  readonly kind: RefNodeKind;
  /** `one` is the value itself; `map` and `array` hold the nodes below. */
  readonly arity: "one" | "map" | "array";
  /**
   * May a node at this position be a Reference Object?
   *
   * A Path Item is `false` here and still follows a `$ref`, because it
   * carries `$ref` as a field of its own rather than by being a
   * Reference Object. {@link followsRef} is the question a resolver
   * actually wants to ask.
   */
  readonly refable: boolean;
}

const one = (kind: RefNodeKind, refable = false): RefPosition => ({ kind, arity: "one", refable });
const map = (kind: RefNodeKind, refable = false): RefPosition => ({ kind, arity: "map", refable });
const array = (kind: RefNodeKind, refable = false): RefPosition => ({
  kind,
  arity: "array",
  refable,
});

/** Positions shared by every supported version. */
const COMMON: Partial<Record<RefNodeKind, Readonly<Record<string, RefPosition>>>> = {
  document: {
    paths: map("pathItem"),
    components: one("components"),
  },
  components: {
    schemas: map("schema"),
    responses: map("response", true),
    parameters: map("parameter", true),
    examples: map("example", true),
    requestBodies: map("requestBody", true),
    headers: map("header", true),
    securitySchemes: map("securityScheme", true),
    links: map("link", true),
    callbacks: map("callback", true),
  },
  pathItem: {
    get: one("operation"),
    put: one("operation"),
    post: one("operation"),
    delete: one("operation"),
    options: one("operation"),
    head: one("operation"),
    patch: one("operation"),
    trace: one("operation"),
    parameters: array("parameter", true),
  },
  operation: {
    parameters: array("parameter", true),
    requestBody: one("requestBody", true),
    responses: one("responses"),
    callbacks: map("callback", true),
  },
  // Every key is a status code or `default`, and all of them are
  // `Response | Reference`.
  responses: { "*": one("response", true) },
  response: {
    content: one("content"),
    headers: map("header", true),
    links: map("link", true),
  },
  requestBody: { content: one("content") },
  // A Callback is `runtime expression -> Path Item`.
  callback: { "*": one("pathItem") },
  parameter: {
    schema: one("schema"),
    content: one("content"),
    examples: map("example", true),
  },
  header: {
    schema: one("schema"),
    content: one("content"),
    examples: map("example", true),
  },
  mediaType: {
    schema: one("schema"),
    examples: map("example", true),
    encoding: map("encoding"),
  },
  encoding: { headers: map("header", true) },
  // An Example's `value` is the payload it illustrates: arbitrary author
  // data, and the position that most reliably contains a `$ref`-shaped
  // object that is not a reference.
  example: {},
  link: {},
  securityScheme: {},
};

/**
 * Per-version overrides, merged over {@link COMMON} by node kind.
 *
 * 3.1 gained `webhooks` and `components.pathItems`. 3.2 additionally
 * types a Media Type as `MediaType | Reference` and adds
 * `components.mediaTypes`.
 */
const BY_VERSION: Record<
  OpenAPIVersion,
  Partial<Record<RefNodeKind, Readonly<Record<string, RefPosition>>>>
> = {
  "3.0": {
    content: { "*": one("mediaType") },
  },
  "3.1": {
    document: { webhooks: map("pathItem") },
    components: { pathItems: map("pathItem") },
    content: { "*": one("mediaType") },
  },
  "3.2": {
    document: { webhooks: map("pathItem") },
    components: { pathItems: map("pathItem"), mediaTypes: map("mediaType", true) },
    content: { "*": one("mediaType", true) },
  },
};

/**
 * What lives at `key` under a node of `kind`, or `undefined` when the
 * specification does not define that position (author data, a vendor
 * extension, or a key that simply is not part of the object).
 *
 * @internal
 */
export function refPositionFor(
  version: OpenAPIVersion,
  kind: RefNodeKind,
  key: string,
): RefPosition | undefined {
  if (kind === "unknown" || kind === "schema") return undefined;
  const base = COMMON[kind];
  const over = BY_VERSION[version][kind];
  return over?.[key] ?? over?.["*"] ?? base?.[key] ?? base?.["*"];
}

/**
 * Every position this version types as `X | Reference`, as
 * `"<parent kind>/<key>"` strings (`"*"` where any key qualifies).
 *
 * Exists for the derivation test in `@oaverify/internal-metaschema`,
 * which regenerates the same set from the published meta-schema and
 * asserts equality. Enumeration is what makes that check two-way:
 * {@link refPositionFor} alone can confirm a derived position is
 * present, and cannot reveal one this table invented.
 *
 * @internal
 */
export function refablePositionsFor(version: OpenAPIVersion): ReadonlySet<string> {
  const out = new Set<string>();
  const kinds = new Set<string>([...Object.keys(COMMON), ...Object.keys(BY_VERSION[version])]);
  for (const kind of kinds) {
    const table = { ...COMMON[kind as RefNodeKind], ...BY_VERSION[version][kind as RefNodeKind] };
    for (const [key, at] of Object.entries(table)) {
      if (at.refable) out.add(`${kind}/${key}`);
    }
  }
  return out;
}

/**
 * Should a resolver follow a `$ref` found on a node of `kind` that is
 * sitting at a position with `refable`?
 *
 * Two ways to earn it: the position admits a Reference Object, or the
 * node is a Path Item, which carries `$ref` as a field in every
 * supported version.
 *
 * @internal
 */
export function followsRef(kind: RefNodeKind, refable: boolean): boolean {
  return refable || kind === "pathItem";
}
