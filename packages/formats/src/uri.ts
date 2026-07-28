/**
 * RFC 3986 (URI) and RFC 3987 (IRI) format validators.
 *
 * @packageDocumentation
 */

// Scheme, then anything without whitespace. `new URL` below does the
// real parsing; this pre-filter only rejects the obvious non-URIs
// cheaply.
//
// The authority part is deliberately not spelled out here. An earlier
// `:(?:\/\/[^\s]*)?[^\s]*$` was exactly equivalent (`//` are themselves
// non-space characters, so the optional group is fully subsumed by the
// `[^\s]*` that follows it) while adding quadratic backtracking: two
// adjacent unbounded `[^\s]*` over an input that ultimately fails the
// `$`, e.g. `"A://" + "!".repeat(32000) + " "`, cost roughly 500ms of
// event loop. Format validators run against untrusted request values,
// so that was a usable DoS vector (CodeQL js/polynomial-redos).
const URI_RE = /^[A-Za-z][A-Za-z0-9+\-.]*:[^\s]*$/;
const URI_REFERENCE_RE = /^[^\s]*$/;

/**
 * RFC 3986 absolute `uri`.
 *
 * @public
 */
export function validateUri(value: string): boolean {
  if (!URI_RE.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 3986 `uri-reference` (absolute or relative).
 *
 * @public
 */
export function validateUriReference(value: string): boolean {
  if (!URI_REFERENCE_RE.test(value)) return false;
  try {
    new URL(value, "http://example.com/");
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 3987 `iri`. Accepts unicode characters in paths and fragments.
 *
 * @public
 */
export function validateIri(value: string): boolean {
  // Approximation: validate as URI with unicode allowed
  if (!/^[A-Za-z][A-Za-z0-9+\-.]*:/.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 3987 `iri-reference` (absolute or relative IRI).
 *
 * @public
 */
export function validateIriReference(value: string): boolean {
  try {
    new URL(value, "http://example.com/");
    return true;
  } catch {
    return false;
  }
}

// Built via RegExp() so oxlint's no-control-regex lint doesn't apply to the
// intentional C0 control-range check that RFC 6570 requires.
const URI_TEMPLATE_RE = new RegExp(
  "^(?:" +
    "[^\\u0000-\\u001F\"'%<>\\\\^`{|}\\s]" +
    "|%[0-9A-Fa-f]{2}" +
    "|\\{[+#./;?&]?[A-Za-z0-9_][A-Za-z0-9_.]*(?:\\*|:[1-9]\\d{0,3})?" +
    "(?:,[A-Za-z0-9_][A-Za-z0-9_.]*(?:\\*|:[1-9]\\d{0,3})?)*\\}" +
    ")*$",
);

/**
 * RFC 6570 `uri-template` (e.g. `"/pets/{id}"`, `"/search{?q,page}"`).
 *
 * @public
 */
export function validateUriTemplate(value: string): boolean {
  return URI_TEMPLATE_RE.test(value);
}

const JSON_POINTER_RE = /^(?:\/(?:[^/~]|~0|~1)*)*$/;
const REL_JSON_POINTER_RE = /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^/~]|~0|~1)*)*)$/;

/**
 * RFC 6901 `json-pointer`.
 *
 * @public
 */
export function validateJsonPointer(value: string): boolean {
  return JSON_POINTER_RE.test(value);
}

/**
 * draft `relative-json-pointer`.
 *
 * @public
 */
export function validateRelativeJsonPointer(value: string): boolean {
  return REL_JSON_POINTER_RE.test(value);
}
