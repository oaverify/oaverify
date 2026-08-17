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

import type { OpenAPIDocument, ParameterObject, ReferenceObject } from "@oaverify/internal-core";
import { METHODS } from "./document-walk.js";

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
 * @internal
 */
function render(location: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(location);
  } catch {
    text = undefined;
  }
  if (text === undefined) return `a ${typeof location}`;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
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
      : `${where} declares an unnamed parameter`;
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
      `${subject} with in: ${render(location)}, which is not a ` +
      "parameter location in OpenAPI 3.x. Use path, query, header or cookie."
    );
  }
  const version = UNIMPLEMENTED_LOCATIONS.get(location);
  if (version !== undefined) {
    return (
      `${subject} with in: ${render(location)}, a location this validator does not serve. ` +
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
    `${subject} with in: ${render(location)}, which is not a parameter location in ` +
    "OpenAPI 3.x. " +
    `Use path, query, header or cookie.${swagger2}`
  );
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
 * Path Item parameters are reported against the path item, not repeated
 * once per operation that inherits them.
 *
 * `resolveRef` is the caller's resolver, following a chain to its hop
 * limit, so a `$ref` to
 * `components/parameters/...` is read the same way the operation cache
 * reads it. Entries that resolve to nothing are skipped for the same
 * reason the cache skips them: a `- ` list entry with nothing under it
 * is `null`, and locating that is the conformance pass's job.
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
export function assertServedParameterLocations(
  document: OpenAPIDocument,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
): void {
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
    // The Path Item itself is read as written, not through `resolveRef`,
    // because `createRouter` reads it that way: a `$ref`'d Path Item
    // declares no method the router can see, so it is never matched and
    // its parameters are never read. Refusing one would refuse a
    // document over an operation this validator does not serve at all.
    if (item === null || typeof item !== "object") continue;
    // A Path Item's own parameters are read only through the operations
    // that inherit them, so an item declaring no operation this
    // validator routes carries nothing a request can reach. Same rule
    // the `$ref`'d Path Item exemption above rests on, and the same one
    // that leaves `additionalOperations` alone: the line is the false
    // "valid", and there is no verdict here to corrupt.
    const routable = METHODS.some((method) => {
      const operation = item[method];
      return operation !== null && typeof operation === "object";
    });
    if (routable) check(item.parameters, `path item ${pathPattern}`, resolveRef, clearedRefs);
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === null || typeof operation !== "object") continue;
      check(
        operation.parameters,
        `${method.toUpperCase()} ${pathPattern}`,
        resolveRef,
        clearedRefs,
      );
    }
  }
}

function check(
  parameters: unknown,
  where: string,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
  clearedRefs: Set<string>,
): void {
  // Not `!== undefined`: `parameters:` carrying an object rather than a
  // list is a malformed document that the hygiene lint reports, and
  // this gate answers one question. Iterating it here would throw a
  // second, less useful error ahead of the one that names the defect.
  if (!Array.isArray(parameters)) return;
  for (const raw of parameters as (ParameterObject | ReferenceObject)[]) {
    // A pointer is recorded only after its target cleared, so the skip
    // can never swallow an offender: the first use site of a bad target
    // throws before anything is recorded. The site it names is that
    // first one in document order, which is the same site an
    // uncached walk would name.
    const ref = raw === null || typeof raw !== "object" ? undefined : (raw as ReferenceObject).$ref;
    if (typeof ref === "string" && clearedRefs.has(ref)) continue;
    // A pointer this gate cannot follow is not this gate's finding.
    // `resolveOperationRef` throws on a dangling target and on a chain
    // past its hop limit, and letting that out of here turned a stale
    // `$ref` on a route nobody calls into a document that will not
    // build, with a message naming no path, method or parameter. The
    // request path still throws when something asks for that operation,
    // and the conformance pass still locates the pointer, both of which
    // say more than this could.
    let p: ParameterObject | undefined;
    try {
      p = resolveRef<ParameterObject>(raw);
    } catch {
      continue;
    }
    if (p === null || typeof p !== "object") continue;
    if (!isServedParameterLocation(p.in)) {
      throw new Error(`createValidator: ${unservedParameterLocationMessage(where, p.name, p.in)}`);
    }
    if (typeof ref === "string") clearedRefs.add(ref);
  }
}
