/**
 * What a caller registers under the `format` keyword.
 *
 * One registry, whatever JSON type the format applies to. `date-time`
 * constrains strings and `int32` constrains numbers, and both are
 * formats, so both are configured through the same option and turned
 * off the same way.
 *
 * Here rather than in `@oaverify/internal-formats` because the compiler
 * reads the shape and the format package supplies it, and core is what
 * they share.
 *
 * @packageDocumentation
 */

/**
 * A format validator, as a caller writes it.
 *
 * Four spellings, in the order you will meet them:
 *
 * - `{ type: "string", validate }` and `{ type: "number", validate }`
 *   are the full form. `type` says which JSON type the format
 *   constrains, and `validate` sees only values of that type.
 * - A bare function is shorthand for a string format. It is what the
 *   `formats` option has always taken, so existing configuration keeps
 *   working.
 * - `false` registers the name and asserts nothing, which is how you
 *   turn a built-in off.
 *
 * A bare function is **always** a string format, including when it
 * overrides a built-in that constrains numbers. Inferring the type from
 * the name would make `formats: { int64: (n) => n < 100 }` and
 * `formats: { "x-mine": (n) => n < 100 }` mean different things by way
 * of a table the caller cannot see, and be silent when it guessed
 * wrong. Write the full form to constrain numbers.
 *
 * @public
 *
 * @example Registering, and turning one off
 * ```ts
 * createValidator(spec, {
 *   formats: {
 *     "x-internal-id": (value) => value.startsWith("id_"),
 *     "x-basis-points": { type: "number", validate: (n) => n >= 0 && n <= 10000 },
 *     int64: false, // keep the name, assert nothing
 *   },
 * });
 * ```
 */
export type FormatDefinition =
  | ((value: string) => boolean)
  | { readonly type: "string"; readonly validate: (value: string) => boolean }
  | { readonly type: "number"; readonly validate: (value: number) => boolean }
  | false;

/**
 * A {@link FormatDefinition} with its spellings collapsed: the JSON type
 * it constrains, and the predicate.
 *
 * What the compiler stores and what generated code calls. `false`
 * normalizes to `null` rather than to a member of this type, so
 * "registered, asserts nothing" stays distinguishable from "not
 * registered" without a third field.
 *
 * @public
 */
export interface NormalizedFormat {
  readonly type: "string" | "number";
  readonly validate: (value: never) => boolean;
}

/**
 * Collapse a {@link FormatDefinition} to its canonical form.
 *
 * @returns The normalized format, or `null` for `false`: registered,
 *   asserting nothing. A caller distinguishing "unregistered" from
 *   "deliberately not asserted" reads `undefined` against `null`.
 *
 * @public
 */
export function normalizeFormat(definition: FormatDefinition): NormalizedFormat | null {
  if (definition === false) return null;
  if (typeof definition === "function") {
    return { type: "string", validate: definition as (value: never) => boolean };
  }
  return {
    type: definition.type,
    validate: definition.validate as (value: never) => boolean,
  };
}
