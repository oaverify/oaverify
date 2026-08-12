/**
 * Reporting a `format` oaverify does not validate.
 *
 * Advice, never a defect: OAS says support for a format is optional and
 * a tool may fall back to `type` alone, so a vendor format is legal.
 * What the author loses is the constraint they wrote.
 *
 * A pass of its own because `check` fixes format support at
 * `builtInFormats`, so the answer depends on the document alone.
 * Exposing the format map as an option would make it depend on the
 * caller too, which is additive when someone wants it (#635).
 *
 * @packageDocumentation
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";
import { builtInFormats } from "@oaverify/internal-formats";
import { walkDocumentSchemas } from "@oaverify/internal-validator/internals";

/**
 * What `check` validates. `createValidator` merges `builtInFormats`
 * under the caller's map and `check` passes no map, so the built-ins
 * are almost the whole set.
 *
 * `regex` is the exception and has to be named here. It is asserted,
 * with u-mode strictness, but it is not a `builtInFormats` key:
 * `@oaverify/core/schema` registers it inside `createDeps` so it routes
 * through the same compile path as the `pattern` keyword. Deriving this
 * set from the map alone would report the one format the compiler adds
 * as a format nothing validates.
 */
export const KNOWN_FORMATS: ReadonlySet<string> = new Set([
  ...Object.keys(builtInFormats),
  "regex",
]);

/**
 * Every name in the OpenAPI Format Registry
 * (https://spec.openapis.org/registry/format/), which is what 3.1 and
 * 3.2 point `format` at. The 3.0 data-type formats are a subset.
 *
 * The whole registry rather than the 3.0 shortlist, because the
 * difference this pass exists to draw is between a name the spec gave
 * the author and a name the author invented. Reporting `int8` or
 * `http-date` in the same words as `twiml` buries exactly that, and
 * did until the list was widened.
 *
 * Names `builtInFormats` covers are filtered out below rather than
 * omitted here, so this stays a copy of the registry and the two sets
 * can overlap freely as validators are added.
 */
const OAS_REGISTRY = new Set([
  "base64url",
  "binary",
  "byte",
  "char",
  "commonmark",
  "date",
  "date-time",
  "date-time-local",
  "decimal",
  "decimal128",
  "double",
  "double-int",
  "duration",
  "email",
  "float",
  "hostname",
  "html",
  "http-date",
  "idn-email",
  "idn-hostname",
  "int8",
  "int16",
  "int32",
  "int64",
  "ipv4",
  "ipv4-cidr",
  "ipv6",
  "ipv6-cidr",
  "iri",
  "iri-reference",
  "json-pointer",
  "language",
  "media-range",
  "password",
  "regex",
  "relative-json-pointer",
  "sf-binary",
  "sf-boolean",
  "sf-decimal",
  "sf-integer",
  "sf-string",
  "sf-token",
  "time",
  "time-local",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "unixtime",
  "uri",
  "uri-reference",
  "uri-template",
  "uuid",
]);

/**
 * Registry names no validator can honestly assert, mapped to why, so
 * their absence reads as permanent rather than pending.
 *
 * A `Map` rather than an object literal, and one structure rather than a
 * membership set beside a reason table. The key is a `format` read
 * straight off the document, so an object literal would resolve
 * `constructor` or `toString` through `Object.prototype` and emit
 * `[native code]` into the report and into SARIF. Keeping the reason
 * next to the name is also what stops the two drifting: a name here
 * cannot lose its reason, and a reason cannot outlive its name.
 *
 * `float` and `double` are the pair worth reading. They are not the same
 * case, and saying so wrongly is what sent the v7 review looking for a
 * bug. Every JSON number really is an IEEE 754 double, so `double`
 * asserts nothing. float32 is a strictly narrower set and
 * `Math.fround(n) === n` decides membership exactly, so a validator
 * *can* assert `float`. It should not: a producer holding the float32
 * nearest 3.14 serializes it as `3.14`, the shortest string that
 * round-trips, and `Math.fround(3.14) !== 3.14`. Asserting would reject
 * most real float values, `0.1` and `0.2` among them. See the module
 * note in `@oaverify/internal-formats`'s `numeric.ts`.
 */
const NOT_ASSERTABLE = new Map<string, string>([
  [
    "float",
    "asserting it would reject values a producer legitimately sent " +
      '(a float32 holding 3.14 serializes as "3.14", which is not itself float32-representable)',
  ],
  ["double", "no validator can assert it over JSON"],
  // The registry defines it as any sequence of octets, and the validator
  // already handles it as an opaque-body bypass rather than a constraint.
  ["binary", "no validator can assert it over JSON"],
  // A display hint.
  ["password", "no validator can assert it over JSON"],
  // Every string is arguably well-formed under both.
  ["commonmark", "no validator can assert it over JSON"],
  ["html", "no validator can assert it over JSON"],
]);

/** A `format` name with no validator behind it. */
export interface FormatIssue {
  code: "format-not-validated";
  /** RFC 6901 pointer to the first `format` keyword naming it. */
  pointer: string;
  message: string;
}

/**
 * Walk a resolved document and report every `format` name `check` cannot
 * validate, once per distinct name: the remedy is per name, and a
 * document using one vendor format in forty places has one problem.
 *
 * @param document - A resolved OpenAPI document.
 * @param known - Format names that do validate.
 *
 * @public
 */
export function checkDocumentFormats(
  document: OpenAPIDocument,
  known: ReadonlySet<string>,
): FormatIssue[] {
  const firstSeen = new Map<string, { pointer: string; count: number }>();

  walkDocumentSchemas(document, {
    onSchemaNode: (schema, pointer) => {
      const format = schema["format"];
      if (typeof format !== "string" || known.has(format)) return;
      const seen = firstSeen.get(format);
      if (seen === undefined) {
        firstSeen.set(format, { pointer: `${pointer}/format`, count: 1 });
        return;
      }
      seen.count += 1;
    },
  });

  return [...firstSeen].map(([format, { pointer, count }]) => {
    const where = count > 1 ? ` (${count} positions use it)` : "";
    // What varies per occurrence: which name, and why it has no
    // validator. The rest of what a reader needs (that this is legal,
    // and the two remedies) is the same sentence for every one of these
    // findings, so it lives on the rule descriptor instead (#773).
    //
    // The tool's name is gone from all three, and the "OpenAPI defines
    // it / we do not assert it" contrast survives without it: the
    // contrast is between the specification and this run's coverage,
    // and "not validated here" says the second half.
    let origin: string;
    const reason = NOT_ASSERTABLE.get(format);
    if (reason !== undefined) {
      origin = `OpenAPI defines "${format}", and ${reason}`;
    } else if (OAS_REGISTRY.has(format)) {
      origin = `OpenAPI defines "${format}", and it is not asserted here yet`;
    } else {
      origin = `"${format}" is not a validated format`;
    }
    return {
      code: "format-not-validated" as const,
      pointer,
      message: `${origin}, so values are checked against "type" alone${where}.`,
    };
  });
}
