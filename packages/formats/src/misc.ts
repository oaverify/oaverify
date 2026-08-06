/**
 * Miscellaneous format validators: regex, uuid.
 *
 * @packageDocumentation
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * RFC 4122 `uuid`.
 *
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
