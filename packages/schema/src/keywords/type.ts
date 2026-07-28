import { NAMES, quoteString } from "../codegen/index.js";
import {
  buildTypeMismatchCondition,
  JSON_SCHEMA_TYPE_NAMES,
  suggestTypeName,
} from "./type-predicates.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB } from "./vocabulary-uris.js";

/**
 * The JSON Schema 2020-12 `type` keyword. Accepts a single type name or an
 * array of names; a value validates if its JSON type matches at least one.
 *
 * @public
 */
export const typeKeyword: KeywordDefinition = {
  keyword: "type",
  vocabulary: CORE_VALIDATION_VOCAB,
  validateKeywordValue: (value) => checkTypeNames(value),
  compile(ctx: KeywordCompileContext): void {
    const expected = parseTypeNames(ctx.schema);
    const condition = buildTypeMismatchCondition(ctx.data, expected);
    ctx.gen.if(condition, () => {
      const expectedLit = JSON.stringify(expected);
      const actualExpr = `${NAMES.DEPS}.typeOf(${ctx.data})`;
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("type"),
          JSON.stringify(`must be ${formatTypeList(expected)}`),
          `{ expected: ${expectedLit}, actual: ${actualExpr} }`,
        ),
      );
    });
  },
};

/**
 * Validate `type`'s value before it reaches codegen.
 *
 * `typePredicate` returns `"false"` for a name it does not know, so an
 * unrecognised one used to compile into a validator that rejects every
 * payload. Nothing satisfies it, the failure surfaces at runtime on
 * production traffic, and the message (`must be Boolean`) points at the
 * payload rather than at the spec that is actually wrong. No author
 * means that, so it is a compile error.
 */
export function checkTypeNames(
  value: unknown,
  legal: readonly string[] = JSON_SCHEMA_TYPE_NAMES,
): string | undefined {
  const names = Array.isArray(value) ? value : [value];
  if (names.length === 0) return "requires at least one type name; got an empty array";
  for (const name of names) {
    if (typeof name !== "string") {
      return `requires a type name or array of type names; got ${describe(name)}`;
    }
    if (!legal.includes(name)) {
      return (
        `has unknown type name ${JSON.stringify(name)}; ` +
        `expected one of ${legal.map((t) => JSON.stringify(t)).join(", ")}.` +
        suggestTypeName(name, legal)
      );
    }
  }
  return undefined;
}

/**
 * Throwing counterpart of {@link checkTypeNames}, for the compile path.
 * Both go through one check so the pre-pass and codegen cannot drift on
 * what `type` accepts.
 */
function parseTypeNames(value: unknown): string[] {
  const reason = checkTypeNames(value);
  if (reason !== undefined) throw new Error(`keyword "type" ${reason}`);
  return (Array.isArray(value) ? value : [value]) as string[];
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return `number ${String(value)}`;
  return typeof value;
}

function formatTypeList(types: string[]): string {
  if (types.length === 1) return types[0] ?? "";
  if (types.length === 2) return `${types[0]} or ${types[1]}`;
  return types.slice(0, -1).join(", ") + `, or ${types.at(-1)}`;
}
