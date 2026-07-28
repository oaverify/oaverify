/**
 * Emit a JS expression that is `true` iff `dataExpr` has the given
 * JSON-Schema type name (`"null" | "boolean" | "string" | "array" |
 * "object" | "number" | "integer"`). Unknown type names yield `"false"`.
 *
 * Shared by the 2020-12 `type` keyword and the OAS 3.0 `type` keyword so
 * the two dialects cannot drift on type-classification semantics.
 *
 * @internal
 */
export function typePredicate(dataExpr: string, typeName: string): string {
  switch (typeName) {
    case "null":
      return `${dataExpr} === null`;
    case "boolean":
      return `typeof ${dataExpr} === "boolean"`;
    case "string":
      return `typeof ${dataExpr} === "string"`;
    case "array":
      return `Array.isArray(${dataExpr})`;
    case "object":
      return `(typeof ${dataExpr} === "object" && ${dataExpr} !== null && !Array.isArray(${dataExpr}))`;
    case "number":
      return `(typeof ${dataExpr} === "number" && Number.isFinite(${dataExpr}))`;
    case "integer":
      // `Number.isInteger` already returns false for NaN and +/-Infinity,
      // so a sibling `Number.isFinite` check would be redundant. The
      // `typeof` keeps the call off non-number values.
      return `(typeof ${dataExpr} === "number" && Number.isInteger(${dataExpr}))`;
    default:
      return "false";
  }
}

/**
 * Emit a JS expression that is `true` iff `dataExpr`'s JSON-Schema type is
 * NOT in `expected`. Used by both the 2020-12 and OAS 3.0 `type` keywords
 * to gate error emission.
 *
 * @internal
 */
export function buildTypeMismatchCondition(dataExpr: string, expected: string[]): string {
  const predicates = expected.map((t) => typePredicate(dataExpr, t));
  return `!(${predicates.join(" || ")})`;
}

/**
 * The seven type names JSON Schema 2020-12 defines. Kept next to
 * {@link typePredicate} so the set and the switch it drives cannot
 * drift.
 *
 * @internal
 */
export const JSON_SCHEMA_TYPE_NAMES = [
  "null",
  "boolean",
  "object",
  "array",
  "string",
  "number",
  "integer",
] as const;

/**
 * OpenAPI 3.0's type set: the 2020-12 names minus `null`. 3.0 spells
 * nullability as a sibling `nullable: true` rather than a type.
 *
 * @internal
 */
export const OAS30_TYPE_NAMES = [
  "boolean",
  "object",
  "array",
  "string",
  "number",
  "integer",
] as const;

/** Levenshtein distance, capped: returns `max + 1` once it is clearly over. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * `' Did you mean "boolean"?'` for a near-miss, or `""` when nothing is
 * close enough to guess at.
 *
 * Case folding first is what catches the dominant real-world shape:
 * `type: Boolean` / `String` / `Integer`, written from Java, C#, or
 * TypeScript habits. The distance pass then picks up ordinary
 * misspellings (`stirng`, `bolean`).
 *
 * @internal
 */
export function suggestTypeName(name: string, legal: readonly string[]): string {
  const lower = name.toLowerCase();
  if (legal.includes(lower)) return ` Did you mean "${lower}"?`;
  let best: string | undefined;
  let bestAt = 2; // only guess within two edits
  for (const candidate of legal) {
    const d = distance(lower, candidate, bestAt);
    if (d <= bestAt) {
      bestAt = d;
      best = candidate;
    }
  }
  return best === undefined ? "" : ` Did you mean "${best}"?`;
}
