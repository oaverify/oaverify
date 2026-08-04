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
 * What `check` validates. `createValidator` merges `builtInFormats` under
 * the caller's map and `check` passes no map, so this is the whole set.
 */
export const KNOWN_FORMATS: ReadonlySet<string> = new Set(Object.keys(builtInFormats));

/**
 * Formats OpenAPI names but oaverify does not assert. Every real 3.0
 * document uses several, so folding them in with vendor names would
 * report `int32` in the same words as `twiml` and bury the difference:
 * one is a name the author invented, the other is a name the spec gave
 * them and a range nothing enforces.
 *
 * `date`, `date-time` and `byte`'s base64 are OAS formats too, and are
 * absent here because `builtInFormats` covers them.
 */
const OAS_DEFINED = new Set(["int32", "int64", "float", "double", "byte", "binary", "password"]);

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
    const origin = OAS_DEFINED.has(format)
      ? `OpenAPI defines "${format}" but oaverify does not assert it`
      : `"${format}" is not a format oaverify validates`;
    return {
      code: "format-not-validated" as const,
      pointer,
      message:
        `${origin}, so values are checked against "type" alone${where}. This is ` +
        `legal: support for a format is optional and a tool may fall back to ` +
        `"type" for one it does not recognise. Register a validator through the ` +
        `formats option to enforce it, or read this as confirmation the name is ` +
        `an annotation.`,
    };
  });
}
