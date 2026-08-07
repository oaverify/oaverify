/**
 * The base64 string formats: `byte` and `base64url`.
 *
 * Both are alphabet-and-padding checks over RFC 4648. Neither decodes,
 * because the question a format answers is whether the string is
 * well-formed encoding, and what the bytes mean is the schema's
 * business rather than the format's.
 *
 * @packageDocumentation
 */

// RFC 4648 section 4: quads from the standard alphabet, with a final
// group of 2 or 3 characters padded out to 4.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Whitespace carries no data in base64, so the permissive reading strips
// it before testing the alphabet. This is what admits MIME's 76-column
// wrapping (RFC 2045) without a second pattern.
//
// The set is WHATWG "ASCII whitespace", which is exactly what
// `forgiving-base64 decode` (`atob`) skips. That is the line worth
// holding: these five characters are the ones a value can carry and
// still decode. Vertical tab, U+00A0, U+2028 and U+FEFF are not in it,
// and a value carrying one does not decode, so accepting it would turn
// a clean 400 into a failure further downstream. A future widening to
// `\s` would cross that line silently.
const BASE64_WHITESPACE_RE = /[\t\n\f\r ]+/g;

// RFC 4648 section 5: the URL-safe alphabet, with padding optional.
// The unpadded tail is what a 2- or 3-character final group looks like
// when "=" is omitted.
const BASE64URL_RE = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/;

/**
 * OpenAPI `byte`: base64-encoded data, per RFC 4648 section 4.
 *
 * Whitespace is stripped before the alphabet and padding are checked, so
 * MIME's 76-column wrapping (RFC 2045) passes. Whitespace carries no
 * data in base64 and a wrapped value decodes to the same bytes, so
 * rejecting it fails a request over a formatting choice while catching
 * nothing. Padding is still required after stripping, so the length is
 * always a multiple of 4, and a wrong alphabet still fails, which is
 * what this format is useful for.
 *
 * For the strict reading, which is what the registry's plain citation of
 * RFC 4648 says literally, register {@link validateByteRfc4648} in its
 * place: `formats: { byte: validateByteRfc4648 }`.
 *
 * The string is not decoded, so this says the alphabet and the padding
 * are well-formed and nothing about the bytes inside it. RFC 4648
 * section 3.5 additionally requires the unused bits of a partial final
 * group to be zero, and this does not check that: `"cE6="` passes and
 * does not survive a decode and re-encode. Rejecting it would mean
 * decoding every value on the hot path to catch a case no encoder
 * produces, so the leniency is deliberate, and it is what Ajv and the
 * rest of the ecosystem do.
 *
 * @public
 */
export function validateByte(value: string): boolean {
  // The strict test first: when it passes there was no whitespace, so
  // the strip would have been the identity. That keeps the common
  // unwrapped value on exactly the work it did before, and states the
  // relationship between the two exports in code.
  return BASE64_RE.test(value) || BASE64_RE.test(value.replace(BASE64_WHITESPACE_RE, ""));
}

/**
 * OpenAPI `byte`, read strictly: RFC 4648 section 4 with no whitespace.
 *
 * RFC 4648 admits whitespace only where the specification referring to
 * it says so, and the OpenAPI Format Registry cites 4648 plainly, so
 * this is the literal reading. It is not the built-in because a false
 * reject costs a working integration while a false accept costs a check
 * the format never promised, and MIME-wrapped base64 is real traffic
 * that decodes correctly.
 *
 * Register it where the strict reading is what you want:
 *
 * ```ts
 * createValidator(doc, { formats: { byte: validateByteRfc4648 } });
 * ```
 *
 * @public
 */
export function validateByteRfc4648(value: string): boolean {
  return BASE64_RE.test(value);
}

/**
 * OpenAPI `base64url`: URL-safe base64, per RFC 4648 section 5.
 *
 * The `-` and `_` alphabet, and padding is optional. Unpadded is the
 * common spelling (a JWT segment carries no `=`), and RFC 4648 makes
 * padding a property of the referring specification rather than of the
 * encoding, so accepting both is the reading that does not reject
 * correct input. A value mixing the two alphabets fails, which is the
 * mistake this format is most useful for catching.
 *
 * @public
 */
export function validateBase64Url(value: string): boolean {
  return BASE64URL_RE.test(value);
}
