/**
 * The numeric format validators from the OpenAPI Format Registry:
 * the fixed-width integers, and the two whose range JSON cannot carry.
 *
 * Every fixed-width integer the registry names is here. `float` and
 * `double` are not, and are not assertable: every JSON number is
 * already an IEEE 754 double, so `double` asserts nothing, and `float`
 * read as `Math.fround(n) === n` rejects values a producer
 * legitimately sent (`0.1` is not representable as a 32-bit float). A
 * format that rejects correct payloads is worse than one that asserts
 * nothing.
 *
 * The registry's other numeric names (`decimal`, `decimal128`,
 * `unixtime`) are assertable and not yet implemented; see #696.
 *
 * The widths split two ways. `int8` through `int32` and `uint8`
 * through `uint32` are exact: every value in range survives a JSON
 * round trip, so the validator says everything the format name claims.
 * `int64`, `uint64` and `double-int` are bounded by what a JSON number
 * can carry rather than by the width, and each says so in its own
 * TSDoc.
 *
 * @packageDocumentation
 */

/**
 * OpenAPI `int8`: a signed 8-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @public
 */
export function validateInt8(value: number): boolean {
  return Number.isInteger(value) && value >= -128 && value <= 127;
}

/**
 * OpenAPI `int16`: a signed 16-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @public
 */
export function validateInt16(value: number): boolean {
  return Number.isInteger(value) && value >= -32768 && value <= 32767;
}

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
 * OpenAPI `uint8`: an unsigned 8-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @public
 */
export function validateUint8(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * OpenAPI `uint16`: an unsigned 16-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @public
 */
export function validateUint16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * OpenAPI `uint32`: an unsigned 32-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @public
 */
export function validateUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 4294967295;
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

/**
 * OpenAPI `uint64`: an unsigned 64-bit integer, asserted over the range
 * a JSON number can carry.
 *
 * **Partial in the same way {@link validateInt64} is**, and for the
 * same reason: the ceiling is `2^53 - 1` rather than `2^64 - 1`,
 * because a JSON number above the safe range is provably not the value
 * on the wire. The floor is 0, which is the whole difference from
 * `int64`.
 *
 * @public
 */
export function validateUint64(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * OpenAPI `double-int`: an integer representable in an IEEE 754 double
 * with no loss.
 *
 * The one width whose bound is exactly what JavaScript can express, so
 * unlike `int64` this validator is complete rather than partial: the
 * safe-integer range *is* the format's range. It shares
 * {@link validateInt64}'s implementation and means something different
 * by it.
 *
 * @public
 */
export function validateDoubleInt(value: number): boolean {
  return Number.isSafeInteger(value);
}
