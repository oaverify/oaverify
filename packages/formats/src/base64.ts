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
// group of 2 or 3 characters padded out to 4. Whitespace is not
// accepted; see validateByte.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// RFC 4648 section 5: the URL-safe alphabet, with padding optional.
// The unpadded tail is what a 2- or 3-character final group looks like
// when "=" is omitted.
const BASE64URL_RE = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/;

/**
 * OpenAPI `byte`: base64-encoded data, per RFC 4648 section 4.
 *
 * Padding is required, so the length is always a multiple of 4. Line
 * breaks and other whitespace are rejected: RFC 4648 admits them only
 * where the specification referring to it says so, and OpenAPI's
 * registry entry cites 4648 plainly. MIME's line-wrapped variant
 * (RFC 2045) therefore fails here. A producer that wraps at 76
 * columns should either stop wrapping or register `byte: false` and
 * keep the name as an annotation.
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
