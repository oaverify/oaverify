/**
 * The parameter locations this validator serves, and the construction
 * gate that refuses a document declaring anything else.
 *
 * OpenAPI's set of locations and the set a validator can read a value
 * from are not the same set, and the gap is not closing: 3.2 added
 * `querystring`, whose value is the whole query string rather than one
 * key in it, and reading it needs a raw query string the `HttpRequest`
 * contract does not carry (#397).
 *
 * The question this module answers is what happens to a document that
 * declares one. Before it existed, `validateParameter`'s `switch` had
 * no `default`: a required parameter reached `createLeafError` with an
 * unassigned path and threw `TypeError: path is not iterable`, and an
 * optional one was skipped, leaving the request reported valid on an
 * operation nothing had checked (#836).
 *
 * The false "valid" is why refusing is the answer, and why refusing at
 * construction is the answer rather than rejecting at request time:
 *
 * - Accepting the request claims a coverage the validator does not
 *   have, on every request to that operation, silently.
 * - Rejecting the request claims the request is invalid. For a 3.2
 *   `querystring` parameter the request can be perfectly valid, and the
 *   gap is ours, so that answer is wrong in the other direction.
 * - Refusing to build says the one true thing: this document declares
 *   something this validator cannot serve. It is also the only one of
 *   the three that costs nothing per request, on a parameter path whose
 *   own comments (see `missingParameterError`) exist because ~135ns per
 *   parameter mattered.
 *
 * Document-wide and eager, on the router's model (`matcher.ts`, which
 * throws at construction for colliding path templates). Per-operation
 * refusal at first access was the alternative, and it turns an
 * authoring defect into a production failure on the one route nobody
 * exercised until Friday.
 *
 * `@oaverify/check` is exempt, through
 * `unservedParameterLocations: "ignore"`, and
 * an earlier draft of this comment was wrong about why it did not need
 * to be. `CheckAbortedError` does carry the findings of the passes that
 * ran, and the conformance pass is not one of them: it runs after the
 * validator is built. So a refused Swagger 2.0 document lost the four
 * findings naming its `in: body`, and a legal 3.2 document lost its
 * entire report over a parameter the linter never reads.
 *
 * Two consequences that are deliberate rather than overlooked:
 *
 * - 3.2's `additionalOperations` is unrecognised here too, and is
 *   ignored rather than refused. The line is not "unimplemented", it is
 *   the false "valid": an operation the router never matches validates
 *   nothing and claims nothing, where an unserved parameter sits on an
 *   operation that does match.
 * - `webhooks` and `components.pathItems` are not walked, because
 *   `createValidator` routes `paths` alone. A parameter there is never
 *   read, so there is no verdict for it to corrupt.
 * - A parameter `$ref` this gate cannot follow is skipped rather than
 *   raised. Resolution failures are the conformance pass's finding and
 *   the request path's error, and neither of those loses a document:
 *   raising here made a stale pointer on an unrouted operation a
 *   startup failure, which is a wider claim than the one this module is
 *   named after.
 *
 * @packageDocumentation
 */

import {
  pointerFromRefFragment,
  type OpenAPIDocument,
  type PathItem,
  type ParameterObject,
  type ReferenceObject,
} from "@oaverify/internal-core";
import { escapePointer, METHODS } from "./document-walk.js";
import { resolveOperationRef } from "./operation-cache.js";

/**
 * The four locations {@link validateParameter} can read a value from,
 * which is `ParameterLocation` restated as a runtime set.
 *
 * @internal
 */
const SERVED_LOCATIONS: ReadonlySet<string> = new Set(["path", "query", "header", "cookie"]);

/**
 * Locations OpenAPI 3.x defines that this validator does not serve.
 * Separate from "not a location at all" for the message alone: the two
 * are refused identically, and a reader who declared `querystring`
 * needs to be told it is legal and unimplemented rather than that they
 * mistyped something.
 *
 * @internal
 */
