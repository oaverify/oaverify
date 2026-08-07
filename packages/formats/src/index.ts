import type { FormatDefinition } from "@oaverify/internal-core";

export { validateBase64Url, validateByte, validateByteRfc4648 } from "./base64.js";
export {
  validateDate,
  validateDateTime,
  validateDateTimeLocal,
  validateDuration,
  validateTime,
  validateTimeLocal,
} from "./date.js";
export { validateEmail, validateIdnEmail } from "./email.js";
export { validateHostname, validateIdnHostname } from "./hostname.js";
export { validateHttpDate } from "./http-date.js";
export { validateIpv4, validateIpv4Cidr, validateIpv6, validateIpv6Cidr } from "./ip.js";
export { validateLanguage } from "./language.js";
export { validateMediaRange } from "./media-range.js";
export { validateChar, validateRegex, validateUuid } from "./misc.js";
export {
  validateDoubleInt,
  validateInt16,
  validateInt32,
  validateInt64,
  validateInt8,
  validateUint16,
  validateUint32,
  validateUint64,
  validateUint8,
  validateUnixtime,
} from "./numeric.js";
export {
  validateIri,
  validateIriReference,
  validateJsonPointer,
  validateRelativeJsonPointer,
  validateUri,
  validateUriReference,
  validateUriTemplate,
} from "./uri.js";

import { validateBase64Url, validateByte } from "./base64.js";
import {
  validateDate,
  validateDateTime,
  validateDateTimeLocal,
  validateDuration,
  validateTime,
  validateTimeLocal,
} from "./date.js";
import { validateEmail, validateIdnEmail } from "./email.js";
import { validateHostname, validateIdnHostname } from "./hostname.js";
import { validateHttpDate } from "./http-date.js";
import { validateIpv4, validateIpv4Cidr, validateIpv6, validateIpv6Cidr } from "./ip.js";
import { validateLanguage } from "./language.js";
// Note: validateRegex is intentionally not imported into builtInFormats.
// @oaverify/core/schema auto-registers a `regex` format that shares the
// pattern-keyword compile path (and the regexCompiler hook). The standalone
// validateRegex export still lives in ./misc.ts as a u-mode utility.
import { validateMediaRange } from "./media-range.js";
import { validateChar, validateUuid } from "./misc.js";
import {
  validateDoubleInt,
  validateInt16,
  validateInt32,
  validateInt64,
  validateInt8,
  validateUint16,
  validateUint32,
  validateUint64,
  validateUint8,
  validateUnixtime,
} from "./numeric.js";
import {
  validateIri,
  validateIriReference,
  validateJsonPointer,
  validateRelativeJsonPointer,
  validateUri,
  validateUriReference,
  validateUriTemplate,
} from "./uri.js";

/**
 * Every built-in format validator, keyed by its format name.
 *
 * Covers every format JSON Schema 2020-12 names, and every format in
 * the OpenAPI Format Registry that is assertable and cheap to assert.
 * `@oaverify/check`'s format pass reports the registry names left over
 * so a document using one is told the name is an annotation rather
 * than a constraint; docs/strictness.md carries the boundary.
 *
 * String formats are bare functions, per {@link FormatDefinition}'s
 * shorthand. The numeric formats declare `type: "number"`, because a
 * format's JSON type is a property of the format.
 *
 * `createValidator` registers all of these for an OpenAPI document.
 * Direct `compileSchema` callers pass them through the `formats`
 * option, which is also how a caller replaces one:
 *
 * ```ts
 * compileSchema(schema, {
 *   dialect: oas30Dialect,
 *   formats: { ...builtInFormats, int64: false },
 * });
 * ```
 *
 * `regex` is intentionally absent: `@oaverify/core/schema` registers
 * its own `regex` validator inside the compiler dependencies so it
 * routes through the same compiler as the `pattern` keyword and honors
 * the `regexCompiler` option. Override by setting
 * `formats: { regex: yourFn, ... }` if you want a different policy.
 *
 * `float` and `double` are absent too, and that is a decision rather
 * than a gap; the reasoning is in `numeric.ts`.
 *
 * @public
 */
