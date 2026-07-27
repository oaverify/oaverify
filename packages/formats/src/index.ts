export { validateDate, validateDateTime, validateDuration, validateTime } from "./date.js";
export { validateEmail, validateIdnEmail } from "./email.js";
export { validateHostname, validateIdnHostname } from "./hostname.js";
export { validateIpv4, validateIpv6 } from "./ip.js";
export { validateRegex, validateUuid } from "./misc.js";
export {
  validateIri,
  validateIriReference,
  validateJsonPointer,
  validateRelativeJsonPointer,
  validateUri,
  validateUriReference,
  validateUriTemplate,
} from "./uri.js";

import { validateDate, validateDateTime, validateDuration, validateTime } from "./date.js";
import { validateEmail, validateIdnEmail } from "./email.js";
import { validateHostname, validateIdnHostname } from "./hostname.js";
import { validateIpv4, validateIpv6 } from "./ip.js";
// Note: validateRegex is intentionally not imported into builtInFormats.
// @oaverify/internal-schema's createDeps auto-registers a `regex` format that shares the
// pattern-keyword compile path (and the regexCompiler hook). The standalone
// validateRegex export still lives in ./misc.ts as a u-mode utility.
import { validateUuid } from "./misc.js";
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
 * Every built-in format validator, keyed by its JSON Schema format name.
 * Hand to {@link @oaverify/internal-schema!compileSchema#formats | compileSchema's formats
 * option} to get out-of-the-box format validation.
 *
 * `regex` is intentionally absent: `@oaverify/internal-schema` registers its own
 * `regex` validator inside `createDeps` so it routes through the same
 * compiler as the `pattern` keyword (and honors the `regexCompiler`
 * option). Override by setting `formats: { regex: yourFn, ... }` if you
 * want a different policy.
 *
 * @public
 *
 * @example
 * ```ts
 * compileSchema(mySchema, { dialect: jsonSchemaDialect, formats: builtInFormats });
 * ```
 */
export const builtInFormats: Record<string, (value: string) => boolean> = {
  "date-time": validateDateTime,
  date: validateDate,
  time: validateTime,
  duration: validateDuration,
  email: validateEmail,
  "idn-email": validateIdnEmail,
  hostname: validateHostname,
  "idn-hostname": validateIdnHostname,
  ipv4: validateIpv4,
  ipv6: validateIpv6,
  uri: validateUri,
  "uri-reference": validateUriReference,
  iri: validateIri,
  "iri-reference": validateIriReference,
  "uri-template": validateUriTemplate,
  "json-pointer": validateJsonPointer,
  "relative-json-pointer": validateRelativeJsonPointer,
  uuid: validateUuid,
};

/**
 * An Ajv-shaped format definition: `{ type, validate }`. oav's
 * `format` keyword only applies to string values (per JSON Schema
 * 2020-12 §6.3), so `type` is carried for shape compatibility but
 * not acted on; non-string values skip format validation regardless.
 *
 * Ajv's adjacent `async` / `compare` fields aren't used by oav and
 * are ignored by {@link fromAjvFormats}.
 *
 * @public
 */
export interface AjvFormatDef {
  type?: "string" | "number";
  validate: (value: unknown) => boolean;
}

/**
 * Convert a map of Ajv-shaped format definitions to the plain
 * predicate shape oav's `formats` option expects. One-way; pass the
 * result straight into `createValidator` / `compileSchema`.
 *
 * Main audience: migrants from `ajv-formats` or
 * `express-openapi-validator`'s `formats` option, who already have a
 * `Record<string, { type, validate }>` lying around and would
 * otherwise hand-roll the three-line conversion on every project.
 *
 * Non-boolean truthy returns from the source validator are coerced
 * to `true` (some adapter packages in the wild return `1` / strings).
 *
 * @public
 *
 * @example
 * ```ts
 * import { createValidator } from "oaverify";
 * import { fromAjvFormats } from "oaverify/formats";
 *
 * const validator = createValidator(spec, {
 *   formats: fromAjvFormats(myAjvFormats),
 * });
 * ```
 */
export function fromAjvFormats(
  defs: Record<string, AjvFormatDef>,
): Record<string, (value: string) => boolean> {
  return Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [
      name,
      (value: string) => Boolean(def.validate(value)),
    ]),
  );
}
