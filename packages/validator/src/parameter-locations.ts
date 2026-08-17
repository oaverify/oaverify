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
 * exercised until Friday. `@oaverify/check` already handles a
 * construction-time throw: `CheckAbortedError` carries the findings the
 * earlier passes produced, and names the router collision as its worked
 * example, so a refused document still gets a report.
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
 * The message for one offending parameter: what is wrong, and what to
 * do about it, in the shape `createRouter` uses for colliding
 * templates.
 *
 * `where` is the caller's label for the position (`GET /widgets`, or
 * `path item /widgets` for a Path Item Object's own `parameters`), so
 * one message serves both without this module knowing how the caller
 * spells an operation.
 *
 * ASCII only, and the offending value is passed through as written.
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
      : `${where} declares a parameter with no name`;
  if (typeof location !== "string") {
    return (
      `${subject} with no "in" field. ` +
      "A parameter declares one of path, query, header or cookie."
    );
  }
  const version = UNIMPLEMENTED_LOCATIONS.get(location);
  if (version !== undefined) {
    return (
      `${subject} with in: "${location}", a location this validator does not serve. ` +
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
    `${subject} with in: "${location}", which is not a parameter location in OpenAPI 3.x. ` +
    `Use path, query, header or cookie.${swagger2}`
  );
}

/**
 * Throw on the first parameter in `document.paths` whose `in` this
 * validator cannot serve.
 *
 * Walks Path Item Objects and Operation Objects in document order, so
 * a document with several offenders names the same one on every run.
 * Path Item parameters are reported against the path item, not repeated
 * once per operation that inherits them.
 *
 * `resolveRef` is the caller's one-hop resolver, so a `$ref` to
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
  for (const [pathPattern, item] of Object.entries(paths)) {
    // The Path Item itself is read as written, not through `resolveRef`,
    // because `createRouter` reads it that way: a `$ref`'d Path Item
    // declares no method the router can see, so it is never matched and
    // its parameters are never read. Refusing one would refuse a
    // document over an operation this validator does not serve at all.
    if (item === null || typeof item !== "object") continue;
    check(item.parameters, `path item ${pathPattern}`, resolveRef);
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === null || typeof operation !== "object") continue;
      check(operation.parameters, `${method.toUpperCase()} ${pathPattern}`, resolveRef);
    }
  }
}

function check(
  parameters: unknown,
  where: string,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
): void {
  // Not `!== undefined`: `parameters:` carrying an object rather than a
  // list is a malformed document that the hygiene lint reports, and
  // this gate answers one question. Iterating it here would throw a
  // second, less useful error ahead of the one that names the defect.
  if (!Array.isArray(parameters)) return;
  for (const raw of parameters as (ParameterObject | ReferenceObject)[]) {
    const p = resolveRef<ParameterObject>(raw);
    if (p === null || typeof p !== "object") continue;
    if (isServedParameterLocation(p.in)) continue;
    throw new Error(`createValidator: ${unservedParameterLocationMessage(where, p.name, p.in)}`);
  }
}