const UNIMPLEMENTED_LOCATIONS: ReadonlyMap<string, string> = new Map([
  ["querystring", "OpenAPI 3.2"],
]);

/**
 * `true` when this validator can read a value for a parameter declaring
 * `location`.
 *
 * Exported through `@oaverify/core/validator/internals` so the AOT
 * emitter (`compile-spec`) applies the same rule as the runtime rather
 * than growing a second copy of the list (#829).
 *
 * @internal
 */
export function isServedParameterLocation(
  location: unknown,
): location is "path" | "query" | "header" | "cookie" {
  return typeof location === "string" && SERVED_LOCATIONS.has(location);
}

/**
 * A spec-supplied `in` as one short piece of ASCII, for a message.
 *
 * `JSON.stringify` renders null, a number, a string and a small object
 * without inventing a spelling for any of them, and it is what keeps a
 * value carrying a newline or a quote from breaking the line. It also
 * returns undefined for a function or a symbol and *throws* on a
 * circular value or a BigInt, and a gate that exists to replace an
 * opaque `TypeError` cannot afford to raise one of its own, so both
 * fall back to the type. Long values are cut, because the message is
 * for a log line and the document is on disk.
 *
 * Shared with `validate-step.ts`, whose residual arm builds the same
 * kind of message about the same kind of value.
 *
 * @internal
 */
export function renderParameterLocation(location: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(location);
  } catch {
    text = undefined;
  }
  // "a value of type object" rather than "a object": the article is
  // wrong for half the types, and generated output is read by people.
  if (text === undefined) return `a value of type ${typeof location}`;
  // Cutting the rendered text would leave the opening quote unclosed,
  // which is the defect this function exists to avoid, one level down.
  // A length is what a reader can act on anyway: the value is in the
  // document, and no message should carry a kilobyte of it.
  if (text.length > 80) return `a ${typeof location} of ${text.length} characters`;
  return text;
}

/**
 * `declares in: "body"`, or `declares no "in" field`, for a message that
 * has already named the parameter.
 *
 * Shared so the construction gate and `validate-step.ts`'s residual arm
 * describe the same value the same way. The residual arm rendered an
 * absent `in` as `a undefined`, which is the shape of the message the
 * gate goes out of its way to avoid.
 *
 * @internal
 */
export function describeParameterLocation(location: unknown): string {
  return location === undefined
    ? 'declares no "in" field'
    : `declares in: ${renderParameterLocation(location)}`;
}

/**
 * The message for one offending parameter: what is wrong, and what to
 * do about it, in the shape `createRouter` uses for colliding
 * templates.
 *
 * `where` is the caller's label for the position (`GET /widgets`, or
 * `path item /widgets` for a Path Item Object's own `parameters`), so
 * one message serves both without this module knowing how the caller
 * spells an operation.
 *
 * ASCII only, and the offending value is rendered with
 * `JSON.stringify` rather than interpolated between quotes of our own.
 * It is spec-supplied text: `in: 'q"\nx'` produced a message carrying
 * a literal newline and unbalanced quotes, which breaks a log line into
 * two and the second one parses as nothing.
 *
 * @internal
 */