export const builtInFormats: Record<string, FormatDefinition> = {
  "date-time": validateDateTime,
  date: validateDate,
  time: validateTime,
  "date-time-local": validateDateTimeLocal,
  "time-local": validateTimeLocal,
  "http-date": validateHttpDate,
  duration: validateDuration,
  email: validateEmail,
  "idn-email": validateIdnEmail,
  hostname: validateHostname,
  "idn-hostname": validateIdnHostname,
  ipv4: validateIpv4,
  "ipv4-cidr": validateIpv4Cidr,
  ipv6: validateIpv6,
  "ipv6-cidr": validateIpv6Cidr,
  uri: validateUri,
  "uri-reference": validateUriReference,
  iri: validateIri,
  "iri-reference": validateIriReference,
  "uri-template": validateUriTemplate,
  "json-pointer": validateJsonPointer,
  "relative-json-pointer": validateRelativeJsonPointer,
  uuid: validateUuid,
  byte: validateByte,
  base64url: validateBase64Url,
  char: validateChar,
  language: validateLanguage,
  "media-range": validateMediaRange,
  int8: { type: "number", validate: validateInt8 },
  int16: { type: "number", validate: validateInt16 },
  int32: { type: "number", validate: validateInt32 },
  int64: { type: "number", validate: validateInt64 },
  uint8: { type: "number", validate: validateUint8 },
  uint16: { type: "number", validate: validateUint16 },
  uint32: { type: "number", validate: validateUint32 },
  uint64: { type: "number", validate: validateUint64 },
  "double-int": { type: "number", validate: validateDoubleInt },
  unixtime: { type: "number", validate: validateUnixtime },
};

/**
 * An Ajv-shaped format definition: `{ type, validate }`.
 *
 * `type` says which JSON type the validator expects, and oaverify acts
 * on it: it is the same question {@link FormatDefinition}'s full form
 * asks. A definition with no `type` is a string format, matching Ajv's
 * own default.
 *
 * Ajv's adjacent `async` / `compare` fields aren't used by oaverify and
 * are ignored by {@link fromAjvFormats}.
 *
 * @public
 */
export interface AjvFormatDef {
  type?: "string" | "number";
  validate: (value: unknown) => boolean;
}

/**
 * Convert a map of Ajv-shaped format definitions to the shape
 * oaverify's `formats` option expects. One-way; pass the result
 * straight into `createValidator` / `compileSchema`.
 *
 * Main audience: migrants from `ajv-formats` or
 * `express-openapi-validator`'s `formats` option, who already have a
 * `Record<string, { type, validate }>` lying around and would
 * otherwise hand-roll the conversion on every project.
 *
 * `type` is carried through, so a `type: "number"` definition arrives
 * as a numeric format and is called with numbers. Before numeric
 * formats existed this function dropped such an entry into the string
 * map, where it was called with strings.
 *
 * Non-boolean truthy returns from the source validator are coerced
 * to `true` (some adapter packages in the wild return `1` / strings).
 *
 * @public
 *
 * @example
 * ```ts
 * import { createValidator } from "@oaverify/core";
 * import { fromAjvFormats } from "@oaverify/core/formats";
 *
 * const validator = createValidator(spec, {
 *   formats: fromAjvFormats(myAjvFormats),
 * });
 * ```
 */
export function fromAjvFormats(
  defs: Record<string, AjvFormatDef>,
): Record<string, FormatDefinition> {
  return Object.fromEntries(
    Object.entries(defs).map(([name, def]): [string, FormatDefinition] => [
      name,
      def.type === "number"
        ? { type: "number", validate: (value: number) => Boolean(def.validate(value)) }
        : { type: "string", validate: (value: string) => Boolean(def.validate(value)) },
    ]),
  );
}
