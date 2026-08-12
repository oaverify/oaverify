/**
 * The OpenAPI registry's `media-range`: the RFC 9110 §12.5.1
 * production, a media type with optional parameters.
 *
 * @packageDocumentation
 */

/**
 * `tchar`, as a lookup over the ASCII range.
 *
 * A table rather than a regex because the parameter scanner asks the
 * question one character at a time, and the set is easier to check
 * against the RFC written out than hidden in a character class.
 */
const TCHAR = new Set(
  "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
);

const HTAB = 0x09;
const SP = 0x20;

/** `obs-text = %x80-FF`, an octet range rather than a range of characters. */
function isObsText(code: number): boolean {
  return code >= 0x80 && code <= 0xff;
}

/** `qdtext = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text`. */
function isQdtext(code: number): boolean {
  if (code === HTAB || code === SP) return true;
  if (code === 0x21) return true;
  if (code >= 0x23 && code <= 0x5b) return true;
  if (code >= 0x5d && code <= 0x7e) return true;
  return isObsText(code);
}

/** What `quoted-pair` may escape: `HTAB / SP / VCHAR / obs-text`. */
function isQuotedPairTail(code: number): boolean {
  if (code === HTAB || code === SP) return true;
  if (code >= 0x21 && code <= 0x7e) return true;
  return isObsText(code);
}

/** Index of the first character that is not `SP` or `HTAB`, from `index`. */
function skipOws(value: string, index: number): number {
  let i = index;
  for (let code = value.charCodeAt(i); code === SP || code === HTAB; code = value.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

/** Index just past a `token` at `index`, or `index` itself when there is none. */
function scanToken(value: string, index: number): number {
  let i = index;
  while (i < value.length && TCHAR.has(value[i] ?? "")) i += 1;
  return i;
}

/** Index just past a `quoted-string` at `index`, or -1 when it is not one. */
function scanQuotedString(value: string, index: number): number {
  if (value[index] !== '"') return -1;
  let i = index + 1;
  while (i < value.length) {
    const char = value[i];
    if (char === '"') return i + 1;
    if (char === "\\") {
      if (i + 1 >= value.length || !isQuotedPairTail(value.charCodeAt(i + 1))) return -1;
      i += 2;
      continue;
    }
    if (!isQdtext(value.charCodeAt(i))) return -1;
    i += 1;
  }
  // Ran out before the closing quote.
  return -1;
}

/**
 * Index just past a `parameter` at `index`, or -1 when it is not one.
 *
 * `parameter = parameter-name "=" parameter-value`, with no OWS around
 * the `=`: RFC 9110 §5.6.6 puts the whitespace allowance in
 * `parameters`, before the `;`, and nowhere else.
 */
function scanParameter(value: string, index: number): number {
  const nameEnd = scanToken(value, index);
  if (nameEnd === index) return -1;
  if (value[nameEnd] !== "=") return -1;
  const valueStart = nameEnd + 1;
  if (value[valueStart] === '"') return scanQuotedString(value, valueStart);
  const valueEnd = scanToken(value, valueStart);
  return valueEnd === valueStart ? -1 : valueEnd;
}

/**
 * OpenAPI `media-range`: the RFC 9110 §12.5.1 production
 * (e.g. `"application/json"`, `"text/*"`, the fully-wild range, and
 * `"text/html;charset=utf-8"`).
 *
 * **A `*` type over a named subtype passes**, though it denotes
 * nothing. The production writes the wildcards as three alternatives
 * and the third, `( type "/" subtype )`, subsumes the other two: `*`
 * is a `tchar`, so `*` is a `token`, so the grammar derives a `*` type
 * over any subtype. Section 12.5.1 gives a meaning to `*` over `*` and
 * to a named type over `*`, and none to the third shape, which in
 * practice is a typo. Rejecting it would be this validator overruling
 * the specification it cites, and the grammar is the contract the
 * format name points at; a name that means "the media-range
 * production" cannot quietly mean "the useful part of it".
 *
 * Parameters are the whole of the rest of the production, and two
 * things about them surprise people:
 *
 * - **An empty parameter is legal.** `parameters` is
 *   `*( OWS ";" OWS [ parameter ] )`, with the parameter optional, so
 *   `"text/html;"` and `"text/html;;charset=utf-8"` both parse. That is
 *   the grammar being deliberately tolerant of a sender that emits a
 *   stray separator, and reading it any other way would reject what
 *   RFC 9110 blesses.
 * - **Whitespace is allowed only around the `;`.** `"text/html ;
 *   charset=utf-8"` is fine and `"text/html; charset = utf-8"` is not,
 *   because `parameter` puts no OWS around its `=`. A trailing space
 *   after the last parameter is not part of the production either.
 *
 * A quality value is not treated specially: `"text/html;q=0.8"` passes
 * as a media-range carrying a parameter named `q`. RFC 9110 separates
 * `weight` from `media-range` in the `Accept` grammar, above the level
 * this format names, so there is nothing here to tell them apart with.
 *
 * One boundary worth stating: `obs-text` is the octet range
 * `%x80-FF`, and a JSON string holds Unicode code points. A quoted
 * parameter value containing a code point above `U+00FF` is rejected,
 * because no single octet spells it.
 *
 * @public
 */
export function validateMediaRange(value: string): boolean {
  const typeEnd = scanToken(value, 0);
  if (typeEnd === 0 || value[typeEnd] !== "/") return false;
  const subtypeStart = typeEnd + 1;
  const subtypeEnd = scanToken(value, subtypeStart);
  if (subtypeEnd === subtypeStart) return false;

  let index = subtypeEnd;
  while (index < value.length) {
    const semicolon = skipOws(value, index);
    // OWS is legal only as the run before a ";", so anything else here
    // (including a trailing space) ends the parse.
    if (value[semicolon] !== ";") return false;
    index = skipOws(value, semicolon + 1);
    // The parameter is optional, so the next ";" or the end of the
    // string is a complete iteration.
    if (index < value.length && value[index] !== ";") {
      const parameterEnd = scanParameter(value, index);
      if (parameterEnd === -1) return false;
      index = parameterEnd;
    }
  }

  return true;
}