export function unservedParameterLocationMessage(
  where: string,
  name: unknown,
  location: unknown,
): string {
  const subject =
    typeof name === "string" && name !== ""
      ? `${where} declares parameter "${name}"`
      : name === undefined || name === ""
        ? `${where} declares an unnamed parameter`
        : // Present and not a string. Same rule as `in` below: telling
          // an author a field is missing sends them looking for a key
          // that is there.
          `${where} declares parameter ${renderParameterLocation(name)}`;
  if (location === undefined) {
    return (
      `${subject} with no "in" field. ` +
      "A parameter declares one of path, query, header or cookie."
    );
  }
  if (typeof location !== "string") {
    // Present and not a string. Saying the field is missing sends the
    // author looking for a key that is there, which is the slower of
    // the two searches.
    return (
      `${subject} with in: ${renderParameterLocation(location)}, which is not a ` +
      "parameter location in OpenAPI 3.x. Use path, query, header or cookie."
    );
  }
  const version = UNIMPLEMENTED_LOCATIONS.get(location);
  if (version !== undefined) {
    return (
      `${subject} with in: ${renderParameterLocation(location)}, a location this validator does not serve. ` +
      `It is legal in ${version} and is not implemented here. ` +
      "Remove the parameter, or declare it in query, header, path or cookie."
    );
  }
  const swagger2 =
    location === "body"
      ? " A Swagger 2.0 body parameter becomes requestBody."
      : location === "formData"
        ? " A Swagger 2.0 formData parameter becomes requestBody with a form media type."
        : "";
  return (
    `${subject} with in: ${renderParameterLocation(location)}, which is not a parameter location in ` +
    "OpenAPI 3.x. " +
    `Use path, query, header or cookie.${swagger2}`
  );
}

/**
 * One parameter whose `in` this validator cannot read a value for,
 * located.
 *
 * @internal
 */
export interface UnservedParameterLocation {
  /** JSON pointer to the parameter as the document declares it. */
  readonly pointer: string;
  /**
   * JSON pointer to the shared definition, when the use site above is a
   * `$ref` and the target is local. A caller anchoring a finding wants
   * this one: the use site holds a `$ref` node and no `in` to point at.
   */
  readonly definitionPointer?: string;
  /** `GET /widgets`, or `path item /widgets`, for the message. */
  readonly where: string;
  readonly name: unknown;
  readonly location: unknown;
}

/**
 * Every parameter in `document.paths` whose `in` this validator cannot
 * serve, in document order.
 *
 * Two callers, one walk. {@link assertServedParameterLocations} throws
 * on the first entry, and `@oaverify/check` reports all of them as
 * findings: a document the validator refuses is a document `check`
 * should say something about, and having each derive the set separately
 * is how the two verbs drift apart.
 *
 * A parameter behind a `$ref` is listed at each use site rather than
 * once at its target, because a use site is where an author reading a
 * finding will look.
 *
 * @internal
 */
export function listUnservedParameterLocations(
  document: OpenAPIDocument,
  options: {
    /**
     * The caller's resolver. `createValidator` passes the one it
     * already built; a caller with only a document gets the same
     * resolution rather than a second reading of `$ref`.
     */
    readonly resolveRef?: <T>(value: T | ReferenceObject | undefined) => T | undefined;
    /**
     * Whether to look inside a Path Item declared as a `$ref`.
     *
     * The gate says no: `createRouter` never matches such a path item,
     * so nothing there can reach a request, and refusing the document
     * would cost more than it protects. A reporting caller says yes,
     * because `compile-spec` does resolve it and refuses, and a finding
     * that skipped it would leave `check` silent about a document one
     * of the other verbs rejects.
     *
     * The two answers differ because the engines differ on routing, not
     * on locations, and that divergence is older than this walk.
     */
    readonly followPathItemRefs?: boolean;
  } = {},
): UnservedParameterLocation[] {
  const resolveRef =
    options.resolveRef ??
    (<T>(value: T | ReferenceObject | undefined): T | undefined =>
      resolveOperationRef<T>(document, value));
  const found: UnservedParameterLocation[] = [];
  const paths = document.paths ?? {};
  // `$ref` targets already cleared, by pointer. A published document
  // points many operations at the same `components/parameters` entry
  // (16,521 of the 73,075 parameters across the 300 documents in
  // `detection/real-world/specs` are behind a `$ref`), and resolving
  // each use site walks the pointer again for an answer that cannot
  // differ. Measured on `large-github.json`, the largest of them:
  // `createValidator` medians 1.19ms with this walk removed, 3.50ms
  // with it and no cache, and 1.95ms as written.
  const clearedRefs = new Set<string>();
  for (const [pathPattern, item] of Object.entries(paths)) {
    if (item === null || typeof item !== "object") continue;
    // The item's own keys, always. `methodsDeclaredOn` (the router)
    // reads them off the entry, so an entry carrying `$ref` *and*
    // sibling method keys is routed for those methods, and skipping it
    // let an unserved parameter reach a request. That was this walk's
    // own hole: the request then threw from `validateParameter`, which
    // is the failure this module exists to turn into a refusal.
    walkPathItem(
      found,
      item,
      pathPattern,
      `/paths/${escapePointer(pathPattern)}`,
      resolveRef,
      clearedRefs,
    );

    // The `$ref` target's own operations are a different question. The
    // router never matches them, because it reads methods off the entry
    // and a `$ref` is not one, so nothing there can reach a request and
    // the gate leaves it alone. `compile-spec` does resolve it and
    // refuses, so a reporting caller asks for it and gets pointers into
    // the target, where the parameters are actually written.
    if (options.followPathItemRefs !== true) continue;
    const ref = (item as ReferenceObject).$ref;
    if (typeof ref !== "string") continue;
    let target: typeof item | undefined;
    try {
      target = resolveRef<typeof item>(item);
    } catch {
      continue;
    }
    if (target === null || typeof target !== "object" || target === item) continue;
    // `pointerFromRefFragment` answers `undefined` for a `$ref` into
    // another file, which is not a position in this document. Reporting
    // it against the entry would send a reader to the wrong file, so
    // such a target is left to whoever can address it.
    const targetPointer = pointerFromRefFragment(ref);
    if (targetPointer === undefined) continue;
    walkPathItem(found, target, pathPattern, targetPointer, resolveRef, clearedRefs, true);
  }
  return found;
}

