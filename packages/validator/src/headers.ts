/**
 * Read a header from a framework-neutral header record. The adapter
 * helpers normalize keys to lowercase, so the common path is one lookup;
 * hand-built records still get HTTP's case-insensitive semantics.
 *
 * @internal
 */
export function getHeaderValue(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | string[] | undefined {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  // `Object.hasOwn`, not a bare index. A header parameter named after an
  // `Object.prototype` member ("constructor", "toString", ...) would
  // otherwise resolve to the inherited function and read as present,
  // satisfying a `required` check the client never satisfied.
  if (Object.hasOwn(headers, lowered)) {
    const direct = headers[lowered];
    if (direct !== undefined) return direct;
  }
  // Adapter-built records promise lowercase keys, so the miss is
  // final. Without the mark, a declared-but-absent header paid the
  // scan below on every request, and against an adapter record it
  // could never find anything (~175x a direct hit at 24 headers).
  if (hasLowercaseKeys(headers)) return undefined;
  // Already own-only: `Object.entries` skips the prototype chain.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * Fast path for spec-declared header names that cannot collide with
 * `Object.prototype` after lowercasing. Keeps case-insensitive fallback
 * for hand-built records.
 *
 * @internal
 */
export function getHeaderValueFast(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | string[] | undefined {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  const direct = headers[lowered];
  if (direct !== undefined) return direct;
  // See getHeaderValue: the adapters' lowercase mark makes the miss
  // final, sparing the absent-header scan.
  if (hasLowercaseKeys(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

import { hasLowercaseKeys } from "@oaverify/internal-core";

export { getOwn } from "@oaverify/internal-core";

/**
 * The `Content-Type` mismatch message, for both the request and the
 * response side and for both the interpreted and the AOT-emitted
 * validator.
 *
 * Shared for two reasons. The four call sites had drifted: the emitted
 * response path said `is not accepted` where the interpreted one said
 * `is not declared for status N`, so the same condition read differently
 * depending on whether you went through `compile-spec`. And the
 * unset-but-supplied case below needs the same wording everywhere.
 *
 * `HttpRequest.contentType` / `HttpResponse.contentType` is the only
 * place the validator reads the media type; it is deliberately not
 * derived from `headers`, so that a caller sees one explicit field
 * rather than two sources that can disagree. The cost is a trap: a
 * hand-built request that fills in `headers["content-type"]` and leaves
 * the field unset has supplied a type the validator does not read.
 * Reporting `"<missing>"` there would be false and would send the reader
 * looking for something they did supply, so the message names the header
 * and the fix is one line.
 *
 * The header is only consulted on this path, which has already failed,
 * so the hot path pays nothing for it.
 *
 * @internal
 */
export function contentTypeErrorMessage(
  subject: "request" | "response",
  contentType: string | undefined,
  headers: Record<string, string | string[]> | undefined,
  statusKey?: string,
): string {
  const tail =
    subject === "request" ? "is not accepted" : `is not declared for status ${statusKey ?? ""}`;
  const base = `${subject} Content-Type "${contentType ?? "<missing>"}" ${tail}`;
  if (contentType !== undefined) return base;
  if (getHeaderValue(headers, "content-type") === undefined) return base;
  const field = subject === "request" ? "HttpRequest" : "HttpResponse";
  return `${base} (set ${field}.contentType; the "content-type" header is not read)`;
}
