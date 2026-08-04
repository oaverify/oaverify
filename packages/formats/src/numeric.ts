/**
 * The OpenAPI numeric format validators: `int32`, `int64`.
 *
 * OpenAPI names four numeric formats. Two are assertable and are here.
 * `float` and `double` are not: every JSON number is already an IEEE
 * 754 double, so `double` asserts nothing, and `float` read as
 * `Math.fround(n) === n` rejects values a producer legitimately sent
 * (`0.1` is not representable as a 32-bit float). A format that
 * rejects correct payloads is worse than one that asserts nothing.
 *
 * @packageDocumentation
 */

/**
 * OpenAPI `int32`: a signed 32-bit integer.
 *
 * Exact and complete. Every value in range is representable as a JSON
 * number with no loss, so this validator says everything the format
 * name claims.
 *
 * Non-integer numbers are rejected: `1.5` is a number, so the format
 * applies to it, and an int32 is an integer. Values of other types are
 * not this function's business; the compiler applies it to numbers
 * only, the way a string format applies to strings only.
 *
 * @public
 */
export function validateInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

/**
 * OpenAPI `int64`: a signed 64-bit integer, asserted over the range a
 * JSON number can carry.
 *
 * **This is a partial assertion, and the range is smaller than int64.**
 * Accepted values are the safe integers, `-(2^53 - 1)` through
 * `2^53 - 1`. A JSON number outside that range has already lost
 * precision by the time any JavaScript validator sees it:
 * `JSON.parse("9223372036854775807")` yields `9223372036854775808`, a
 * different number, and nothing downstream can recover the original.
 *
 * A value between `2^53` and `2^63` is therefore rejected rather than
 * accepted. It is a legal int64 and an illegal JSON number, and
 * accepting it would mean vouching for a value that is provably not
 * the one on the wire. Producers of large int64s should send them as
 * strings, which is what the range exists to surface. Callers who
 * disagree register `int64: false` and keep the name as an annotation.
 *
 * @public
 */
export function validateInt64(value: number): boolean {
  return Number.isSafeInteger(value);
}
