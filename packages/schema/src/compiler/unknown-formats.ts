/**
 * Refusing to compile a `format` nothing can enforce.
 *
 * Opt-in through `unknownFormats: "error"`. Off, an unregistered format
 * asserts nothing and reports nothing, which is correct per JSON Schema
 * and is how a constraint the author wrote can go silently unenforced.
 *
 * @packageDocumentation
 */

import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { KeywordDefinition } from "../keywords/types.js";
import { FORMAT_ASSERTION_VOCAB } from "../keywords/vocabulary-uris.js";
import { walkSubschemas } from "../subschema-positions.js";

/**
 * Throw if the schema names a `format` with no validator behind it.
 *
 * Silent unless the dialect asserts `format`: under the annotation-only
 * vocabulary nothing is enforced by design, so there is nothing for a
 * missing validator to have cost.
 *
 * @param formats - Registered format names. Only the keys are read, so
 *   a name registered as `false` (asserting nothing on purpose) counts
 *   as registered: the caller made a decision about it, which is what
 *   this option is asking whether anyone did.
 *
 * @throws Error naming every unregistered format, sorted, at most once
 *   each. Reported together rather than one per compile so a caller
 *   turning this on for the first time sees the whole list.
 */
export function assertFormatsRegistered(
  schema: SchemaOrBoolean,
  byKeyword: ReadonlyMap<string, KeywordDefinition>,
  formats: ReadonlyMap<string, unknown>,
  label: string | undefined,
  resolveRef?: (ref: string) => unknown,
): void {
  if (byKeyword.get("format")?.vocabulary !== FORMAT_ASSERTION_VOCAB) return;

  const missing = new Set<string>();
  walkSubschemas(
    schema,
    (node) => {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const format = (node as Record<string, unknown>)["format"];
      if (typeof format === "string" && !formats.has(format)) missing.add(format);
    },
    // Same resolver the lint walk takes, so a format inside a component
    // reached only by `$ref` is seen. A ref this cannot follow costs
    // coverage of that subtree, never a false positive.
    resolveRef === undefined
      ? undefined
      : {
          resolveRef: (ref: string) => {
            try {
              return resolveRef(ref) as SchemaOrBoolean | undefined;
            } catch {
              return undefined;
            }
          },
        },
  );

  if (missing.size === 0) return;
  const names = [...missing].sort();
  const where = label === undefined ? "" : `${label}: `;
  throw new Error(
    `${where}no validator registered for format ${names.map((n) => `"${n}"`).join(", ")}. ` +
      `unknownFormats: "error" is set, so a format nothing can enforce is a compile ` +
      `failure. Register a validator through the formats option, or register ` +
      `\`() => true\` to keep the name as an annotation.`,
  );
}