/**
 * Throw on the first parameter in `document.paths` whose `in` this
 * validator cannot serve.
 *
 * Walks paths in document order, and each Path Item's operations in
 * `METHODS` order rather than the order the document declares them, so
 * a document with several offenders names the same one on every run.
 * Determinism is the property that matters here; which offender is
 * named first is not.
 *
 * @internal
 */
export function assertServedParameterLocations(
  document: OpenAPIDocument,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
): void {
  const first = listUnservedParameterLocations(document, { resolveRef })[0];
  if (first === undefined) return;
  throw new Error(
    `createValidator: ${unservedParameterLocationMessage(first.where, first.name, first.location)}`,
  );
}

/**
 * Append every unserved entry declared by one Path Item Object, its own
 * `parameters` and its operations'.
 *
 * `base` is the pointer to the object being read, which is the entry
 * under `paths` for an item read as written and the `$ref` target's own
 * address for one followed through a reference. A finding has to name
 * where the parameter is written, not where the reference to it is.
 *
 * @internal
 */
function walkPathItem(
  found: UnservedParameterLocation[],
  item: PathItem,
  pathPattern: string,
  base: string,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
  clearedRefs: Set<string>,
  /**
   * Whether `base` is a `$ref` target rather than the entry under
   * `paths`. A caller anchoring a finding needs to know: two operations
   * can reference one Path Item, so the same pointer carries a finding
   * per referencing operation and only the message tells them apart.
   */
  crossedRef = false,
): void {
  // A Path Item's own parameters are read only through the operations
  // that inherit them, so an item declaring no operation this validator
  // routes carries nothing a request can reach. The same rule leaves
  // `additionalOperations` alone: the line is the false "valid", and
  // there is no verdict here to corrupt.
  const routable = METHODS.some((method) => {
    const operation = item[method];
    return operation !== null && typeof operation === "object";
  });
  if (routable) {
    collect(
      found,
      item.parameters,
      `path item ${pathPattern}`,
      base,
      resolveRef,
      clearedRefs,
      crossedRef,
    );
  }
  for (const method of METHODS) {
    const operation = item[method];
    if (operation === null || typeof operation !== "object") continue;
    collect(
      found,
      operation.parameters,
      `${method.toUpperCase()} ${pathPattern}`,
      `${base}/${method}`,
      resolveRef,
      clearedRefs,
      crossedRef,
    );
  }
}

