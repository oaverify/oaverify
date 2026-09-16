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
 * The registry's other numeric names (`decimal`, `decimal128`) are
 * assertable and not yet implemented; see #696.
 *
 * The widths split two ways. `int8` through `int32`, `uint8` through
 * `uint32` and `double-int` are exact: every value in range survives a
 * JSON round trip, so the validator says everything the format name
 * claims. `int64` and `uint64` are bounded by what a JSON number can
 * carry rather than by the width, and each says so in its own TSDoc.
 *
 * @packageDocumentation
 */

/**
 * An integer inside a fixed inclusive range.
 *
 * The six exact widths differ only in their two bounds, so they say so by
 * passing them rather than by each restating the rule. Six copies of
 * `Number.isInteger(value) && value >= LO && value <= HI` is six places for
 * one bound to be typed wrong, and a wrong bound looks exactly like a right
 * one.
 *
 * The bounds stay written out at each call site rather than being derived
 * from the width, because `2 ** 63` is not exact and a derivation that is
 * right for four widths and wrong for two is worse than a literal.
 * `packages/formats/test/formats.test.ts` derives them and asserts the match
 * for the widths where the derivation is exact.
 */
function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * OpenAPI `int8`: a signed 8-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateInt8(value: number): boolean {
  return inRange(value, -128, 127);
}

/**
 * OpenAPI `int16`: a signed 16-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateInt16(value: number): boolean {
  return inRange(value, -32768, 32767);
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
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateInt32(value: number): boolean {
  return inRange(value, -2147483648, 2147483647);
}

/**
 * OpenAPI `uint8`: an unsigned 8-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateUint8(value: number): boolean {
  return inRange(value, 0, 255);
}

/**
 * OpenAPI `uint16`: an unsigned 16-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateUint16(value: number): boolean {
  return inRange(value, 0, 65535);
}

/**
 * OpenAPI `uint32`: an unsigned 32-bit integer.
 *
 * Exact; see the module note on the exact widths.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateUint32(value: number): boolean {
  return inRange(value, 0, 4294967295);
}

/**
 * OpenAPI `int64`: a signed 64-bit integer, restricted to JavaScript's
 * safe-integer range.
 *
 * Accepted values are `-(2^53 - 1)` through `2^53 - 1`. Some larger
 * integers remain exact, but distinct wire values can parse to the same
 * number: `9007199254740992` and `9007199254740993` both become `2^53`.
 * A validator receiving that number cannot recover which value was sent.
 * Producers should declare a string schema and send large integers as
 * strings. Callers who accept the precision risk can register
 * `int64: false` and keep the name as an annotation.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @specBoundary narrows
 * A legal int64 outside `-(2^53 - 1)` through `2^53 - 1` is rejected.
 * The registry defines the full signed 64-bit range; this accepts safe
 * integers. Beyond that range, distinct integers can parse to the same
 * number, so the original wire value cannot always be recovered.
 * @public
 */
export function validateInt64(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * OpenAPI `uint64`: an unsigned 64-bit integer, restricted to nonnegative
 * JavaScript safe integers.
 *
 * **Partial in the same way {@link validateInt64} is**, and for the
 * same reason: the ceiling is `2^53 - 1` rather than `2^64 - 1`,
 * because distinct wire integers above that range can parse to the same
 * number. The floor is 0, which is the whole difference from
 * `int64`.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @specBoundary narrows
 * A legal uint64 above `2^53 - 1` is rejected, where the registry's
 * `uint64` is the full unsigned 64-bit range, for the reason
 * `validateInt64` gives.
 * @public
 */
export function validateUint64(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * OpenAPI `double-int`: an integer representable in an IEEE 754 double
 * with no loss.
 *
 * Complete rather than partial. A JSON number has already been read
 * into a double by the time it arrives, so an integral one is exactly
 * representable and integrality is the whole of the question.
 *
 * That is why the bound is not the safe-integer range, which asks
 * whether *n and n + 1* are both representable. `2^53` is a double and
 * is a `double-int`; it passes even though the original wire value
 * cannot always be recovered after parsing.
 *
 * {@link validateInt64}'s ceiling does not carry over, and the reason
 * is worth stating because the arithmetic looks identical. A literal
 * too fine for a double is rounded before either validator sees it.
 * Under `int64` that literal was a legal int64, so the ceiling exists
 * to refuse vouching for the substitute it arrived as. Under
 * `double-int` a literal that survives rounding was outside the format
 * to begin with, so what gets accepted was never valid rather than
 * valid and silently altered: `9007199254740993` is accepted, as
 * `2^53`. `packages/formats/test/formats.test.ts` pins that.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateDoubleInt(value: number): boolean {
  return Number.isInteger(value);
}

/**
 * OpenAPI `unixtime`: seconds since 1970-01-01T00:00:00Z, per
 * POSIX.1-2024.
 *
 * Integral and within JavaScript's safe-integer range, using the same
 * bound and precision policy as {@link validateInt64}. Negative values
 * pass, naming an instant before the epoch.
 *
 * **This asserts less than most formats do.** POSIX puts no upper bound
 * on the epoch count, so beyond integrality there is nothing left to
 * check; a validator cannot tell `1700000000` from a quantity of
 * apples. The name is worth registering anyway, because a
 * `format: unixtime` on a fractional or precision-lost number is a real
 * defect and the alternative is asserting nothing at all.
 *
 * The registry gives `unixtime` two base types, `number` and `string`.
 * A format constrains one JSON type here (see `FormatDefinition`), and
 * this is the number one: a string-valued `unixtime` is not asserted.
 * The string spelling exists for producers escaping the 2^53 ceiling,
 * which is exactly the range this cannot vouch for either way.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @specBoundary narrows
 * A legal unixtime above `2^53 - 1` is rejected, where POSIX puts no
 * upper bound on the epoch count. Same argument as `validateInt64`:
 * beyond the safe-integer range, distinct epoch counts can parse to the
 * same number, so their original values cannot always be recovered.
 * @specBoundary under-asserts
 * A string-valued `unixtime` is not asserted at all. The registry gives
 * the format two base types, `number` and `string`; a format constrains
 * one JSON type here (see `FormatDefinition`), and this is the number
 * one.
 * @public
 */
export function validateUnixtime(value: number): boolean {
  return Number.isSafeInteger(value);
}
