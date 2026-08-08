/**
 * The single `type` name parameter deserialization reads off a schema.
 *
 * @packageDocumentation
 */

import type { SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * The type name deserialization should read `schema` as, or `undefined`
 * when it has none it can act on.
 *
 * @remarks
 * Deserialization picks one reading per parameter: split it as an array,
 * assemble it as an object, coerce it as a number or a boolean, or leave
 * the string alone. That needs one name, and JSON Schema 2020-12 allows
 * `type` to be a set.
 *
 * A set naming one type that a query string can carry, ignoring `null`,
 * is unambiguous: `["array","null"]` and `["null","array"]` are the same
 * schema and both read as `array`. Resolving the member rather than
 * taking a position is issue #742, where `["null","array"]` read as
 * `null`, never split on the separator, and rejected every request a
 * nullable array parameter received.
 *
 * `null` is skipped because no query string spells it, so it never
 * competes for a reading.
 *
 * ## Two or more readable members
 *
 * Left as it was: the first name in the array wins, so member order
 * still decides. That is deliberate and it is not a fix left half done.
 *
 * Every reading is total. The object reading turns any string into an
 * object (`"hello"` becomes `{ hello: "" }`), the array reading turns
 * any string into a one-element array, and the scalar reading passes
 * anything through. So for a union of two readable members, whichever
 * reading is chosen, a request the other member would have accepted is
 * rejected, and no ordering avoids that: it only moves which spelling
 * breaks. Making member order irrelevant here means validating against
 * each member's reading and accepting the first that passes, which is a
 * different shape from deserialize-once-then-validate. Tracked
 * separately; see the issue linked from #742.
 *
 * Until then the historical reading stands, so a document that works
 * today keeps working.
 *
 * @param schema - The parameter, item, or property schema to read.
 * @returns The type name to deserialize as, or `undefined`.
 *
 * @example
 * ```ts
 * effectiveType({ type: "array" });            // "array"
 * effectiveType({ type: ["null", "array"] });  // "array"
 * effectiveType({ type: ["number"] });         // "number"
 * effectiveType({ type: ["string", "array"] }); // "string", the first
 * effectiveType({});                            // undefined
 * ```
 *
 * @internal
 */
export function effectiveType(schema: SchemaOrBoolean | undefined): string | undefined {
  if (schema === undefined || typeof schema === "boolean") return undefined;
  const t = schema.type;
  // A single string is nearly every spec, and costs one `typeof`.
  if (typeof t === "string") return t;
  if (!Array.isArray(t)) return undefined;
  let sole: string | undefined;
  let readable = 0;
  let first: string | undefined;
  for (const name of t) {
    if (typeof name !== "string") continue;
    first ??= name;
    if (name === "null") continue;
    readable += 1;
    sole = name;
  }
  return readable === 1 ? sole : first;
}
