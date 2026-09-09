/**
 * Refusing to compile a `format` nothing can enforce.
 *
 * Opt-in through `unknownFormats: "error"`. Off, an unregistered format
 * asserts nothing and reports nothing, which is correct per JSON Schema
 * and is how a constraint the author wrote can go silently unenforced.
 *
 * A name registered as `false` counts as registered: asserting nothing
 * on purpose is a decision someone made, and whether anyone made one is
 * the question this option asks.
 *
 * @packageDocumentation
 */

import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { KeywordDefinition } from "../keywords/types.js";
import { FORMAT_ASSERTION_VOCAB } from "../keywords/vocabulary-uris.js";
import { refSiblingIsDiscarded } from "../ref-siblings.js";
import { forEachSubschema } from "../subschema-positions.js";

/**
 * Options for {@link assertFormatsRegistered}.
 *
 * @internal
 */
export interface AssertFormatsRegisteredOptions {
  /**
   * Whether the active dialect discards `$ref` siblings (OAS 3.0).
   *
   * When set, ignored sibling content is skipped the same way codegen
   * skips it, so `unknownFormats: "error"` does not make a discarded
   * `format` fatal.
   */
  refSuppressesSiblings?: boolean;
}

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
 *
 * @internal
 */
export function assertFormatsRegistered(
  schema: SchemaOrBoolean,
  byKeyword: ReadonlyMap<string, KeywordDefinition>,
  formats: ReadonlyMap<string, unknown>,
  label: string | undefined,
  resolveRef?: (ref: string) => unknown,
  options: AssertFormatsRegisteredOptions = {},
): void {
  if (byKeyword.get("format")?.vocabulary !== FORMAT_ASSERTION_VOCAB) return;

  const missing = new Set<string>();
  const walkedRefTargets = new WeakSet<object>();

  const go = (node: SchemaOrBoolean): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const discarded = (key: string): boolean =>
      refSiblingIsDiscarded(obj, key, options.refSuppressesSiblings === true);

    const format = obj["format"];
    if (!discarded("format") && typeof format === "string" && !formats.has(format)) {
      missing.add(format);
    }

    if (resolveRef !== undefined && typeof obj["$ref"] === "string") {
      try {
        const target = resolveRef(obj["$ref"]) as SchemaOrBoolean | undefined;
        if (target !== undefined && !(typeof target === "object" && walkedRefTargets.has(target))) {
          if (typeof target === "object" && target !== null) walkedRefTargets.add(target);
          go(target);
        }
      } catch {
        // A ref this cannot follow costs coverage of that subtree, never
        // a false positive.
      }
    }

    forEachSubschema(obj, (sub, key) => {
      if (discarded(key)) return;
      go(sub);
    });
  };

  go(schema);

  if (missing.size === 0) return;
  const names = [...missing].sort();
  const where = label === undefined ? "" : `${label}: `;
  throw new Error(
    `${where}no validator registered for format ${names.map((n) => `"${n}"`).join(", ")}. ` +
      `unknownFormats: "error" is set, so a format nothing can enforce is a compile ` +
      `failure. Register a validator through the formats option, or register ` +
      `\`false\` to keep the name as an annotation.`,
  );
}