/**
 * Append every unserved entry in one `parameters` array.
 *
 * `resolveRef` is the caller's resolver, following a chain to its hop
 * limit, so a `$ref` to `components/parameters/...` is read the same way
 * the operation cache reads it. Entries that resolve to nothing are
 * skipped for the same reason the cache skips them: a `- ` list entry
 * with nothing under it is `null`, and locating that is the conformance
 * pass's job.
 *
 * Note what this does *not* consult. Operation-level parameters replace
 * Path Item ones keyed on `(in, name)` (see `buildOperationCache`), so
 * a served parameter can never shadow an unserved one: a different `in`
 * is a different parameter, in the spec and in the dedup. And
 * `ignorePaths` is a predicate over request paths evaluated per
 * request, not a document filter, so there is no path template to offer
 * it here.
 *
 * @internal
 */
function collect(
  found: UnservedParameterLocation[],
  parameters: unknown,
  where: string,
  pointerBase: string,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
  clearedRefs: Set<string>,
  crossedRef: boolean,
): void {
  // Not `!== undefined`: `parameters:` carrying an object rather than a
  // list is a different defect, and this walk answers one question.
  //
  // Note what it does not do: nothing downstream handles that document
  // gracefully either. `buildOperationCache` throws a raw `TypeError`
  // at request time and `checkSpec` exits on one, which is #837 and is
  // older than this module. Skipping here neither causes that nor fixes
  // it; iterating would only add a second, less useful error ahead of
  // whatever eventually names the defect.
  if (!Array.isArray(parameters)) return;
  for (const [index, raw] of (parameters as unknown[]).entries()) {
    // A pointer is recorded only after its target cleared, so the skip
    // can never swallow an offender: the first use site of a bad target
    // is listed before anything is recorded.
    const ref = raw === null || typeof raw !== "object" ? undefined : (raw as ReferenceObject).$ref;
    if (typeof ref === "string" && clearedRefs.has(ref)) continue;
    // A pointer this walk cannot follow is not its finding.
    // `resolveOperationRef` throws on a dangling target and on a chain
    // past its hop limit, and letting that out of here turned a stale
    // `$ref` on a route nobody calls into a document that will not
    // build, with a message naming no path, method or parameter. The
    // request path still throws when something asks for that operation,
    // and the conformance pass still locates the pointer, both of which
    // say more than this could.
    let p: ParameterObject | undefined;
    try {
      p = resolveRef<ParameterObject>(raw as ParameterObject | ReferenceObject);
    } catch {
      // Only a resolution failure belongs here. A resolver that is not
      // callable is a programming error, and this catch hid one during
      // development: every parameter was skipped and the walk reported
      // a clean document. The options bag is what stops that recurring,
      // by making the argument impossible to misplace.
      continue;
    }
    if (p === null || typeof p !== "object") continue;
    if (!isServedParameterLocation(p.in)) {
      found.push({
        pointer: `${pointerBase}/parameters/${index}`,
        // Only a local pointer, because an external one is not a
        // position in this document and a caller anchoring to it would
        // highlight the wrong file.
        // `pointerFromRefFragment`, because a `$ref` holds a URI
        // fragment: `#/components/parameters/a%20b` addresses the key
        // `a b`, and slicing the `#` off left a pointer addressing
        // nothing, which cost the finding its SARIF region.
        // A `$ref` crossed on the way here, at either level: the
        // parameter itself, or the Path Item that declares it. Both
        // mean the pointer names a shared definition that several
        // operations can reach, which is what the anchor has to say.
        ...(typeof ref === "string" && ref.startsWith("#")
          ? { definitionPointer: pointerFromRefFragment(ref) }
          : crossedRef
            ? { definitionPointer: `${pointerBase}/parameters/${index}` }
            : {}),
        where,
        name: p.name,
        location: p.in,
      });
      continue;
    }
    if (typeof ref === "string") clearedRefs.add(ref);
  }
}
