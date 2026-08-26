/**
 * Miscellaneous format validators: regex, uuid, char.
 *
 * @packageDocumentation
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * RFC 4122 `uuid`.
 *
 * @see RFC 9562 section 4, https://datatracker.ietf.org/doc/html/rfc9562#section-4
 * @public
 */
export function validateUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * ECMA 262 `regex`: the value must compile as a JavaScript regular
 * expression with the `u` flag (per JSON Schema 2020-12 recommendation).
 *
 * Standalone utility, not wired into `builtInFormats`. The schema
 * compiler registers its own `regex` format inside `createDeps` so the
 * `regexCompiler` hook still reaches it. That one applies the same
 * u-mode rule as this function whenever no compiler is configured, so
 * the two agree by default and diverge only when a caller supplies a
 * compiler with a different policy. Reach for this one to get u-mode
 * strictness regardless of what any compiler is configured to do.
 *
 * @see ECMA-262, the Patterns grammar, https://tc39.es/ecma262/multipage/text-processing.html#sec-patterns
 * @public
 */
export function validateRegex(value: string): boolean {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * OpenAPI `char`: a single character.
 *
 * One Unicode code point, so an astral character such as an emoji
 * passes on its own despite occupying two UTF-16 units. `Array.from`
 * iterates code points, which is the unit a reader means by
 * "character" far more often than `.length`'s UTF-16 units.
 *
 * A combining sequence ("e" followed by U+0301) is two code points and
 * fails. That is the grapheme-cluster reading, which the registry does
 * not ask for, and drawing the line at code points keeps the rule
 * something a caller can predict.
 *
 * @see the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @public
 */
export function validateChar(value: string): boolean {
  return Array.from(value).length === 1;
}
